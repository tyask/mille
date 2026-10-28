import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { findUserByEmail, findUserByIdentity } from "../lib/server/database/users";
import { startMemoryDatabase } from "../scripts/cloud/memory-database";
import { createQuery, verifyDatabaseOwnership } from "../lib/server/database/client";
import { databaseConfiguration } from "../lib/server/database/environment";

test("user repository rechecks live enabled identity through an authenticated loopback database", async t => {
  const instance = await startMemoryDatabase();
  t.after(() => instance.close());
  t.after(() => instance.close()); // Signal/finally cleanup may both call close.
  const overrides: Record<string, string | undefined> = { NODE_ENV: "test", AUTH_MODE: "test", MILLE_DB_MODE: "memory",
    MILLE_MEMORY_DATABASE_URL: instance.url, MILLE_MEMORY_DATABASE_TOKEN: instance.token, VERCEL: undefined, VERCEL_ENV: undefined };
  const previous = new Map(Object.keys(overrides).map(key => [key, process.env[key]]));
  for (const [key,value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => { for (const [key,value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const user = await findUserByEmail(" TEST-A@MILLE.INVALID ");
  assert.equal(user?.id, "mille-test-user-a");
  assert.equal(user?.isTest, true);
  assert.equal((await findUserByIdentity(user!.id, user!.email))?.isEnabled, true);
  assert.equal(await findUserByIdentity(user!.id, "test-b@mille.invalid"), null);
  await instance.database.query("UPDATE app_users SET is_enabled = false WHERE id = $1", [user!.id]);
  assert.equal(await findUserByIdentity(user!.id, user!.email), null);
  assert.equal((await findUserByEmail(user!.email))?.isEnabled, false);
  const denied = await fetch(`${instance.url}/query`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "SELECT 1", parameters: [] }) });
  assert.equal(denied.status, 403);
  const configuration = databaseConfiguration();
  await instance.database.exec("UPDATE mille_environment SET environment_id = 'foreign-environment'");
  await assert.rejects(verifyDatabaseOwnership(createQuery(configuration), configuration), /環境識別が一致しません/);
  await assert.rejects(findUserByEmail(user!.email), /環境識別が一致しません/);
});

test("an occupied sidecar port rejects startup and closes its allocated database", async t => {
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve())));
  const address = occupied.address();
  assert.ok(address && typeof address !== "string");
  const originalClose = PGlite.prototype.close;
  const originalExec = PGlite.prototype.exec;
  const migratedDatabases = new Set<PGlite>();
  const closed: PGlite[] = [];
  t.mock.method(PGlite.prototype, "exec", function(this: PGlite, ...args: Parameters<PGlite["exec"]>) {
    if (args[0].includes("$mille_migration$")) migratedDatabases.add(this);
    return originalExec.apply(this, args);
  });
  t.mock.method(PGlite.prototype, "close", async function(this: PGlite) {
    await originalClose.call(this);
    closed.push(this);
  });
  await assert.rejects(startMemoryDatabase({ port: address.port }), error => error instanceof Error && "code" in error && error.code === "EADDRINUSE");
  // PGlite also closes its separate temporary initdb engine during startup.
  // Verify the specific sidecar instance, rather than counting library internals.
  assert.equal(migratedDatabases.size, 1);
  const [sidecarDatabase] = migratedDatabases;
  assert.ok(closed.includes(sidecarDatabase));
  assert.equal(sidecarDatabase.closed, true);
});
