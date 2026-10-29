import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AppUser } from "../lib/shared/types";
import type { Query } from "../lib/server/database/client";
import { createWorkspaceRepository, DomainError, type WorkspaceRepository } from "../lib/server/workspaces";
import { assertWorkspaceSameOrigin, handleWorkspaceApi, readWorkspaceJson, type WorkspaceApiDependencies } from "../lib/server/workspace-http";
import { deleteWorkspaceSchema, invitationInputSchema, workspaceInputSchema } from "../lib/shared/workspace-schemas";

const user: AppUser = { id: "user-a", email: "member@example.test", name: "メンバー", imageUrl: null, isEnabled: true, isTest: false };
const state = { workspaces: [], invitations: [] };

function queryFixture(result: unknown = { ok: true, data: state }) {
  const calls: { text: string; parameters: unknown[] }[] = [];
  const query: Query = async <Row>(text: string, parameters: unknown[] = []) => {
    calls.push({ text, parameters });
    return [{ result }] as Row[];
  };
  return { query, calls };
}

function apiFixture(currentUser: AppUser | null = user): { dependencies: WorkspaceApiDependencies; repository: WorkspaceRepository; reads: { users: number; repositories: number } } {
  const { query } = queryFixture();
  const repository = createWorkspaceRepository(query, user);
  const reads = { users: 0, repositories: 0 };
  return {
    repository, reads,
    dependencies: {
      async getCurrentUser() { reads.users++; return currentUser; },
      async getRepository() { reads.repositories++; return repository; },
    },
  };
}

function request(body?: string, headers: Record<string, string> = {}) {
  return new Request("https://mille.example.test/api/workspaces", {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Origin: "https://mille.example.test", ...headers },
    ...(body === undefined ? {} : { body }),
  });
}

test("workspace commands bind internal identity and pass normalized inputs as parameters", async () => {
  const { query, calls } = queryFixture();
  const repository = createWorkspaceRepository(query, { ...user, email: " MEMBER@EXAMPLE.TEST " });
  await repository.list();
  await repository.create({ name: "  みんなの食卓  ", type: "SHARED" });
  await repository.rename("workspace-id", " 新しい名前 ");
  await repository.delete("workspace-id", " 新しい名前 ");
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.text, "SELECT mille_workspace_command($1,$2,$3,$4::jsonb) AS result");
    assert.deepEqual(call.parameters.slice(0, 2), [user.id, user.email]);
  }
  assert.deepEqual(JSON.parse(String(calls[1].parameters[3])), { name: "みんなの食卓", type: "SHARED" });
  assert.deepEqual(JSON.parse(String(calls[2].parameters[3])), { id: "workspace-id", name: "新しい名前" });
  // Confirmation deliberately preserves whitespace for SQL's exact-name comparison.
  assert.deepEqual(JSON.parse(String(calls[3].parameters[3])), { id: "workspace-id", confirmationName: " 新しい名前 " });
});

test("invitation tokens are cryptographically fresh and only hashes reach the database", async () => {
  const invitation = { id: "invite-id", email: "other@example.test", expiresAt: "2099-01-01T00:00:00Z" };
  const { query, calls } = queryFixture({ ok: true, data: invitation });
  const repository = createWorkspaceRepository(query, user);
  const first = await repository.invite("workspace-id", " OTHER@EXAMPLE.TEST ");
  const second = await repository.invite("workspace-id", "other@example.test");
  assert.match(first.token, /^[a-f0-9]{64}$/);
  assert.notEqual(first.token, second.token);
  assert.deepEqual(first.invitation, invitation);
  const payload = JSON.parse(String(calls[0].parameters[3]));
  assert.deepEqual(payload, { id: "workspace-id", email: "other@example.test", tokenHash: createHash("sha256").update(first.token).digest("hex") });
  assert.equal(JSON.stringify(calls).includes(first.token), false);
  await repository.previewInvite(first.token);
  await repository.acceptInvite(first.token);
  await repository.acceptInviteById("invite-id");
  assert.equal(calls[2].parameters[2], "previewInvite");
  assert.deepEqual(JSON.parse(String(calls[3].parameters[3])), { tokenHash: payload.tokenHash });
  assert.deepEqual(JSON.parse(String(calls[4].parameters[3])), { invitationId: "invite-id" });
});

test("invalid inputs and disabled users cannot execute a workspace command", async () => {
  const { query, calls } = queryFixture();
  const repository = createWorkspaceRepository(query, user);
  for (const name of ["", "  ", "あ".repeat(81)]) {
    await assert.rejects(async () => repository.create({ name, type: "PERSONAL" }));
  }
  await assert.rejects(async () => repository.invite("workspace-id", "invalid"));
  await assert.rejects(async () => repository.acceptInvite("invalid-token"));
  await assert.rejects(async () => repository.previewInvite("a".repeat(63)));
  await assert.rejects(createWorkspaceRepository(query, { ...user, isEnabled: false }).list(), error => error instanceof DomainError && error.status === 401);
  assert.equal(calls.length, 0);
});

test("database expected errors preserve their status while malformed results fail closed", async () => {
  const denied = queryFixture({ ok: false, status: 403, error: "所属していません。" });
  await assert.rejects(createWorkspaceRepository(denied.query, user).list(), error => error instanceof DomainError && error.status === 403 && error.message === "所属していません。");
  for (const response of [null, {}, { ok: "true" }, { ok: false, status: 200, error: "invalid" }, { ok: false, status: 500, error: "SQL details" }]) {
    const fixture = queryFixture(response);
    await assert.rejects(createWorkspaceRepository(fixture.query, user).list(), error => error instanceof Error && !(error instanceof DomainError));
  }
});

test("mutation origins reject missing, cross-origin and forged canonical hosts", () => {
  assert.doesNotThrow(() => assertWorkspaceSameOrigin(request("{}"), {}));
  assert.doesNotThrow(() => assertWorkspaceSameOrigin(request("{}"), { AUTH_URL: "https://mille.example.test" }));
  const missing = new Request("https://mille.example.test/api/workspaces", { method: "POST" });
  const crossOrigin = request("{}", { Origin: "https://evil.example.test" });
  const crossSite = request("{}", { "Sec-Fetch-Site": "cross-site" });
  for (const value of [missing, crossOrigin, crossSite]) {
    assert.throws(() => assertWorkspaceSameOrigin(value, {}), error => error instanceof DomainError && error.status === 403);
  }
  assert.throws(() => assertWorkspaceSameOrigin(request("{}"), { AUTH_URL: "https://other.example.test" }));
  assert.throws(() => assertWorkspaceSameOrigin(request("{}"), { AUTH_URL: "javascript:bad" }));
  assert.throws(() => assertWorkspaceSameOrigin(request("{}"), { AUTH_URL: "https://user:secret@mille.example.test" }));
});

test("JSON parsing normalizes valid input and rejects malformed, oversized and unexpected fields", async () => {
  assert.deepEqual(await readWorkspaceJson(request('{"name":"  共有  ","type":"SHARED"}'), workspaceInputSchema), { name: "共有", type: "SHARED" });
  assert.deepEqual(await readWorkspaceJson(request('{"email":" OTHER@EXAMPLE.TEST "}'), invitationInputSchema), { email: "other@example.test" });
  assert.deepEqual(await readWorkspaceJson(request('{"confirmationName":" 空白を保持 "}'), deleteWorkspaceSchema), { confirmationName: " 空白を保持 " });
  await assert.rejects(readWorkspaceJson(request("{"), workspaceInputSchema), error => error instanceof DomainError && error.status === 400);
  await assert.rejects(readWorkspaceJson(request("{}", { "Content-Type": "text/plain" }), workspaceInputSchema), error => error instanceof DomainError && error.status === 400);
  await assert.rejects(readWorkspaceJson(request("{}", { "Content-Type": "application/json-not-real" }), workspaceInputSchema), error => error instanceof DomainError && error.status === 400);
  await assert.rejects(readWorkspaceJson(request(JSON.stringify({ name: "x".repeat(20_000), type: "PERSONAL" })), workspaceInputSchema), error => error instanceof DomainError && error.status === 413);
  await assert.rejects(readWorkspaceJson(request('{"name":"共有","type":"SHARED","userId":"other-user"}'), workspaceInputSchema));
});

test("workspace API denies anonymous and disabled sessions before opening a repository", async () => {
  for (const currentUser of [null, { ...user, isEnabled: false }]) {
    const fixture = apiFixture(currentUser);
    const response = await handleWorkspaceApi(request(), repository => repository.list(), {}, fixture.dependencies);
    assert.equal(response.status, 401);
    assert.equal(fixture.reads.users, 1);
    assert.equal(fixture.reads.repositories, 0);
    assert.match(response.headers.get("cache-control") ?? "", /private, no-store/);
    assert.equal(response.headers.get("vary"), "Cookie");
  }
});

test("API results and errors have stable private responses and deletion returns an empty 204", async () => {
  const fixture = apiFixture();
  const success = await handleWorkspaceApi(request(), repository => repository.list(), {}, fixture.dependencies);
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), state);
  const deleted = await handleWorkspaceApi(request(), async () => undefined, { status: 204 }, fixture.dependencies);
  assert.equal(deleted.status, 204);
  assert.equal(await deleted.text(), "");
  const forbidden = await handleWorkspaceApi(request(), async () => { throw new DomainError(403, "所属していません。"); }, {}, fixture.dependencies);
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { error: "所属していません。" });
  const failed = await handleWorkspaceApi(request(), async () => { throw new Error("secret-sql-token-details"); }, {}, fixture.dependencies);
  assert.equal(failed.status, 500);
  assert.equal((await failed.text()).includes("secret-sql-token-details"), false);
  const malformed = await handleWorkspaceApi(request("{"), async () => readWorkspaceJson(request("{"), workspaceInputSchema), {}, fixture.dependencies);
  assert.equal(malformed.status, 400);
});
