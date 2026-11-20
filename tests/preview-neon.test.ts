import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { NeonPreview } from "../scripts/preview/neon";

const config = {
  apiKey: "fake-key",
  projectId: "fake-pr-preview-project",
  parentBranchId: "br-template",
  database: "mille_pr",
  role: "mille_pr_owner",
  maxPrBranches: 2,
};
const parent = {
  id: config.parentBranchId, project_id: config.projectId, name: "mille-pr-template",
  default: false, protected: false, current_state: "ready",
};
const child = {
  id: "br-pr-8", parent_id: parent.id, project_id: config.projectId, name: "mille-pr-8",
  default: false, protected: false, init_source: "parent-data", current_state: "ready",
};
const ownership = {
  mille_repository: "tyask/mille", mille_pr: "8", mille_database: config.database, mille_role: config.role,
};
const role = { branch_id: child.id, name: config.role, protected: false };
const database = { branch_id: child.id, name: config.database, owner_name: role.name };
const host = "ep-pr-8.ap-southeast-1.aws.neon.tech";
const uri = `postgresql://${role.name}:fake-password@${host}/${database.name}?sslmode=require`;
const templateHost = "ep-template.ap-southeast-1.aws.neon.tech";
const templateUri = `postgresql://neondb_owner:fake-template-password@${templateHost}/neondb?sslmode=require`;

function mockNeon(t: TestContext, options: {
  existing?: boolean;
  ownership?: Record<string, string>;
  connectionString?: string;
  owner?: string;
  unexpectedTemplateDatabase?: boolean;
  nonemptyTemplateDatabase?: string;
  deleteLocked?: boolean;
} = {}) {
  let branchExists = options.existing ?? false;
  let roleExists = branchExists;
  let databaseExists = branchExists;
  const writes: string[] = [];
  const inspectedDatabases: string[] = [];
  let checks = 0;
  const verifyCurrent = async () => { checks++; };
  t.mock.method(globalThis, "fetch", async (input: string | URL, init: RequestInit) => {
    const url = new URL(input);
    if (url.pathname === "/sql") {
      const headers = new Headers(init.headers);
      const connection = new URL(headers.get("Neon-Connection-String") ?? "");
      if (connection.hostname === templateHost) {
        const name = connection.pathname.slice(1);
        assert.equal(connection.username, "neondb_owner");
        assert.equal(headers.get("Neon-Batch-Read-Only"), "true");
        const { queries } = JSON.parse(String(init.body));
        assert.equal(queries.length, 1);
        assert.ok(queries[0].query.includes("pg_catalog.pg_largeobject_metadata"));
        inspectedDatabases.push(name);
        return Response.json({ results: [{
          fields: [{ name: "database", dataTypeID: 25 }, { name: "role", dataTypeID: 25 }, { name: "empty", dataTypeID: 16 }],
          rows: [[name, "neondb_owner", options.nonemptyTemplateDatabase === name ? "f" : "t"]],
        }] });
      }
      assert.equal(connection.href, uri);
      const { query } = JSON.parse(String(init.body));
      if (query.startsWith("SELECT project")) {
        const fields = ["project", "environment", "environment_id"].map(name => ({ name, dataTypeID: 25 }));
        return Response.json({ fields, rows: [["tyask/mille", "preview", "mille-pr-8"]] });
      }
      assert.ok(query.includes("'mille-pr-8'"));
      writes.push(query.includes("mille_seed") ? "seed" : "migrate");
      return Response.json({ fields: [], rows: [] });
    }
    assert.equal(url.origin, "https://console.neon.tech");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer fake-key");
    const prefix = `/api/v2/projects/${config.projectId}`;
    assert.ok(url.pathname.startsWith(prefix));
    const path = url.pathname.slice(prefix.length);
    const childPath = `/branches/${child.id}`;
    const parentPath = `/branches/${parent.id}`;
    const operation = { operations: [] };
    if (init.method === "POST") {
      writes.push(path);
      const body = JSON.parse(String(init.body));
      if (path === "/branches") {
        assert.equal(branchExists, false);
        assert.deepEqual(body.branch, { name: child.name, parent_id: parent.id, init_source: "parent-data" });
        assert.deepEqual(body.annotation_value, ownership);
        branchExists = true;
        return Response.json({ branch: child, ...operation }, { status: 201 });
      }
      if (path === `${childPath}/roles`) {
        assert.equal(roleExists, false);
        assert.deepEqual(body.role, { name: role.name });
        roleExists = true;
        return Response.json({ role, ...operation }, { status: 201 });
      }
      if (path === `${childPath}/databases`) {
        assert.equal(databaseExists, false);
        assert.deepEqual(body.database, { name: database.name, owner_name: role.name });
        databaseExists = true;
        return Response.json({ database, ...operation }, { status: 201 });
      }
    } else if (init.method === "DELETE" && path === childPath) {
      if (options.deleteLocked) return new Response(null, { status: 423 });
      writes.push(`DELETE ${path}`);
      branchExists = false;
      return Response.json({
        branch: child,
        operations: [{ id: "delete-op", branch_id: child.id, project_id: config.projectId, status: "skipped" }],
      });
    } else if (init.method === "GET") {
      if (!path) return Response.json({ project: { id: config.projectId, name: "mille-preview" } });
      if (path === parentPath) return Response.json({ branch: parent });
      if (path === `${parentPath}/roles`) {
        return Response.json({ roles: [{ branch_id: parent.id, name: "neondb_owner", protected: false }] });
      }
      if (path === `${parentPath}/databases`) {
        const template = { branch_id: parent.id, name: "neondb", owner_name: "neondb_owner" };
        const databases = options.unexpectedTemplateDatabase ? [template, { ...template, name: "other" }] : [template];
        return Response.json({ databases });
      }
      if (path === `${parentPath}/endpoints`) {
        return Response.json({ endpoints: [{
          id: "ep-template", host: templateHost, project_id: config.projectId, branch_id: parent.id, type: "read_write", disabled: false,
        }] });
      }
      if (path === "/branches") {
        return url.searchParams.has("cursor")
          ? Response.json({ branches: branchExists ? [child] : [] })
          : Response.json({ branches: [parent], pagination: { next: "opaque cursor" } });
      }
      if (path === childPath) {
        if (!branchExists) return new Response(null, { status: 404 });
        return Response.json({ branch: child, annotation: { object: { id: child.id }, value: options.ownership ?? ownership } });
      }
      if (path === `${childPath}/roles`) return Response.json({ roles: roleExists ? [role] : [] });
      if (path === `${childPath}/databases`) {
        return Response.json({ databases: databaseExists ? [{ ...database, owner_name: options.owner ?? role.name }] : [] });
      }
      if (path === `${childPath}/endpoints`) {
        return Response.json({ endpoints: [{ id: "ep-pr-8", host, project_id: config.projectId, branch_id: child.id, type: "read_write", disabled: false }] });
      }
      if (path === "/connection_uri") {
        if (url.searchParams.get("branch_id") === parent.id) {
          assert.deepEqual(Object.fromEntries(url.searchParams), {
            branch_id: parent.id, endpoint_id: "ep-template", database_name: "neondb", role_name: "neondb_owner", pooled: "false",
          });
          return Response.json({ uri: templateUri });
        }
        assert.deepEqual(Object.fromEntries(url.searchParams), {
          branch_id: child.id, endpoint_id: "ep-pr-8", database_name: database.name, role_name: role.name, pooled: "false",
        });
        return Response.json({ uri: options.connectionString ?? uri });
      }
    }
    assert.fail(`Unexpected test request ${init.method} ${path}`);
  });
  return { writes, inspectedDatabases, checks: () => checks, verifyCurrent };
}

test("Neon の PR 専用 DB を作成し、同じ PR の更新では既存資源を再利用する", async t => {
  const fixture = mockNeon(t);
  const service = new NeonPreview(config);
  const expected = { connectionString: uri, expectedHost: host, expectedDatabase: database.name };
  assert.deepEqual(await service.ensure(8, fixture.verifyCurrent), expected);
  assert.deepEqual(await service.ensure(8, fixture.verifyCurrent), expected);
  assert.deepEqual(fixture.writes, [
    "/branches", "/branches/br-pr-8/roles", "/branches/br-pr-8/databases", "migrate", "seed", "migrate", "seed",
  ]);
  assert.deepEqual(fixture.inspectedDatabases, ["neondb", "postgres", "template1"]);
  assert.equal(fixture.checks(), 5);
  await service.remove(8, fixture.verifyCurrent);
  await service.remove(8, fixture.verifyCurrent);
  assert.equal(fixture.writes.at(-1), "DELETE /branches/br-pr-8");
  assert.equal(fixture.checks(), 6);
});

test("余分な DB や利用者オブジェクトがあるテンプレートは分岐元にしない", async t => {
  const service = new NeonPreview(config);
  const extra = mockNeon(t, { unexpectedTemplateDatabase: true });
  await assert.rejects(service.ensure(8), /テンプレートの DB/);
  assert.deepEqual(extra.inspectedDatabases, []);
  assert.deepEqual(extra.writes, []);
  t.mock.restoreAll();
  const nonempty = mockNeon(t, { nonemptyTemplateDatabase: "postgres" });
  await assert.rejects(service.ensure(8), /テンプレートが空/);
  assert.deepEqual(nonempty.inspectedDatabases, ["neondb", "postgres"]);
  assert.deepEqual(nonempty.writes, []);
});

test("同名でも Neon の所有情報が別 PR のブランチは更新・削除しない", async t => {
  const fixture = mockNeon(t, { existing: true, ownership: { ...ownership, mille_pr: "9" } });
  const service = new NeonPreview(config);
  await assert.rejects(service.ensure(8, fixture.verifyCurrent), /所有情報/);
  await assert.rejects(service.remove(8, fixture.verifyCurrent), /所有情報/);
  assert.deepEqual(fixture.writes, []);
});

test("既存 DB の所有ロールと接続 URI のホストをそれぞれ照合する", async t => {
  const fixture = mockNeon(t, { existing: true, owner: "different_owner" });
  await assert.rejects(new NeonPreview(config).ensure(8), /専用 DB/);
  assert.deepEqual(fixture.writes, []);
  t.mock.restoreAll();
  const foreign = mockNeon(t, { existing: true, connectionString: uri.replace(host, "ep-foreign.neon.tech") });
  await assert.rejects(new NeonPreview(config).ensure(8), /接続先/);
  assert.deepEqual(foreign.writes, []);
});

test("PR の状態が変わった場合は Neon への作成・削除を中止する", async t => {
  const fixture = mockNeon(t);
  const service = new NeonPreview(config);
  const stale = async () => { throw new Error("PR changed"); };
  await assert.rejects(service.ensure(8, stale), /PR changed/);
  assert.deepEqual(fixture.writes, []);
  t.mock.restoreAll();
  const existing = mockNeon(t, { existing: true });
  await assert.rejects(service.remove(8, stale), /PR changed/);
  assert.deepEqual(existing.writes, []);
});


test("Neon の削除を再試行する前に PR の再オープンを確認する", async t => {
  const fixture = mockNeon(t, { existing: true, deleteLocked: true });
  let checks = 0;
  await assert.rejects(new NeonPreview(config).remove(8, async () => {
    if (++checks > 1) throw new Error("PR reopened");
  }), /PR reopened/);
  assert.equal(checks, 2);
  assert.deepEqual(fixture.writes, []);
});
