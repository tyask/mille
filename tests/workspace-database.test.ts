import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test, { type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql, seedSql } from "../scripts/db/sql";
import type { DatabaseConfiguration } from "../lib/server/database/environment";
import type { InvitationPreview, JoinedWorkspace, Workspace, WorkspaceInvitation, WorkspaceState } from "../lib/shared/workspaces";

const configuration: DatabaseConfiguration = { mode: "hosted", url: "", host: "", environment: "preview", environmentId: "mille-preview" };
const a = { id: "mille-test-user-a", email: "test-a@mille.invalid" };
const b = { id: "mille-test-user-b", email: "test-b@mille.invalid" };
const c = { id: "mille-unit-user-c", email: "unit-c@mille.invalid" };
const d = { id: "mille-unit-user-d", email: "unit-d@mille.invalid" };
type Identity = { id: string; email: string };
type Result<T> = { ok: true; data: T } | { ok: false; status: number; error: string };
function hash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function token(): string { return randomBytes(32).toString("hex"); }

async function fixture(t: TestContext) {
  const database = new PGlite(); t.after(() => database.close());
  await database.exec(migrationSql(configuration, true));
  await database.exec(seedSql(configuration));
  // Additional identities exist only inside these disposable unit databases.
  for (const user of [c, d]) await database.query("INSERT INTO app_users (id,email,name,is_enabled,is_test) VALUES ($1,$2,$1,true,true)", [user.id, user.email]);
  async function command<T>(user: Identity, operation: string, payload: unknown = {}): Promise<Result<T>> {
    const rows = await database.query<{ result: Result<T> }>("SELECT mille_workspace_command($1,$2,$3,$4::jsonb) AS result", [user.id, user.email, operation, JSON.stringify(payload)]);
    return rows.rows[0].result;
  }
  async function success<T>(user: Identity, operation: string, payload: unknown = {}): Promise<T> {
    const result = await command<T>(user, operation, payload);
    if (!result.ok) assert.fail(`${operation}: ${result.status} ${result.error}`);
    return result.data;
  }
  async function failure(user: Identity, operation: string, payload: unknown, status: number) {
    const result = await command(user, operation, payload);
    assert.equal(result.ok, false);
    if (result.ok) assert.fail("Expected a domain error");
    assert.equal(result.status, status);
    assert.equal(typeof result.error, "string");
  }
  async function create(user = a, type = "SHARED", name = "みんなの献立") { return success<Workspace>(user, "create", { type, name }); }
  async function invite(workspaceId: string, recipient = b, inviter = a, raw = token()) {
    const invitation = await success<WorkspaceInvitation>(inviter, "invite", { id: workspaceId, email: recipient.email, tokenHash: hash(raw) });
    return { invitation, raw };
  }
  return { database, command, success, failure, create, invite };
}

test("first concurrent loads create exactly one personal workspace per enabled identity and isolate lists", async t => {
  const { database, success } = await fixture(t);
  const [first, second] = await Promise.all([success<WorkspaceState>(a, "list"), success<WorkspaceState>(a, "list")]);
  assert.equal(first.workspaces.length, 1);
  assert.equal(second.workspaces[0].id, first.workspaces[0].id);
  assert.equal(first.workspaces[0].name, "個人のワークスペース");
  assert.equal(first.workspaces[0].type, "PERSONAL");
  const other = await success<WorkspaceState>(b, "list");
  assert.notEqual(first.workspaces[0].id, other.workspaces[0].id);
  assert.equal((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM workspaces")).rows[0].count, 2);
});

test("names, personal membership and immutable workspace kind are enforced in the database", async t => {
  const { database, create, failure } = await fixture(t);
  await failure(a, "create", { name: " ", type: "SHARED" }, 400);
  await failure(a, "create", { name: "a".repeat(81), type: "PERSONAL" }, 400);
  await failure(a, "create", { name: "OK", type: "OTHER" }, 400);
  const personal = await create(a, "PERSONAL", "  個人用  ");
  assert.equal(personal.name, "個人用");
  await assert.rejects(database.query("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'MEMBER')", [personal.id, b.id]), /only its creator/);
  await assert.rejects(database.query("UPDATE workspace_members SET role = 'MEMBER' WHERE workspace_id = $1", [personal.id]), /only its creator/);
  await assert.rejects(database.query("UPDATE workspaces SET type = 'SHARED' WHERE id = $1", [personal.id]), /immutable/);
  await failure(a, "invite", { id: personal.id, email: b.email, tokenHash: hash(token()) }, 400);
});

test("nonmembers cannot rename, delete or invite, and malformed or disabled identities cannot operate", async t => {
  const { database, create, failure } = await fixture(t);
  const workspace = await create();
  await failure(b, "rename", { id: workspace.id, name: "No" }, 404);
  await failure(b, "delete", { id: workspace.id, confirmationName: workspace.name }, 404);
  await failure(b, "invite", { id: workspace.id, email: c.email, tokenHash: hash(token()) }, 404);
  await failure({ ...a, email: b.email }, "list", {}, 401);
  await database.query("UPDATE app_users SET is_enabled = false WHERE id = $1", [a.id]);
  await failure(a, "list", {}, 401);
  await failure(a, "rename", { id: workspace.id, name: "No" }, 401);
});

test("invite delivery is email-bound, hashes only, seven days, normalized and reissue invalidates the old link", async t => {
  const { database, create, invite, success, failure } = await fixture(t);
  const workspace = await create();
  const first = await invite(workspace.id);
  const stored = (await database.query<{ token_hash: string; expires_at: Date; created_at: Date }>("SELECT token_hash,expires_at,created_at FROM workspace_invitations")).rows[0];
  assert.equal(stored.token_hash, hash(first.raw));
  assert.equal(new Date(stored.expires_at).getTime() - new Date(stored.created_at).getTime(), 7 * 86400_000);
  await failure(c, "previewInvite", { tokenHash: hash(first.raw) }, 403);
  await failure(c, "acceptInvite", { tokenHash: hash(first.raw) }, 403);
  const nextRaw = token();
  const second = await success<WorkspaceInvitation>(a, "invite", { id: workspace.id, email: " TEST-B@MILLE.INVALID ", tokenHash: hash(nextRaw) });
  assert.equal(second.id, first.invitation.id);
  assert.equal(second.email, b.email);
  await failure(b, "acceptInvite", { tokenHash: hash(first.raw) }, 404);
  const preview = await success<InvitationPreview>(b, "previewInvite", { tokenHash: hash(nextRaw) });
  assert.equal(preview.workspaceName, workspace.name);
  assert.equal(preview.email, b.email);
  const list = await success<WorkspaceState>(b, "list");
  assert.equal(list.invitations[0].id, second.id);
  assert.equal(JSON.stringify(list).includes(nextRaw), false);
  assert.equal(JSON.stringify(list).includes(hash(nextRaw)), false);
});

test("shared workspaces admit three or more participants including concurrent invitation acceptance", async t => {
  const { database, create, invite, success, failure } = await fixture(t);
  const workspace = await create();
  const invitations = await Promise.all([invite(workspace.id, b), invite(workspace.id, c), invite(workspace.id, d)]);
  const joined = await Promise.all([b, c, d].map((user, index) => success<JoinedWorkspace>(user, "acceptInvite", { tokenHash: hash(invitations[index].raw) })));
  assert.ok(joined.every(value => value.workspaceId === workspace.id));
  const list = await success<WorkspaceState>(c, "list");
  assert.equal(list.workspaces[0].members.length, 4);
  assert.equal(list.workspaces[0].members.find(user => user.userId === c.id)?.role, "MEMBER");
  assert.equal(list.workspaces[0].pendingInvitations.length, 0);
  assert.equal((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM workspace_members WHERE workspace_id = $1", [workspace.id])).rows[0].count, 4);
  await failure(c, "invite", { id: workspace.id, email: c.email, tokenHash: hash(token()) }, 400);
  await failure(c, "invite", { id: workspace.id, email: b.email, tokenHash: hash(token()) }, 409);
  const renamed = await success<Workspace>(c, "rename", { id: workspace.id, name: "全員で献立" });
  assert.equal(renamed.name, "全員で献立");
});

test("acceptance by invitation id is idempotent without duplicate memberships", async t => {
  const { create, invite, success } = await fixture(t);
  const workspace = await create();
  const issued = await invite(workspace.id);
  const first = await success<JoinedWorkspace>(b, "acceptInviteById", { invitationId: issued.invitation.id });
  const second = await success<JoinedWorkspace>(b, "acceptInvite", { tokenHash: hash(issued.raw) });
  assert.deepEqual(first, second);
  assert.equal((await success<WorkspaceState>(a, "list")).workspaces[0].members.length, 2);
  assert.equal((await success<InvitationPreview>(b, "previewInvite", { tokenHash: hash(issued.raw) })).status, "ACCEPTED");
});

test("expired invitations cannot be previewed or accepted and do not appear in pending lists", async t => {
  const { database, create, invite, success, failure } = await fixture(t);
  const workspace = await create();
  const issued = await invite(workspace.id);
  await database.query("UPDATE workspace_invitations SET expires_at = now() - interval '1 second' WHERE id = $1", [issued.invitation.id]);
  await failure(b, "previewInvite", { tokenHash: hash(issued.raw) }, 410);
  await failure(b, "acceptInviteById", { invitationId: issued.invitation.id }, 410);
  assert.equal((await success<WorkspaceState>(b, "list")).invitations.length, 0);
  assert.equal((await success<WorkspaceState>(a, "list")).workspaces[0].pendingInvitations.length, 0);
});

test("a member can delete with the current exact name and cascade all membership and invitation data", async t => {
  const { database, create, invite, success, failure } = await fixture(t);
  const workspace = await create();
  const issued = await invite(workspace.id);
  await success<JoinedWorkspace>(b, "acceptInviteById", { invitationId: issued.invitation.id });
  await invite(workspace.id, c, b);
  await failure(b, "delete", { id: workspace.id, confirmationName: workspace.name + " " }, 400);
  await success(b, "rename", { id: workspace.id, name: "変更後" });
  await failure(b, "delete", { id: workspace.id, confirmationName: workspace.name }, 400);
  assert.equal(await success(b, "delete", { id: workspace.id, confirmationName: "変更後" }), null);
  for (const table of ["workspace_members", "workspace_invitations"]) {
    assert.equal((await database.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table} WHERE workspace_id = $1`, [workspace.id])).rows[0].count, 0);
  }
  const reset = await success<WorkspaceState>(b, "list");
  assert.equal(reset.workspaces.length, 1);
  assert.equal(reset.workspaces[0].type, "PERSONAL");
  await failure(c, "acceptInviteById", { invitationId: issued.invitation.id }, 404);
});

test("malformed payloads and a production marker cannot bypass input or synthetic identity checks", async t => {
  const { database, create, failure } = await fixture(t);
  const workspace = await create();
  for (const value of [null, [], "invalid"]) await failure(a, "create", value, 400);
  for (const value of [null, 10, {}, ""]) {
    await failure(a, "rename", { id: workspace.id, name: value }, 400);
    await failure(a, "invite", { id: workspace.id, email: value, tokenHash: hash(token()) }, 400);
  }
  await failure(a, "invite", { id: workspace.id, email: b.email, tokenHash: null }, 400);
  await failure(a, "delete", { id: workspace.id }, 400);
  await failure(a, "unknown", {}, 400);
  // Even a previously created fixture is refused if the environment later says production.
  await database.exec("UPDATE mille_environment SET environment = 'production'");
  await failure(a, "list", {}, 401);
});
