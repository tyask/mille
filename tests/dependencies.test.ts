import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dependencyStatus, safeInstallEnvironment, syncDependencies } from "../scripts/cloud/dependencies.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mille-dependencies-"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "dependency-fixture", private: true, version: "1.0.0" }) + "\n");
  writeFileSync(join(directory, "package-lock.json"), JSON.stringify({ name: "dependency-fixture", version: "1.0.0", lockfileVersion: 3, packages: {} }) + "\n");
  writeFileSync(join(directory, ".node-version"), process.version.slice(1) + "\n");
  return directory;
}

function fakeInstall(directory: string) {
  mkdirSync(join(directory, "node_modules"), { recursive: true });
  writeFileSync(join(directory, "node_modules", "fixture-package"), "installed\n");
}

test("Missing installation evidence is unknown and status checks do not create or change files", () => {
  const directory = fixture();
  try {
    const before = readdirSync(directory).sort();
    assert.equal(dependencyStatus(directory).state, "unknown");
    assert.deepEqual(readdirSync(directory).sort(), before);
    fakeInstall(directory);
    const installed = readdirSync(join(directory, "node_modules")).sort();
    assert.equal(dependencyStatus(directory).state, "unknown");
    assert.deepEqual(readdirSync(join(directory, "node_modules")).sort(), installed);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("A successful install atomically records the exact inputs and current runtime", () => {
  const directory = fixture();
  try {
    let calls = 0;
    const result = syncDependencies(directory, { install: target => { calls++; assert.equal(target, directory); fakeInstall(target); } });
    assert.equal(calls, 1); assert.equal(result.state, "ready");
    const receiptPath = join(directory, "node_modules", ".mille-dependencies.json");
    const original = readFileSync(receiptPath, "utf8");
    const receipt = JSON.parse(original);
    assert.match(receipt.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(receipt.node, process.version); assert.equal(receipt.platform, process.platform); assert.equal(receipt.arch, process.arch);
    assert.deepEqual(readdirSync(join(directory, "node_modules")).sort(), [".mille-dependencies.json", "fixture-package"]);
    assert.equal(dependencyStatus(directory).state, "ready");
    assert.equal(readFileSync(receiptPath, "utf8"), original);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Manifest, lockfile and Node pin changes each invalidate installation evidence", () => {
  for (const name of ["package.json", "package-lock.json", ".node-version"]) {
    const directory = fixture();
    try {
      syncDependencies(directory, { install: fakeInstall });
      const path = join(directory, name);
      writeFileSync(path, readFileSync(path, "utf8") + "\n");
      assert.equal(dependencyStatus(directory).state, "stale", name);
      assert.equal(syncDependencies(directory, { install: fakeInstall }).state, "ready", name);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test("Receipts from a different runtime or with a different fingerprint are stale", () => {
  const directory = fixture();
  try {
    syncDependencies(directory, { install: fakeInstall });
    const path = join(directory, "node_modules", ".mille-dependencies.json");
    const original = JSON.parse(readFileSync(path, "utf8"));
    for (const field of ["node", "platform", "arch", "fingerprint"]) {
      writeFileSync(path, JSON.stringify({ ...original, [field]: field === "fingerprint" ? "a".repeat(64) : `other-${original[field]}` }));
      assert.equal(dependencyStatus(directory).state, "stale", field);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("A failed install removes prior ready evidence before invoking npm and preserves other files", () => {
  const directory = fixture();
  try {
    syncDependencies(directory, { install: fakeInstall });
    writeFileSync(join(directory, "user-file.txt"), "keep\n");
    assert.throws(() => syncDependencies(directory, { install: target => {
      assert.equal(dependencyStatus(target).state, "unknown");
      throw new Error("simulated install failure");
    } }), /simulated install failure/);
    assert.equal(dependencyStatus(directory).state, "unknown");
    assert.equal(readFileSync(join(directory, "user-file.txt"), "utf8"), "keep\n");
    assert.equal(readFileSync(join(directory, "node_modules", "fixture-package"), "utf8"), "installed\n");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Node mismatch stops before installation and input changes during installation do not get a receipt", () => {
  const directory = fixture();
  try {
    let called = false;
    writeFileSync(join(directory, ".node-version"), "0.0.0\n");
    assert.throws(() => syncDependencies(directory, { install: () => { called = true; } }), /Node.js/);
    assert.equal(called, false);
    writeFileSync(join(directory, ".node-version"), process.version.slice(1) + "\n");
    assert.throws(() => syncDependencies(directory, { install: target => {
      fakeInstall(target);
      writeFileSync(join(target, "package-lock.json"), "changed during install\n");
    } }), /変更/);
    assert.equal(dependencyStatus(directory).state, "unknown");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Removed modules and corrupt or symlinked receipts are unknown without reading foreign receipt content", () => {
  const directory = fixture();
  try {
    syncDependencies(directory, { install: fakeInstall });
    const modules = join(directory, "node_modules"), receipt = join(modules, ".mille-dependencies.json");
    writeFileSync(receipt, "not-json");
    assert.equal(dependencyStatus(directory).state, "unknown");
    rmSync(receipt);
    const outside = join(directory, "do-not-read.txt"); writeFileSync(outside, "keep\n");
    symlinkSync(outside, receipt);
    assert.equal(dependencyStatus(directory).state, "unknown");
    assert.equal(readFileSync(outside, "utf8"), "keep\n");
    rmSync(modules, { recursive: true });
    assert.equal(dependencyStatus(directory).state, "unknown");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("A symlinked node_modules cannot refresh or invalidate another checkout's evidence", () => {
  const directory = fixture(), outside = fixture();
  try {
    syncDependencies(outside, { install: fakeInstall });
    const foreignReceipt = join(outside, "node_modules", ".mille-dependencies.json");
    const original = readFileSync(foreignReceipt, "utf8");
    symlinkSync(join(outside, "node_modules"), join(directory, "node_modules"));
    let called = false;
    assert.equal(dependencyStatus(directory).state, "unknown");
    assert.throws(() => syncDependencies(directory, { install: () => { called = true; } }), /node_modules/);
    assert.equal(called, false); assert.equal(readFileSync(foreignReceipt, "utf8"), original);
  } finally { rmSync(directory, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("Install environments preserve trust and cache settings without provider credentials or executable hooks", () => {
  const source = {
    PATH: "/fixture/bin", HOME: "/fixture/home", HTTPS_PROXY: "http://proxy.example:8080", NODE_EXTRA_CA_CERTS: "/fixture/ca.pem",
    npm_config_cache: "/fixture/npm-cache", PLAYWRIGHT_BROWSERS_PATH: "/fixture/browser-cache",
    VERCEL_TOKEN: "provider", NEON_API_KEY: "provider", DATABASE_URL: "foreign-db", AUTH_SECRET: "foreign-auth",
    GITHUB_TOKEN: "github", GH_TOKEN: "github", NODE_OPTIONS: "--require=untrusted.js", NODE_TLS_REJECT_UNAUTHORIZED: "0",
    NPM_CONFIG_USERCONFIG: "/foreign/npmrc", npm_config_ignore_scripts: "true", NODE_ENV: "production",
  };
  const result = safeInstallEnvironment(source);
  for (const name of ["PATH", "HOME", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "npm_config_cache", "PLAYWRIGHT_BROWSERS_PATH"] as const) {
    assert.equal(result[name], source[name]);
  }
  for (const name of ["VERCEL_TOKEN", "NEON_API_KEY", "DATABASE_URL", "AUTH_SECRET", "GITHUB_TOKEN", "GH_TOKEN", "NODE_OPTIONS",
    "NODE_TLS_REJECT_UNAUTHORIZED", "NPM_CONFIG_USERCONFIG", "npm_config_ignore_scripts", "NODE_ENV"]) {
    assert.equal(result[name], undefined, name);
  }
});
