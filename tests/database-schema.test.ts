import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql, seedSql, disableUserSql, registerUserSql } from "../scripts/db/sql";
import type { DatabaseConfiguration } from "../lib/server/database/environment";

const preview: DatabaseConfiguration = { mode: "hosted", url: "", host: "", environment: "preview", environmentId: "mille-preview" };
const production: DatabaseConfiguration = { ...preview, environment: "production", environmentId: "mille-production" };

test("auth and workspace schemas initialize atomically without changing disabled users or creating workspace data", async t => {
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
  assert.equal((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM workspaces")).rows[0].count, 0);
  assert.deepEqual((await database.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name")).rows.map(row => row.name), ["001_auth.sql", "002_workspaces.sql"]);
  await assert.rejects(database.query("INSERT INTO app_users (id,email,name) VALUES ('upper','Upper@Example.invalid','Upper')"));
});

test("upgrading the original auth-only database preserves users, disabled state, ownership and applied migration history", async t => {
  const database = new PGlite(); t.after(() => database.close());
  const source = readFileSync(new URL("../db/migrations/001_auth.sql", import.meta.url), "utf8");
  const checksum = createHash("sha256").update(source).digest("hex");
  await database.exec(source);
  await database.query("INSERT INTO mille_environment (project,environment,environment_id) VALUES ('tyask/mille','preview',$1)", [preview.environmentId]);
  await database.exec("CREATE TABLE schema_migrations (name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())");
  await database.query("INSERT INTO schema_migrations (name,sha256) VALUES ('001_auth.sql',$1)", [checksum]);
  await database.exec(registerUserSql(preview, "existing-user", "existing@example.invalid", "Existing"));
  await database.exec(disableUserSql(preview, "existing-user"));
  const users = (await database.query("SELECT * FROM app_users")).rows;
  const marker = (await database.query("SELECT * FROM mille_environment")).rows;
  const history = (await database.query("SELECT * FROM schema_migrations WHERE name = '001_auth.sql'")).rows;
  await database.exec(migrationSql(preview));
  assert.deepEqual((await database.query("SELECT * FROM app_users")).rows, users);
  assert.deepEqual((await database.query("SELECT * FROM mille_environment")).rows, marker);
  assert.deepEqual((await database.query("SELECT * FROM schema_migrations WHERE name = '001_auth.sql'")).rows, history);
  const upgraded = (await database.query("SELECT * FROM schema_migrations ORDER BY name")).rows;
  assert.equal(upgraded.length, 2);
  await database.exec(migrationSql(preview));
  assert.deepEqual((await database.query("SELECT * FROM schema_migrations ORDER BY name")).rows, upgraded);
  await database.query("UPDATE schema_migrations SET sha256 = 'tampered' WHERE name = '002_workspaces.sql'");
  await assert.rejects(database.exec(migrationSql(preview)), /checksum mismatch/);
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
