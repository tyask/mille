import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { test } from "node:test";
import { assertCloudStartupAllowed, assertPortAvailable, cloudChildEnvironment, cloudPort, isolatedEnvironment } from "../scripts/cloud/dev";
import { previewOrigin, scopedProtectionHeaders, sourceUnchanged } from "../scripts/cloud/verify";

test("Cloud rejects hosted/production execution before starting a database", () => {
  const directory = mkdtempSync(join(tmpdir(), "mille-cloud-"));
  try {
    assert.doesNotThrow(() => assertCloudStartupAllowed({}, directory));
    for (const environment of [{ VERCEL: "1" }, { VERCEL: "" }, { VERCEL_ENV: "preview" }, { NODE_ENV: "production" }]) {
      assert.throws(() => assertCloudStartupAllowed(environment, directory));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Cloud preserves environment files and rejects symlinked credential files without reading them", () => {
  const directory = mkdtempSync(join(tmpdir(), "mille-cloud-"));
  try {
    const marker = join(directory, ".env.local");
    writeFileSync(marker, "DO_NOT_READ=fixture\n");
    assert.throws(() => assertCloudStartupAllowed({}, directory), /\.env\.local/);
    rmSync(marker);
    symlinkSync(join(directory, "nonexistent-credential"), marker);
    assert.throws(() => assertCloudStartupAllowed({}, directory), /\.env\.local/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Next/browser child environments retain trust settings and drop foreign credentials and executable hooks", () => {
  const original = {
    PATH: "/fixture/bin", HTTPS_PROXY: "http://proxy.example:8080", NODE_EXTRA_CA_CERTS: "/fixture/ca.pem",
    VERCEL_TOKEN: "fixture-provider", VERCEL_AUTOMATION_BYPASS_SECRET: "fixture-bypass", NEON_API_KEY: "fixture-provider",
    DATABASE_URL: "postgres://foreign", AUTH_SECRET: "foreign-auth", AUTH_GOOGLE_SECRET: "foreign-google",
    GH_TOKEN: "fixture-github", GITHUB_TOKEN: "fixture-github", NODE_OPTIONS: "--require=untrusted.js",
    NODE_TLS_REJECT_UNAUTHORIZED: "0", MILLE_DB_MODE: "neon-production", MILLE_MEMORY_DATABASE_TOKEN: "foreign-token",
  };
  const safe = isolatedEnvironment(original);
  assert.equal(safe.PATH, original.PATH); assert.equal(safe.HTTPS_PROXY, original.HTTPS_PROXY);
  assert.equal(safe.NODE_EXTRA_CA_CERTS, original.NODE_EXTRA_CA_CERTS);
  for (const name of Object.keys(original).filter(name => !["PATH", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"].includes(name))) {
    assert.equal(safe[name], undefined, name);
  }
  const database = { url: "http://127.0.0.1:12345", token: "ephemeral-token" };
  const child = cloudChildEnvironment(original, database, "http://localhost:3000");
  assert.equal(child.MILLE_DB_MODE, "memory"); assert.equal(child.MILLE_MEMORY_DATABASE_URL, database.url);
  assert.equal(child.MILLE_MEMORY_DATABASE_TOKEN, database.token); assert.equal(child.AUTH_MODE, "test");
  assert.equal(child.AUTH_URL, "http://localhost:3000"); assert.match(child.AUTH_SECRET!, /^[a-f0-9]{64}$/);
  assert.notEqual(child.AUTH_SECRET, original.AUTH_SECRET);
  assert.notEqual(child.AUTH_SECRET, cloudChildEnvironment(original, database, "http://localhost:3000").AUTH_SECRET);
});

test("Port validation refuses ambiguous numbers and occupied ports", async () => {
  for (const invalid of [0, -1, 65_536, 1.2, "3000x", " 3000", "03000", "", null, undefined]) {
    assert.throws(() => cloudPort(invalid), String(invalid));
  }
  assert.equal(cloudPort("3000"), 3000);
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, "127.0.0.1", resolve));
  try {
    const address = occupied.address(); assert.ok(address && typeof address !== "string");
    await assert.rejects(assertPortAvailable(address.port, "127.0.0.1"));
  } finally { await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve())); }
});

test("Hosted QA requires a dedicated HTTPS Vercel origin and scopes protection headers exactly", () => {
  const origin = "https://mille-preview-abc.vercel.app";
  assert.equal(previewOrigin(origin), origin);
  for (const invalid of ["http://mille-preview.vercel.app", "https://example.com", `${origin}/path`, `${origin}?token=fixture`,
    "https://user:password@mille-preview.vercel.app", "https://mille-preview.vercel.app:8443"]) {
    assert.throws(() => previewOrigin(invalid));
  }
  assert.deepEqual(scopedProtectionHeaders(`${origin}/api/me`, origin, "fixture-secret"), { "x-vercel-protection-bypass": "fixture-secret" });
  for (const redirected of ["https://vercel.com/login", "https://other.vercel.app", "https://mille-preview-abc.vercel.app.attacker.invalid"]) {
    assert.deepEqual(scopedProtectionHeaders(redirected, origin, "fixture-secret"), {});
  }
  assert.deepEqual(scopedProtectionHeaders(origin, origin), {});
});

test("A passing proof requires unchanged SHA, branch and clean source on both sides", () => {
  const before = { sha: "a".repeat(40), branch: "codex/login-foundation", clean: true };
  assert.equal(sourceUnchanged(before, { ...before }), true);
  assert.equal(sourceUnchanged(before, { ...before, sha: "b".repeat(40) }), false);
  assert.equal(sourceUnchanged(before, { ...before, branch: "main" }), false);
  assert.equal(sourceUnchanged({ ...before, clean: false }, before), false);
  assert.equal(sourceUnchanged(before, { ...before, clean: false }), false);
  assert.equal(sourceUnchanged(null, before), false);
});
