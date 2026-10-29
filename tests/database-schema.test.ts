import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql, seedSql, disableUserSql, registerUserSql } from "../scripts/db/sql";
import type { DatabaseConfiguration } from "../lib/server/database/environment";

const preview: DatabaseConfiguration = { mode: "hosted", url: "", host: "", environment: "preview", environmentId: "mille-preview" };
const production: DatabaseConfiguration = { ...preview, environment: "production", environmentId: "mille-production" };

test("auth schema and preview fixtures initialize atomically, repeat without changing disabled users, and contain no workspace", async t => {
  const database = new PGlite(); t.after(() => database.close());
  await database.exec(migrationSql(preview, true));
  await database.exec(migrationSql(preview, true));
  await database.exec(seedSql(preview));
  const rows = (await database.query<{ id: string; email: string }>("SELECT id,email FROM app_users ORDER BY id")).rows;
  assert.deepEqual(rows.map(row => row.id), ["mille-test-user-a", "mille-test-user-b"]);
  await database.exec(disableUserSql(preview, rows[0].id));
  await database.exec(seedSql(preview));
  assert.equal((await database.query<{ is_enabled: boolean }>("SELECT is_enabled FROM app_users WHERE id = $1", [rows[0].id])).rows[0].is_enabled, false);
  assert.equal((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM app_users")).rows[0].count, 2);
  assert.equal((await database.query<{ name: string | null }>("SELECT to_regclass('public.workspaces')::text AS name")).rows[0].name, null);
  await assert.rejects(database.query("INSERT INTO app_users (id,email,name) VALUES ('upper','Upper@Example.invalid','Upper')"));
});

test("initialization refuses an existing foreign database and does not leave Mille schema behind", async t => {
  const database = new PGlite(); t.after(() => database.close());
  await database.exec("CREATE TABLE foreign_application (id int); INSERT INTO foreign_application VALUES (1)");
  await assert.rejects(database.exec(migrationSql(preview, true)), /empty dedicated database/);
  assert.equal((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM foreign_application")).rows[0].count, 1);
  assert.equal((await database.query<{ marker: string | null }>("SELECT to_regclass('public.mille_environment')::text AS marker")).rows[0].marker, null);
});

test("wrong marker refuses setup, registration and seed; a modified checksum refuses migration", async t => {
  const database = new PGlite(); t.after(() => database.close());
  await database.exec(migrationSql(preview, true));
  const other: DatabaseConfiguration = { ...preview, environmentId: "another-preview" };
  await assert.rejects(database.exec(migrationSql(other)), /environment mismatch/);
  await assert.rejects(database.exec(seedSql(other)), /environment mismatch/);
  await assert.rejects(database.exec(registerUserSql(other, "real-user", "real@example.invalid", "Real")), /environment mismatch/);
  assert.equal((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM app_users")).rows[0].count, 0);
  await database.exec("UPDATE schema_migrations SET sha256 = 'changed'");
  await assert.rejects(database.exec(migrationSql(preview)), /checksum mismatch/);
});

test("preview fixture collisions roll back and production rejects synthetic users", async t => {
  const database = new PGlite(); t.after(() => database.close());
  await database.exec(migrationSql(preview, true));
  await database.query("INSERT INTO app_users (id,email,name,is_enabled) VALUES ($1,$2,$3,true)", ["mille-test-user-a", "other@example.invalid", "Existing"]);
  await assert.rejects(database.exec(seedSql(preview)), /identity mismatch/);
  assert.equal((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM app_users")).rows[0].count, 1);
  const prod = new PGlite(); t.after(() => prod.close());
  await prod.exec(migrationSql(production, true));
  assert.throws(() => seedSql(production), /Production/);
  await assert.rejects(prod.query("INSERT INTO app_users (id,email,name,is_test) VALUES ('mille-test-user-a','test-a@mille.invalid','Test',false)"), /Production does not permit test users/);
  await prod.exec(registerUserSql(production, "real-user", "real@example.invalid", "Real"));
  await prod.exec(disableUserSql(production, "real-user"));
  assert.equal((await prod.query<{ is_enabled: boolean }>("SELECT is_enabled FROM app_users")).rows[0].is_enabled, false);
});

test("standalone provider SQL is identical to the reviewed migration and fixture generators", () => {
  assert.equal(readFileSync(new URL("../scripts/db/initialize-preview.sql", import.meta.url), "utf8"), migrationSql(preview, true));
  assert.equal(readFileSync(new URL("../scripts/db/initialize-production.sql", import.meta.url), "utf8"), migrationSql(production, true));
  assert.equal(readFileSync(new URL("../scripts/db/seed-preview.sql", import.meta.url), "utf8"), seedSql(preview));
});

test("operator values containing quotes and procedural delimiters remain literal data", async t => {
  const database = new PGlite(); t.after(() => database.close());
  await database.exec(migrationSql(preview, true));
  const id = "person-$mille_disable$-$mille_disable_1$-'";
  const email = "o'brien+$mille_register$@example.invalid";
  const name = "O'Brien $mille_register$; DROP TABLE app_users; $mille_register_1$";
  await database.exec(registerUserSql(preview, id, email, name));
  const row = (await database.query<{ id: string; email: string; name: string; is_enabled: boolean }>("SELECT id,email,name,is_enabled FROM app_users")).rows[0];
  assert.deepEqual(row, { id, email, name, is_enabled: true });
  await database.exec(disableUserSql(preview, id));
  assert.equal((await database.query<{ is_enabled: boolean }>("SELECT is_enabled FROM app_users WHERE id = $1", [id])).rows[0].is_enabled, false);
});
