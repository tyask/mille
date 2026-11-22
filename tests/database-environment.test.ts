import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { databaseConfiguration, hostedDatabaseConfiguration, isTestEnvironmentConfigured } from "../lib/server/database/environment";
import { nativePreviewEnvironmentId } from "../lib/server/database/native-preview";

const token = "a".repeat(64);
const memory = { NODE_ENV: "development", AUTH_MODE: "test", MILLE_DB_MODE: "memory",
  MILLE_MEMORY_DATABASE_URL: "http://127.0.0.1:43210", MILLE_MEMORY_DATABASE_TOKEN: token };
const preview = { AUTH_MODE: "test", VERCEL_ENV: "preview",
  MILLE_PREVIEW_DATABASE_URL: "postgresql://fixture:dummy@ep-preview.neon.tech/mille?sslmode=require",
  MILLE_PREVIEW_DATABASE_HOST: "ep-preview.neon.tech", MILLE_PREVIEW_ENVIRONMENT_ID: "mille-preview" };
const nativeEndpoint = "ep-native-fixture";
const nativeHost = `${nativeEndpoint}.c-1.ap-southeast-1.aws.neon.tech`;
const generation = "1234a678-123b-4abc-9f12-123456789abc";
const branchId = "br-native-fixture";
const nativeRef = "codex/native-preview-pilot-a";
const nativeSha = "a".repeat(40);
const nativeUrl = `postgresql://neondb_owner:native-fixture-password@${nativeHost}/neondb?sslmode=require&channel_binding=require`;
const native = {
  ...preview, VERCEL: "1", VERCEL_TARGET_ENV: "preview", VERCEL_DEPLOYMENT_ID: "dpl_NativeFixture",
  VERCEL_GIT_REPO_OWNER: "tyask", VERCEL_GIT_REPO_SLUG: "mille", VERCEL_GIT_COMMIT_REF: nativeRef,
  VERCEL_GIT_COMMIT_SHA: nativeSha, VERCEL_GIT_PULL_REQUEST_ID: "41",
  MILLE_NATIVE_PREVIEW_PHASE: "application", MILLE_NATIVE_PREVIEW_PR: "41", MILLE_NATIVE_PREVIEW_SOURCE_BRANCH: nativeRef,
  MILLE_NATIVE_PREVIEW_SOURCE_SHA: nativeSha, MILLE_NATIVE_PREVIEW_GENERATION: generation,
  MILLE_NATIVE_PREVIEW_NEON_BRANCH_ID: branchId, MILLE_NATIVE_PREVIEW_NEON_ENDPOINT_ID: nativeEndpoint,
  MILLE_NATIVE_PREVIEW_DATABASE_HOST_SHA256: createHash("sha256").update(nativeHost).digest("hex"),
  MILLE_NATIVE_PREVIEW_DATABASE_URL: nativeUrl,
};

test("local memory auth requires an explicit loopback-only development configuration", () => {
  assert.equal(isTestEnvironmentConfigured(memory), true);
  assert.equal(databaseConfiguration(memory).environment, "development");
  for (const override of [
    { NODE_ENV: "production" }, { AUTH_MODE: "google" }, { VERCEL: "1" }, { VERCEL_ENV: "preview" },
    { MILLE_MEMORY_DATABASE_URL: "http://localhost:43210" }, { MILLE_MEMORY_DATABASE_URL: "https://127.0.0.1:43210" },
    { MILLE_MEMORY_DATABASE_URL: "http://127.0.0.1:43210/query" },
    { MILLE_MEMORY_DATABASE_URL: "http://user:password@127.0.0.1:43210" },
    { MILLE_MEMORY_DATABASE_URL: "http://127.0.0.1:43210/?token=secret" },
    { MILLE_MEMORY_DATABASE_TOKEN: "" },
  ]) {
    const variables = { ...memory, ...override };
    assert.equal(isTestEnvironmentConfigured(variables), false);
    assert.throws(() => databaseConfiguration(variables));
  }
});

test("preview requires its dedicated URL, exact host and environment marker configuration", () => {
  assert.equal(isTestEnvironmentConfigured(preview), true);
  const configuration = databaseConfiguration(preview);
  assert.equal(configuration.environment, "preview");
  for (const override of [
    { MILLE_PREVIEW_DATABASE_URL: "", DATABASE_URL: "postgresql://fixture:dummy@ep-production.neon.tech/mille" },
    { MILLE_PREVIEW_DATABASE_HOST: "ep-production.neon.tech" }, { MILLE_PREVIEW_ENVIRONMENT_ID: "" },
    { MILLE_PREVIEW_DATABASE_URL: "postgresql://fixture:dummy@ep-preview.neon.tech/mille?sslmode=disable" },
    { MILLE_PREVIEW_DATABASE_URL: "http://ep-preview.neon.tech/mille" },
  ]) {
    assert.throws(() => databaseConfiguration({ ...preview, ...override }));
    assert.equal(isTestEnvironmentConfigured({ ...preview, ...override }), false);
  }
});

test("production never enables dummy authentication and never uses the preview URL", () => {
  assert.equal(isTestEnvironmentConfigured({ ...preview, VERCEL_ENV: "production" }), false);
  assert.throws(() => databaseConfiguration({ ...preview, VERCEL_ENV: "production" }));
  const production = { ...preview, VERCEL_ENV: "production",
    DATABASE_URL: "postgresql://fixture:dummy@ep-production.neon.tech/mille?sslmode=require",
    MILLE_PRODUCTION_DATABASE_HOST: "ep-production.neon.tech", MILLE_PRODUCTION_ENVIRONMENT_ID: "mille-production" };
  assert.equal(databaseConfiguration(production).environment, "production");
  assert.equal(isTestEnvironmentConfigured(production), false);
});

test("invalid configuration errors do not expose connection strings", () => {
  assert.throws(() => hostedDatabaseConfiguration("preview", "wrong.neon.tech", "mille-preview", preview),
    error => error instanceof Error && !error.message.includes("dummy") && !error.message.includes("postgresql"));
});

test("Native app runtime uses only its injected Neon URL and a stable ownership marker", () => {
  const environmentId = nativePreviewEnvironmentId(41, generation, branchId);
  assert.match(environmentId, /^mille-native-pr-41-[a-f0-9]{64}$/);
  assert.notEqual(environmentId, nativePreviewEnvironmentId(42, generation, branchId));
  assert.notEqual(environmentId, nativePreviewEnvironmentId(41, "1234a678-123b-4abc-9f12-123456789abd", branchId));
  assert.notEqual(environmentId, nativePreviewEnvironmentId(41, generation, "br-other"));
  for (const host of [nativeHost, nativeHost.replace(nativeEndpoint, `${nativeEndpoint}-pooler`)]) {
    const url = nativeUrl.replace(nativeHost, host);
    assert.deepEqual(databaseConfiguration({ ...native, MILLE_NATIVE_PREVIEW_DATABASE_URL: url }), {
      mode: "hosted", environment: "preview", environmentId, host, url,
    });
  }
  const nextSha = "b".repeat(40);
  assert.equal(databaseConfiguration({
    ...native, VERCEL_GIT_COMMIT_SHA: nextSha, MILLE_NATIVE_PREVIEW_SOURCE_SHA: nextSha, VERCEL_GIT_PULL_REQUEST_ID: "",
  }).environmentId, environmentId);
  assert.equal(isTestEnvironmentConfigured(native), true);
  assert.deepEqual(databaseConfiguration({ ...preview, MILLE_NATIVE_PREVIEW_DATABASE_URL: nativeUrl }), databaseConfiguration(preview));
});

test("Native app runtime refuses mismatched Preview metadata, connection identities and legacy fallback", () => {
  for (const override of [
    { MILLE_NATIVE_PREVIEW_PHASE: undefined }, { MILLE_NATIVE_PREVIEW_PHASE: "applications" }, { MILLE_NATIVE_PREVIEW_PHASE: "provision" },
    { MILLE_NATIVE_PREVIEW_DATABASE_URL: undefined }, { MILLE_NATIVE_PREVIEW_DATABASE_HOST_SHA256: undefined },
    { MILLE_NATIVE_PREVIEW_NEON_BRANCH_ID: "" }, { MILLE_NATIVE_PREVIEW_NEON_ENDPOINT_ID: "ep-other" },
    { MILLE_NATIVE_PREVIEW_NEON_ENDPOINT_ID: `${nativeEndpoint}-pooler` }, { MILLE_NATIVE_PREVIEW_GENERATION: "latest" },
    { VERCEL: undefined }, { VERCEL_DEPLOYMENT_ID: undefined }, { VERCEL_ENV: "production" }, { VERCEL_TARGET_ENV: "production" },
    { AUTH_MODE: "google" }, { MILLE_DB_MODE: "memory" }, { MILLE_MEMORY_DATABASE_TOKEN: token },
    { VERCEL_GIT_REPO_OWNER: "other" }, { VERCEL_GIT_REPO_SLUG: "other" }, { VERCEL_GIT_COMMIT_REF: "codex/native-preview-pilot-b" },
    { VERCEL_GIT_COMMIT_SHA: "b".repeat(40) }, { VERCEL_GIT_PULL_REQUEST_ID: "42" },
    { VERCEL_GIT_COMMIT_REF: "main", MILLE_NATIVE_PREVIEW_SOURCE_BRANCH: "main" },
    { VERCEL_GIT_PULL_REQUEST_ID: undefined, MILLE_NATIVE_PREVIEW_PR: "2147483648" },
    { MILLE_NATIVE_PREVIEW_DATABASE_URL: nativeUrl.replace(nativeEndpoint, "ep-standing") },
    { MILLE_NATIVE_PREVIEW_DATABASE_URL: nativeUrl.replace(".c-1.", ".c-2.") },
    { MILLE_NATIVE_PREVIEW_DATABASE_URL: nativeUrl.replace(nativeHost, `${nativeHost}:5432`) },
    { MILLE_NATIVE_PREVIEW_DATABASE_URL: nativeUrl.replace("/neondb?", "/other?") },
    { MILLE_NATIVE_PREVIEW_DATABASE_URL: nativeUrl.replace("neondb_owner", "another_role") },
    { MILLE_NATIVE_PREVIEW_DATABASE_URL: nativeUrl.replace("sslmode=require", "sslmode=disable") },
    { MILLE_NATIVE_PREVIEW_DATABASE_URL: `${nativeUrl}&sslmode=require` },
  ]) {
    const variables = { ...native, ...override };
    assert.throws(() => databaseConfiguration(variables), {
      message: "Native Preview のアプリと専用 DB の設定を確認できません。",
    }, Object.keys(override).join(", "));
    assert.equal(isTestEnvironmentConfigured(variables), false);
  }
});
