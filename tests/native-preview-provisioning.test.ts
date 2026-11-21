import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  clearNativePreviewProvisioningOutput,
  isNativePreviewProvisioning,
  writeNativePreviewProvisioningOutput,
} from "../scripts/build/native-preview-provisioning";
import { runVercelBuild } from "../scripts/build/vercel-build";

const sha = "a".repeat(40);
const branch = "codex/issue-32-native-preview-build";
const provision = Object.freeze({
  VERCEL: "1", VERCEL_BUILD_IMAGE: "al2023", VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview",
  VERCEL_DEPLOYMENT_ID: "dpl_FixturePreview", AUTH_MODE: "test", VERCEL_GIT_REPO_OWNER: "tyask", VERCEL_GIT_REPO_SLUG: "mille",
  VERCEL_GIT_COMMIT_REF: branch, VERCEL_GIT_COMMIT_SHA: sha,
  MILLE_NATIVE_PREVIEW_PHASE: "provision", MILLE_NATIVE_PREVIEW_SOURCE_BRANCH: branch, MILLE_NATIVE_PREVIEW_SOURCE_SHA: sha,
  MILLE_NATIVE_PREVIEW_PR: "35", MILLE_NATIVE_PREVIEW_GENERATION: "1234a678-123b-4abc-9f12-123456789abc",
});

function directory(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mille-native-preview-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixtureFile(root: string, name: string, contents = "fixture") {
  const file = join(root, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

test("Native Preview provisioning requires the explicit phase and matching hosted PR identity", () => {
  assert.equal(isNativePreviewProvisioning({}), false);
  assert.equal(isNativePreviewProvisioning({ ...provision, VERCEL_TARGET_ENV: undefined }), true);
  const noDatabaseReads = new Proxy(provision, {
    get(target, key, receiver) {
      if (/DATABASE|NEON/.test(String(key))) assert.fail(`Unexpected database configuration read: ${String(key)}`);
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(isNativePreviewProvisioning(noDatabaseReads), true);

  const rejected: Record<string, string | undefined>[] = [
    { MILLE_NATIVE_PREVIEW_PHASE: "" }, { MILLE_NATIVE_PREVIEW_PHASE: "application" },
    { VERCEL: undefined }, { VERCEL_BUILD_IMAGE: " " }, { VERCEL_ENV: "production" }, { VERCEL_TARGET_ENV: "production" },
    { VERCEL_DEPLOYMENT_ID: "dpl_" }, { VERCEL_GIT_REPO_OWNER: "other" }, { VERCEL_GIT_REPO_SLUG: "other" },
    { AUTH_MODE: undefined }, { AUTH_MODE: "google" },
    { VERCEL_GIT_COMMIT_REF: "codex/other" },
    { VERCEL_GIT_COMMIT_REF: "codex/../other", MILLE_NATIVE_PREVIEW_SOURCE_BRANCH: "codex/../other" },
    { VERCEL_GIT_COMMIT_REF: "main", MILLE_NATIVE_PREVIEW_SOURCE_BRANCH: "main" },
    { VERCEL_GIT_COMMIT_SHA: "b".repeat(40) }, { VERCEL_GIT_COMMIT_SHA: "a", MILLE_NATIVE_PREVIEW_SOURCE_SHA: "a" },
    { MILLE_NATIVE_PREVIEW_PR: "0" }, { MILLE_NATIVE_PREVIEW_PR: "035" }, { MILLE_NATIVE_PREVIEW_PR: "9007199254740992" },
    { MILLE_NATIVE_PREVIEW_GENERATION: "1234a678-123b-4abc-7f12-123456789abc" },
    { MILLE_NATIVE_PREVIEW_GENERATION: provision.MILLE_NATIVE_PREVIEW_GENERATION.toUpperCase() },
  ];
  for (const override of rejected) {
    assert.throws(() => isNativePreviewProvisioning({ ...provision, ...override }), /準備用ビルドの対象/, JSON.stringify(override));
  }
});

test("the Vercel build uses just the preparation step for valid Native previews", async () => {
  const calls: string[] = [];
  const steps = {
    build() { calls.push("build"); },
    migrate() { calls.push("migrate"); },
    provision() { calls.push("provision"); },
  };
  const run = async (environment: Readonly<Record<string, string | undefined>>, expected: string[]) => {
    calls.length = 0;
    await runVercelBuild(environment, steps);
    assert.deepEqual(calls, expected);
  };
  await run(provision, ["provision"]);
  const ordinary = { ...provision, MILLE_NATIVE_PREVIEW_PHASE: undefined };
  await run(ordinary, ["build"]);
  const productionHost = "ep-test.ap-southeast-1.aws.neon.tech";
  await run({
    ...ordinary, VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production", VERCEL_GIT_COMMIT_REF: "main", AUTH_MODE: "google",
    MILLE_PRODUCTION_DATABASE_HOST: productionHost, MILLE_PRODUCTION_ENVIRONMENT_ID: "mille-production",
    DATABASE_URL: `postgresql://fixture:dummy@${productionHost}/fixture?sslmode=require`,
  }, ["build", "migrate"]);

  calls.length = 0;
  await assert.rejects(runVercelBuild({ ...provision, VERCEL_GIT_COMMIT_SHA: "b".repeat(40) }, steps));
  await assert.rejects(runVercelBuild({ ...provision, VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production" }, steps));
  await assert.rejects(runVercelBuild(provision, { build: steps.build, migrate: steps.migrate }));
  assert.deepEqual(calls, []);
});

test("preparation publishes one static page with private routing and removes stale runtime output", t => {
  const root = directory(t);
  const staleNext = fixtureFile(root, ".next/server/app/page.js");
  const staleVercel = fixtureFile(root, ".vercel/output/functions/index.func/index.js");
  const projectConfig = fixtureFile(root, ".vercel/project.json", "project configuration");
  writeNativePreviewProvisioningOutput(root);
  assert.equal(existsSync(staleNext), false);
  assert.equal(existsSync(staleVercel), false);
  assert.equal(readFileSync(projectConfig, "utf8"), "project configuration");

  const output = join(root, ".next/output");
  assert.deepEqual(readdirSync(output).sort(), ["config.json", "static"]);
  assert.deepEqual(readdirSync(join(output, "static")), ["index.html"]);
  assert.deepEqual(JSON.parse(readFileSync(join(output, "config.json"), "utf8")), {
    version: 3,
    routes: [
      {
        src: "/(.*)",
        headers: {
          "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "X-Mille-Preview-Phase": "provision",
          "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        },
        continue: true,
      },
      { src: "/", dest: "/index.html", methods: ["GET", "HEAD"] },
      { src: "/(.*)", status: 404 },
    ],
  });
  assert.match(readFileSync(join(output, "static/index.html"), "utf8"), /mille Previewを準備しています/);
  assert.ok(existsSync(join(root, ".next/.mille-native-preview-provisioning")));

  const publishedCopy = join(root, ".vercel/output");
  cpSync(output, publishedCopy, { recursive: true });
  const cache = fixtureFile(root, ".next/cache/preserved");
  clearNativePreviewProvisioningOutput(root);
  clearNativePreviewProvisioningOutput(root);
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(publishedCopy), false);
  assert.equal(existsSync(join(root, ".next/.mille-native-preview-provisioning")), false);
  assert.equal(readFileSync(cache, "utf8"), "fixture");
  assert.equal(readFileSync(projectConfig, "utf8"), "project configuration");
});

test("app builds preserve normal output even when a preparation marker remains", t => {
  const root = directory(t);
  const unmarked = fixtureFile(root, ".next/output/functions/page.func/index.js");
  clearNativePreviewProvisioningOutput(root);
  assert.equal(readFileSync(unmarked, "utf8"), "fixture");

  writeNativePreviewProvisioningOutput(root);
  rmSync(join(root, ".next/output"), { recursive: true });
  const appNext = fixtureFile(root, ".next/output/functions/page.func/index.js");
  const appVercel = fixtureFile(root, ".vercel/output/config.json", JSON.stringify({ version: 3, routes: [] }));
  assert.throws(() => clearNativePreviewProvisioningOutput(root), /準備用出力を照合/);
  assert.equal(readFileSync(appNext, "utf8"), "fixture");
  assert.deepEqual(JSON.parse(readFileSync(appVercel, "utf8")), { version: 3, routes: [] });
});

test("cleanup uses recorded bytes across versions and preserves both copies on a checksum mismatch", t => {
  const root = directory(t);
  writeNativePreviewProvisioningOutput(root);
  const output = join(root, ".next/output");
  const publishedCopy = join(root, ".vercel/output");
  const marker = join(root, ".next/.mille-native-preview-provisioning");
  const index = join(output, "static/index.html");
  const previousIndex = Buffer.concat([readFileSync(index), Buffer.from("<!-- previous native preparation page -->\n")]);
  writeFileSync(index, previousIndex);
  const [protocol, configHash] = readFileSync(marker, "utf8").split("\n");
  writeFileSync(marker, `${protocol}\n${configHash}\n${createHash("sha256").update(previousIndex).digest("hex")}\n`);
  mkdirSync(dirname(publishedCopy));
  cpSync(output, publishedCopy, { recursive: true });

  const copiedIndex = join(publishedCopy, "static/index.html");
  writeFileSync(copiedIndex, "a different page");
  assert.throws(() => clearNativePreviewProvisioningOutput(root), /準備用出力を照合/);
  assert.deepEqual(readFileSync(index), previousIndex);
  assert.equal(readFileSync(copiedIndex, "utf8"), "a different page");
  assert.ok(existsSync(marker));

  writeFileSync(copiedIndex, previousIndex);
  clearNativePreviewProvisioningOutput(root);
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(publishedCopy), false);
  assert.equal(existsSync(marker), false);
});

test("provisioning and cleanup reject symlink output parents without traversing them", async t => {
  for (const path of [".next", ".vercel", ".next/output", ".vercel/output"]) {
    await t.test(path, t => {
      const root = directory(t);
      const outside = directory(t);
      const outsideFile = fixtureFile(outside, "output/do-not-touch");
      const destination = join(root, path);
      mkdirSync(dirname(destination), { recursive: true });
      symlinkSync(outside, destination, "junction");
      assert.throws(() => writeNativePreviewProvisioningOutput(root), /実ディレクトリ/);
      assert.equal(readFileSync(outsideFile, "utf8"), "fixture");
      assert.ok(lstatSync(destination).isSymbolicLink());
    });
  }

  const root = directory(t);
  const outside = directory(t);
  const outsideFile = fixtureFile(outside, "output/do-not-touch");
  writeNativePreviewProvisioningOutput(root);
  symlinkSync(outside, join(root, ".vercel"), "junction");
  assert.throws(() => clearNativePreviewProvisioningOutput(root), /実ディレクトリ/);
  assert.equal(readFileSync(outsideFile, "utf8"), "fixture");
  assert.ok(existsSync(join(root, ".next/output/config.json")));
});
