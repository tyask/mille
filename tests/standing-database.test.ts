import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { DatabaseRow, Query } from "../lib/server/database/client";
import { hostedDatabaseConfiguration } from "../lib/server/database/environment";
import { migrationSql, registerUserSql, repositoryMigrationSources } from "../scripts/db/sql";
import { identifyStandingDatabase, openStandingDatabase } from "../scripts/preview/standing-database";

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
const migrations = repositoryMigrationSources();
const futureMigration = {
  name: `${String(migrations.length + 1).padStart(3, "0")}_fixture.sql`,
  source: "CREATE TABLE standing_fixture (note text NOT NULL); INSERT INTO standing_fixture VALUES ('$mille_standing_preview$');",
};
const sources = [...migrations, futureMigration];
const standingFailure = /常設 Preview DB/;
const verifyCurrent = async () => {};

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

async function fixtureDatabase(t: TestContext, appliedCount = 2) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(migrationSql(configuration, true, migrations.slice(0, appliedCount)));
  await db.exec(registerUserSql(configuration, "test-existing-user", "existing@example.invalid", "Existing"));
  const query: Query = async <Row extends DatabaseRow>(sql: string, parameters?: unknown[]) =>
    (await db.query<Row>(sql, parameters)).rows;
  const history = () => query<{ name: string; sha256: string; applied_at: string }>(
    "SELECT name, sha256, applied_at::text FROM schema_migrations ORDER BY name",
  );
  return { db, query, history };
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
  const unusedQuery: Query = async () => assert.fail("SQL started before verifying the connection");
  for (const value of [uri.replace(host, "ep-other.ap-southeast-1.aws.neon.tech"), `${uri}&options=-csearch_path%3Dother`,
    uri.replace("sslmode=require", "sslmode=disable"), uri.replace("neondb_owner", "other_user")]) {
    const { request } = providerFixture(new Map([[uriPath, { uri: value }]]));
    await assert.rejects(openStandingDatabase(apiKey, expected, sources, { request, query: unusedQuery }),
      (error: Error) => error.message.includes("接続先の照合") && !error.message.includes("fixture-secret"));
  }
  const { request } = providerFixture();
  await assert.rejects(openStandingDatabase(apiKey, { ...expected, endpointId: "ep-unexpected" }, sources,
    { request, query: unusedQuery }), standingFailure);
});

test("SQL原本の欠落、番号の飛び、固定済みSQLの改変を拒否する", async () => {
  const wrongSources = [
    sources.filter(({ name }) => name !== "006_meal_suggestions.sql"),
    [...migrations, { ...futureMigration, name: `${String(migrations.length + 2).padStart(3, "0")}_fixture.sql` }],
    sources.map(source => source.name === "006_meal_suggestions.sql" ? { ...source, source: `${source.source}\n` } : source),
  ];
  for (const input of wrongSources) {
    const { request, called } = providerFixture();
    let sqlCalls = 0;
    const query: Query = async () => { sqlCalls++; return []; };
    await assert.rejects(openStandingDatabase(apiKey, expected, input, { request, query }), standingFailure);
    assert.deepEqual(called, []);
    assert.equal(sqlCalls, 0);
  }
});

test("常設 DB の読み取り後に同じ原本から未適用SQLだけを一括適用し、既存履歴と利用者を保持する", async t => {
  const { request } = providerFixture();
  const { query, history } = await fixtureDatabase(t);
  const users = () => query("SELECT * FROM app_users ORDER BY id");
  const before = await history(), existing = await users();
  let writes = 0, checks = 0;
  const counted: Query = async <Row extends DatabaseRow>(sql: string, params?: unknown[]) => {
    if (!/^\s*SELECT\b/i.test(sql)) {
      assert.ok(checks > 0);
      writes++;
    }
    return query<Row>(sql, params);
  };
  const connection = await openStandingDatabase(apiKey, expected, sources, { request, query: counted });
  assert.equal(connection.configuration.environment, "preview");
  assert.equal(connection.configuration.environmentId, "mille-preview");
  assert.equal(connection.configuration.url === uri, true);
  await assert.rejects(connection.verify(), standingFailure);
  assert.deepEqual(await history(), before);
  assert.equal(writes, 0);

  const applied = sources.slice(2).map(({ name }) => name);
  assert.deepEqual(await connection.migrate(async () => { checks++; }), applied);
  assert.equal(writes, 1);
  assert.ok(checks >= 2);
  const after = await history();
  assert.deepEqual(after.slice(0, 2), before);
  assert.deepEqual(after.slice(2).map(({ name }) => name), applied);
  assert.equal(after.at(-1)?.sha256, createHash("sha256").update(futureMigration.source).digest("hex"));
  assert.deepEqual(await users(), existing);
  assert.deepEqual(await query("SELECT note FROM standing_fixture"), [{ note: "$mille_standing_preview$" }]);

  await connection.verify();
  assert.deepEqual(await connection.migrate(verifyCurrent), []);
  const reopened = await openStandingDatabase(apiKey, expected, sources, { request, query: counted });
  assert.deepEqual(await reopened.migrate(verifyCurrent), []);
  await reopened.verify();
  assert.deepEqual(await history(), after);
  assert.equal(writes, 1);
});

test("DBの環境識別、履歴のハッシュ・欠番・未知の適用、および読み取り後の既存履歴変更を拒否する", async t => {
  const { db, query, history } = await fixtureDatabase(t, 4);
  const { request } = providerFixture();
  const open = () => openStandingDatabase(apiKey, expected, sources, { request, query });
  const before = await history();
  await db.exec("UPDATE mille_environment SET environment_id = 'other-preview'");
  await assert.rejects(open, standingFailure);
  await db.exec("UPDATE mille_environment SET environment_id = 'mille-preview'");

  const missing = before[2];
  await db.query("UPDATE schema_migrations SET sha256 = repeat('0', 64) WHERE name = $1", [missing.name]);
  await assert.rejects(open, standingFailure);
  await db.query("UPDATE schema_migrations SET sha256 = $2 WHERE name = $1", [missing.name, missing.sha256]);
  await db.exec("INSERT INTO schema_migrations (name, sha256) VALUES ('008_unknown.sql', repeat('0', 64))");
  await assert.rejects(open, standingFailure);
  await db.exec("DELETE FROM schema_migrations WHERE name = '008_unknown.sql'");
  await db.query("DELETE FROM schema_migrations WHERE name = $1", [missing.name]);
  await assert.rejects(open, standingFailure);
  await db.query("INSERT INTO schema_migrations (name, sha256, applied_at) VALUES ($1, $2, $3)",
    [missing.name, missing.sha256, missing.applied_at]);

  const connection = await open();
  await db.query("UPDATE schema_migrations SET applied_at = applied_at + interval '1 second' WHERE name = $1", [missing.name]);
  const drifted = await history();
  await assert.rejects(connection.migrate(verifyCurrent), standingFailure);
  assert.deepEqual(await history(), drifted);
});

test("公開中のSHAが必要とする末尾の履歴が失われた場合は補完しない", async t => {
  const { db, query, history } = await fixtureDatabase(t, migrations.length);
  const { request } = providerFixture();
  let writes = 0;
  const counted: Query = async <Row extends DatabaseRow>(sql: string, params?: unknown[]) => {
    if (!/^\s*SELECT\b/i.test(sql)) writes++;
    return query<Row>(sql, params);
  };
  const open = () => openStandingDatabase(apiKey, expected, sources, { request, query: counted, previousSources: migrations });
  const connection = await open();
  await db.query("DELETE FROM schema_migrations WHERE name = $1", [migrations.at(-1)?.name]);
  const incomplete = await history();
  await assert.rejects(open, standingFailure);
  await assert.rejects(connection.migrate(verifyCurrent), standingFailure);
  await assert.rejects(connection.verify(), standingFailure);
  assert.deepEqual(await history(), incomplete);
  assert.equal(writes, 0);
});

test("DB履歴と現在の原本を同時に書き換えても従来のSHAに含まれた原本の変更は拒否する", async t => {
  const { db, query, history } = await fixtureDatabase(t, migrations.length);
  const { request, called } = providerFixture();
  await db.exec(migrationSql(configuration, false, sources));
  const changed = { ...futureMigration, source: `${futureMigration.source}\n-- changed after release` };
  await db.query("UPDATE schema_migrations SET sha256 = $2 WHERE name = $1",
    [changed.name, createHash("sha256").update(changed.source).digest("hex")]);
  const before = await history();
  await assert.rejects(openStandingDatabase(apiKey, expected, [...migrations, changed], {
    request, query, previousSources: sources,
  }), standingFailure);
  assert.deepEqual(called, []);
  assert.deepEqual(await history(), before);
});

test("移行前に常設接続先またはmainの確認が失敗したら未適用SQLを実行しない", async t => {
  const { query, history } = await fixtureDatabase(t, 4);
  const provider = providerFixture();
  const connection = await openStandingDatabase(apiKey, expected, sources, { request: provider.request, query });
  const before = await history();
  provider.values.set(endpointsPath, { endpoints: [{ ...endpoints.endpoints[0], disabled: true }] });
  await assert.rejects(connection.migrate(verifyCurrent), standingFailure);
  assert.deepEqual(await history(), before);
  provider.values.set(endpointsPath, endpoints);
  await assert.rejects(connection.migrate(async () => { throw new Error("main advanced"); }), standingFailure);
  assert.deepEqual(await history(), before);
});

test("ロック取得直前に有効な移行履歴が進んだら停止し、新しい照合で残りだけを適用する", async t => {
  const { db, query, history } = await fixtureDatabase(t, 4);
  const { request } = providerFixture();
  const connection = await openStandingDatabase(apiKey, expected, sources, {
    request, query, previousSources: migrations.slice(0, 4),
  });
  await assert.rejects(connection.migrate(async () => {
    await db.exec(migrationSql(configuration, false, sources.slice(0, 5)));
  }), standingFailure);
  const advanced = await history();
  assert.deepEqual(advanced.map(({ name }) => name), sources.slice(0, 5).map(({ name }) => name));

  assert.deepEqual(await connection.migrate(verifyCurrent), sources.slice(5).map(({ name }) => name));
  await connection.verify();
  assert.deepEqual((await history()).slice(0, 5), advanced);
});

test("SQL失敗、適用日時の変更、移行履歴や環境識別子の書き換えはすべてロールバックする", async t => {
  const { query, history } = await fixtureDatabase(t, 4);
  const { request } = providerFixture();
  const before = await history();
  for (const sql of [
    "SELECT * FROM missing_standing_fixture;",
    "UPDATE schema_migrations SET applied_at = applied_at + interval '1 second' WHERE name = '001_auth.sql';",
    "UPDATE schema_migrations SET sha256 = repeat('0', 64) WHERE name = '005_meal_plans.sql';",
    "UPDATE mille_environment SET environment_id = 'other-preview';",
  ]) {
    const brokenSources = [...migrations, { ...futureMigration, source: `${futureMigration.source} ${sql}` }];
    const connection = await openStandingDatabase(apiKey, expected, brokenSources, {
      request, query, previousSources: migrations.slice(0, 4),
    });
    await assert.rejects(connection.migrate(verifyCurrent), standingFailure);
    assert.deepEqual(await history(), before);
    assert.deepEqual(await query("SELECT to_regclass('public.standing_fixture') AS fixture"), [{ fixture: null }]);
    assert.deepEqual(await query("SELECT to_regprocedure('public.mille_meal_adopt_plan(text,text,jsonb)') AS adopt"), [{ adopt: null }]);
    assert.deepEqual(await query("SELECT environment_id FROM mille_environment"), [{ environment_id: "mille-preview" }]);
  }
});
