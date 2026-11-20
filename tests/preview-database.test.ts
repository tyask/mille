import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { DatabaseConfiguration } from "../lib/server/database/environment";
import { migrationSql, repositoryMigrationSources } from "../scripts/db/sql";
import { preparePreviewDatabase, previewDatabaseEnvironmentId, previewMigrationSources } from "../scripts/preview/database";

test("PR ごとに別の DB 環境 ID を要求する", () => {
  assert.equal(previewDatabaseEnvironmentId(12), "mille-pr-12");
  assert.notEqual(previewDatabaseEnvironmentId(12), previewDatabaseEnvironmentId(13));
  assert.throws(() => previewDatabaseEnvironmentId(0));
  assert.throws(() => previewDatabaseEnvironmentId(Number.MAX_SAFE_INTEGER + 1));
});

test("DB 名・直接接続・TLS の不一致は接続前に拒否する", async () => {
  const expected = {
    pr: 12, initialize: false, expectedDatabase: "mille",
    expectedHost: "ep-test.neon.tech",
  };
  await assert.rejects(preparePreviewDatabase({
    ...expected, connectionString: "postgresql://dummy:dummy@ep-test.neon.tech/foreign?sslmode=require",
  }), /名前または直接接続設定/);
  await assert.rejects(preparePreviewDatabase({
    ...expected, expectedHost: "ep-test-pooler.neon.tech",
    connectionString: "postgresql://dummy:dummy@ep-test-pooler.neon.tech/mille?sslmode=require",
  }), /名前または直接接続設定/);
  await assert.rejects(preparePreviewDatabase({
    ...expected, connectionString: "postgresql://dummy:dummy@ep-test.neon.tech/mille",
  }), /名前または直接接続設定/);
});

const mainSources = repositoryMigrationSources();
const baseline = mainSources.map(({ name, source }) => ({
  file: `db/migrations/${name}`, data: Buffer.from(source),
}));
const nextNumber = String(Number(mainSources.at(-1)?.name.slice(0, 3)) + 1).padStart(3, "0");
const candidate = (suffix: string, sql = "CREATE TABLE pr_fixture (id int)") => ({
  file: `db/migrations/${nextNumber}_${suffix}.sql`, data: Buffer.from(sql),
});

test("PR migration は main の原本と同じ履歴を要求し、連番の追加だけを許可する", () => {
  assert.throws(() => previewMigrationSources([]), /main の原本/);
  const changed = { ...baseline[0], data: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), baseline[0].data]) };
  assert.throws(() => previewMigrationSources([changed, ...baseline.slice(1)]), /main の原本/);
  assert.throws(() => previewMigrationSources([...baseline, candidate("one"), candidate("two")]), /次の連番/);
  assert.throws(() => previewMigrationSources([...baseline, { ...candidate("invalid"), data: Buffer.from([0xff]) }]), /UTF-8/);
  assert.throws(() => previewMigrationSources([...baseline, candidate("empty", " ")]), /本文/);
  assert.throws(() => previewMigrationSources([...baseline, { ...candidate("nested"), file: "db/migrations/nested/file.sql" }]), /ファイル名/);
  assert.equal(previewMigrationSources([candidate("fixture"), ...baseline]).at(-1)?.name, `${nextNumber}_fixture.sql`);
});

test("PR HEAD の追加 migration を適用し、適用後のハッシュ不一致を拒否する", async t => {
  const database = new PGlite();
  t.after(() => database.close());
  const configuration: DatabaseConfiguration = {
    mode: "hosted", url: "", host: "", environment: "preview", environmentId: previewDatabaseEnvironmentId(12),
  };
  await database.exec(migrationSql(configuration, true));
  const sources = previewMigrationSources([...baseline, candidate("fixture")]);
  await database.exec(migrationSql(configuration, true, sources));
  await database.exec("INSERT INTO pr_fixture VALUES (12)");
  await database.exec(migrationSql(configuration, true, sources));
  assert.deepEqual((await database.query("SELECT id FROM pr_fixture")).rows, [{ id: 12 }]);
  const edited = previewMigrationSources([...baseline, candidate("fixture", "CREATE TABLE pr_fixture (id bigint)")]);
  await assert.rejects(database.exec(migrationSql(configuration, true, edited)), /checksum mismatch/);
  assert.deepEqual((await database.query("SELECT id FROM pr_fixture")).rows, [{ id: 12 }]);
});
