import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { DatabaseRow, Query } from "../lib/server/database/client";
import { hostedDatabaseConfiguration } from "../lib/server/database/environment";
import { migrationSql, registerUserSql, repositoryMigrationSources } from "../scripts/db/sql";
import { identifyStandingDatabase, prepareStandingDatabase } from "../scripts/preview/standing-database";

const projectId = "billowing-cherry-59956184";
const branchId = "br-dark-rain-a1cc9tfa";
const endpointId = "ep-bitter-wind-a1atj6vn";
const host = `${endpointId}.ap-southeast-1.aws.neon.tech`;
const expected = { projectId, branchId, endpointId, host };
const apiKey = "fixture-neon-key";
const uri = `postgresql://neondb_owner:fixture-secret@${host}/neondb?sslmode=require&channel_binding=require`;
const endpoints = { endpoints: [{ id: endpointId, project_id: projectId, branch_id: branchId,
  type: "read_write", disabled: false, host }] };
const branch = { branch: { id: branchId, project_id: projectId, parent_id: null, name: "main", default: true,
  current_state: "ready", pending_state: null, protected: false } };
const configuration = hostedDatabaseConfiguration("preview", host, "mille-preview", { MILLE_PREVIEW_DATABASE_URL: uri });
const projectPath = `/api/v2/projects/${projectId}`;
const branchPath = `${projectPath}/branches/${branchId}`;
const endpointsPath = `${branchPath}/endpoints`;
const uriPath = `${projectPath}/connection_uri`;

function providerFixture(overrides: Map<string, unknown> = new Map()) {
  const values = new Map<string, unknown>([
    [projectPath, { project: { id: projectId, name: "mille-preview", org_id: "org-twilight-grass-67941976" } }],
    [branchPath, branch], [endpointsPath, endpoints],
    [`${branchPath}/databases`, { databases: [{ id: 42166654, branch_id: branchId, name: "neondb", owner_name: "neondb_owner" }] }],
    [uriPath, { uri }], ...overrides,
  ]);
  const called: string[] = [];
  const request: typeof fetch = async (input, init) => {
    assert.ok(input instanceof URL);
    assert.equal(input.origin, "https://console.neon.tech");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.body, undefined);
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${apiKey}`);
    called.push(input.pathname);
    if (input.pathname === uriPath) assert.deepEqual(Object.fromEntries(input.searchParams), {
      branch_id: branchId, endpoint_id: endpointId, database_name: "neondb", role_name: "neondb_owner", pooled: "false",
    });
    assert.ok(values.has(input.pathname));
    return Response.json(values.get(input.pathname));
  };
  return { request, called, values };
}

async function fixtureDatabase(t: TestContext) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(migrationSql(configuration, true, repositoryMigrationSources().slice(0, 2)));
  await db.exec(registerUserSql(configuration, "test-existing-user", "existing@example.invalid", "Existing"));
  const query: Query = async <Row extends DatabaseRow>(sql: string, parameters?: unknown[]) =>
    (await db.query<Row>(sql, parameters)).rows;
  return { db, query };
}

test("常設 DB の識別は対象組織・既定 root・所有 DB・唯一の RW endpoint を GET し接続情報に触れない", async () => {
  const { request, called } = providerFixture();
  assert.deepEqual(await identifyStandingDatabase(apiKey, request), expected);
  assert.deepEqual(called.sort(), [projectPath, branchPath, endpointsPath, `${branchPath}/databases`].sort());
  const drifted = providerFixture(new Map<string, unknown>([[branchPath, { branch: { ...branch.branch, default: false } }]]));
  await assert.rejects(identifyStandingDatabase(apiKey, drifted.request), /ブランチ/);
  const duplicate = providerFixture(new Map<string, unknown>([[endpointsPath,
    { endpoints: [...endpoints.endpoints, { ...endpoints.endpoints[0], id: "ep-other" }] }]]));
  await assert.rejects(identifyStandingDatabase(apiKey, duplicate.request), /エンドポイント/);
});

test("照合済み常設と違う URI または SQL 設定の注入を資格情報を伏せて拒否する", async () => {
  for (const value of [uri.replace(host, "ep-other.ap-southeast-1.aws.neon.tech"), `${uri}&options=-csearch_path%3Dother`,
    uri.replace("sslmode=require", "sslmode=disable"), uri.replace("neondb_owner", "other_user")]) {
    const { request } = providerFixture(new Map([[uriPath, { uri: value }]]));
    await assert.rejects(prepareStandingDatabase(apiKey, expected, { request, query: async () => assert.fail("SQL started") }),
      (error: Error) => error.message.includes("接続先の照合") && !error.message.includes("fixture-secret"));
  }
});

test("001・002 と利用者を保持し、未適用の003〜006を既存ランナーで適用して後続実行は読み取りになる", async t => {
  const { request } = providerFixture();
  const { query } = await fixtureDatabase(t);
  const history = () => query("SELECT * FROM schema_migrations ORDER BY name");
  const users = () => query("SELECT * FROM app_users ORDER BY id");
  const before = await history(), existing = await users();
  let writes = 0, exactChecks = 0;
  const counted: Query = async <Row extends DatabaseRow>(sql: string, params?: unknown[]) => {
    if (!sql.startsWith("SELECT")) writes++;
    return query<Row>(sql, params);
  };
  const readOnly = () => prepareStandingDatabase(apiKey, expected, { request, query: counted, allowInitialMigrations: false });
  await assert.rejects(readOnly, /既存 DB の所有と移行履歴の照合/);
  assert.equal(writes, 0);
  const prepare = () => prepareStandingDatabase(apiKey, expected, { request, query: counted,
    verifyCurrent: async () => { exactChecks++; } });
  const result = await prepare();
  assert.equal(result.environment, "preview");
  assert.equal(result.environmentId, "mille-preview");
  assert.equal(result.url === uri, true);
  assert.equal(writes, 1);
  assert.equal(exactChecks, 2);
  const after = await history();
  assert.deepEqual(after.slice(0, 2), before);
  assert.deepEqual(after.slice(2).map(item => item.name), [
    "003_meals.sql", "004_meal_api.sql", "005_meal_plans.sql", "006_meal_suggestions.sql",
  ]);
  assert.deepEqual(await users(), existing);
  await readOnly();
  assert.deepEqual(await history(), after);
  assert.equal(writes, 1);
});

test("接続先の途中変更と、移行直前の 002 履歴の消失をそれぞれ検出する", async t => {
  const { db, query } = await fixtureDatabase(t);
  const provider = providerFixture();
  let rechecks = 0;
  const drifted: Query = async <Row extends DatabaseRow>(sql: string, params?: unknown[]) => {
    if (sql.includes("public.schema_migrations")) provider.values.set(endpointsPath,
      { endpoints: [{ ...endpoints.endpoints[0], disabled: true }] });
    return query<Row>(sql, params);
  };
  await assert.rejects(prepareStandingDatabase(apiKey, expected, { request: provider.request, query: drifted }), /移行前/);
  provider.values.set(endpointsPath, endpoints);
  await assert.rejects(prepareStandingDatabase(apiKey, expected, { request: provider.request, query,
    verifyCurrent: async () => {
      if (++rechecks === 1) await db.query("DELETE FROM schema_migrations WHERE name = '002_workspaces.sql'");
    } }), /承認済み移行の適用/);
  assert.deepEqual(await query("SELECT to_regclass('public.meals') AS meals"), [{ meals: null }]);
  assert.deepEqual(await query("SELECT name FROM schema_migrations ORDER BY name"), [{ name: "001_auth.sql" }]);
});
