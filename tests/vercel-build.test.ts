import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { DatabaseRow, Query } from "../lib/server/database/client";
import type { DatabaseConfiguration } from "../lib/server/database/environment";
import { nativePreviewEnvironmentId } from "../lib/server/database/native-preview";
import { migrateVercelDatabase, runVercelBuild } from "../scripts/build/vercel-build";
import { migrationSql, registerUserSql, repositoryMigrationSources } from "../scripts/db/sql";

const directHost = "ep-build-fixture-123456.ap-southeast-1.aws.neon.tech";
const pooledHost = "ep-build-fixture-123456-pooler.ap-southeast-1.aws.neon.tech";
const fixtureUrl = (host: string) => `postgresql://fixture:dummy-password@${host}/mille_fixture?sslmode=require&channel_binding=require`;
const production = Object.freeze({
  VERCEL: "1", VERCEL_BUILD_IMAGE: "al2023", VERCEL_DEPLOYMENT_ID: "dpl_BuildFixture123",
  VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main",
  MILLE_PRODUCTION_DATABASE_HOST: pooledHost, MILLE_PRODUCTION_ENVIRONMENT_ID: "mille-production",
  DATABASE_URL: fixtureUrl(pooledHost),
});
const directConfiguration: DatabaseConfiguration = {
  mode: "hosted", environment: "production", environmentId: "mille-production", host: directHost, url: fixtureUrl(directHost),
};
const applicationEndpoint = "ep-build-fixture-123456";
const applicationBranch = "br-native-build-fixture";
const applicationGeneration = "1234a678-123b-4abc-9f12-123456789abc";
const applicationRef = "codex/native-preview-pilot-a";
const applicationSha = "a".repeat(40);
const application = {
  ...production, VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview", AUTH_MODE: "test",
  VERCEL_GIT_REPO_OWNER: "tyask", VERCEL_GIT_REPO_SLUG: "mille", VERCEL_GIT_COMMIT_REF: applicationRef,
  VERCEL_GIT_COMMIT_SHA: applicationSha, VERCEL_GIT_PULL_REQUEST_ID: "41",
  MILLE_NATIVE_PREVIEW_PHASE: "application", MILLE_NATIVE_PREVIEW_PR: "41",
  MILLE_NATIVE_PREVIEW_SOURCE_BRANCH: applicationRef, MILLE_NATIVE_PREVIEW_SOURCE_SHA: applicationSha,
  MILLE_NATIVE_PREVIEW_GENERATION: applicationGeneration, MILLE_NATIVE_PREVIEW_NEON_BRANCH_ID: applicationBranch,
  MILLE_NATIVE_PREVIEW_NEON_ENDPOINT_ID: applicationEndpoint,
  MILLE_NATIVE_PREVIEW_DATABASE_HOST_SHA256: createHash("sha256").update(directHost).digest("hex"),
  MILLE_NATIVE_PREVIEW_DATABASE_URL: `postgresql://neondb_owner:dummy-password@${pooledHost}/neondb?sslmode=require`,
};

test("local, Preview and development builds never run the production migration", async () => {
  for (const [label, environment] of [
    ["local", { NODE_ENV: "production", DATABASE_URL: production.DATABASE_URL }],
    ["local Vercel CLI", { VERCEL: "1" }],
    ["Preview", { ...production, VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview" }],
    ["development", { ...production, VERCEL_ENV: "development", VERCEL_TARGET_ENV: "development" }],
  ] as const) {
    let builds = 0;
    await runVercelBuild(environment, {
      build() { builds++; },
      migrate() { assert.fail(`${label} ran a migration`); },
    });
    assert.equal(builds, 1, label);
  }
});

test("an invalid production claim or mismatched DB settings fail before the build and migration", async () => {
  const invalid: Record<string, string | undefined>[] = [
    { VERCEL: undefined },
    { VERCEL: "0" },
    { VERCEL_BUILD_IMAGE: undefined },
    { VERCEL_BUILD_IMAGE: " " },
    { VERCEL_DEPLOYMENT_ID: undefined },
    { VERCEL_DEPLOYMENT_ID: "dpl_" },
    { VERCEL_DEPLOYMENT_ID: "build201" },
    { VERCEL_ENV: undefined },
    { VERCEL_ENV: "unknown" },
    { VERCEL: undefined, VERCEL_ENV: undefined, VERCEL_TARGET_ENV: undefined, VERCEL_DEPLOYMENT_ID: undefined, VERCEL_GIT_COMMIT_REF: undefined },
    { VERCEL: undefined, VERCEL_ENV: "preview" },
    { VERCEL_ENV: undefined, VERCEL_TARGET_ENV: "production" },
    { VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "production" },
    { VERCEL_TARGET_ENV: "preview" },
    { VERCEL_GIT_COMMIT_REF: undefined },
    { VERCEL_GIT_COMMIT_REF: "codex/fixture" },
    { MILLE_PRODUCTION_ENVIRONMENT_ID: "different-production" },
    { MILLE_PRODUCTION_DATABASE_HOST: undefined },
    { MILLE_PRODUCTION_DATABASE_HOST: directHost },
    { DATABASE_URL: undefined, MILLE_PREVIEW_DATABASE_URL: fixtureUrl(pooledHost) },
    { DATABASE_URL: fixtureUrl(pooledHost).replace("sslmode=require", "sslmode=disable") },
    { DATABASE_URL: `${fixtureUrl(pooledHost)}&sslmode=disable` },
    { DATABASE_URL: fixtureUrl("ep-fixture-pooler.example.invalid"), MILLE_PRODUCTION_DATABASE_HOST: "ep-fixture-pooler.example.invalid" },
  ];
  for (const override of invalid) {
    let steps = 0;
    await assert.rejects(runVercelBuild({ ...production, ...override }, {
      build() { steps++; },
      migrate() { steps++; },
    }), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /dummy-password|postgresql:\/\//u);
      return true;
    });
    assert.equal(steps, 0, Object.keys(override).join(", "));
  }
});

test("a verified main build completes before its migration runs on the direct connection", async () => {
  const extraLabelHost = directHost.replace(".aws.", ".aws-pooler.");
  for (const [runtimeHost, migrationHost] of [[pooledHost, directHost], [directHost, directHost], [extraLabelHost, extraLabelHost]]) {
    const environment = {
      ...production, VERCEL_TARGET_ENV: runtimeHost === pooledHost ? undefined : "production",
      DATABASE_URL: fixtureUrl(runtimeHost), MILLE_PRODUCTION_DATABASE_HOST: runtimeHost,
    };
    const steps: string[] = [];
    await runVercelBuild(environment, {
      async build() {
        steps.push("build started");
        await Promise.resolve();
        steps.push("build completed");
      },
      migrate(configuration) {
        assert.deepEqual(steps, ["build started", "build completed"]);
        assert.deepEqual(configuration, { ...directConfiguration, host: migrationHost, url: fixtureUrl(migrationHost) });
        steps.push("migration completed");
      },
    });
    assert.deepEqual(steps, ["build started", "build completed", "migration completed"]);
  }
  assert.equal(production.DATABASE_URL, fixtureUrl(pooledHost));
});

test("a failed build stops before a database operation and a failed migration rejects the build command", async () => {
  let migrations = 0;
  await assert.rejects(runVercelBuild(production, {
    async build() { throw new Error("compile failure fixture"); },
    migrate() { migrations++; },
  }));
  assert.equal(migrations, 0);

  const steps: string[] = [];
  await assert.rejects(runVercelBuild(production, {
    build() { steps.push("build completed"); },
    async migrate() { steps.push("migration started"); throw new Error("migration failure fixture"); },
  }));
  assert.deepEqual(steps, ["build completed", "migration started"]);
});

test("a Native application verifies the existing marker before building and records one receipt after success", async t => {
  const environmentId = nativePreviewEnvironmentId(41, applicationGeneration, applicationBranch);
  let marker = environmentId;
  let failedBuild = false;
  const events: string[] = [];
  const receipt = `Mille: Native Preview アプリビルド照合 v1 dpl_BuildFixture123 41 ${applicationRef} ${applicationSha} ${applicationGeneration} ${applicationEndpoint}`;
  t.mock.method(console, "log", (line: string) => { events.push(line); });
  t.mock.method(globalThis, "fetch", async (input: string | URL, init: RequestInit) => {
    assert.equal(new URL(input).pathname, "/sql");
    assert.equal(new Headers(init.headers).get("Neon-Connection-String"), application.MILLE_NATIVE_PREVIEW_DATABASE_URL);
    assert.deepEqual(JSON.parse(String(init.body)), {
      query: "SELECT project, environment, environment_id FROM mille_environment WHERE singleton = true", params: [],
    });
    events.push("ownership read");
    return Response.json({
      fields: ["project", "environment", "environment_id"].map(name => ({ name, dataTypeID: 25 })),
      rows: [["tyask/mille", "preview", marker]],
    });
  });
  const steps = {
    async build() {
      events.push("Next.js build started");
      await Promise.resolve();
      if (failedBuild) throw new Error("dummy-password");
      events.push("Next.js build completed");
    },
    migrate() { assert.fail("Native application triggered a migration"); },
    provision() { assert.fail("Native application generated the preparation page"); },
  };
  await runVercelBuild(application, steps);
  assert.deepEqual(events.splice(0), ["ownership read", "Next.js build started", "Next.js build completed", receipt]);

  marker = "mille-standing-preview";
  await assert.rejects(runVercelBuild(application, steps), { message: "Native Preview の専用 DB の所有を確認できません。" });
  assert.deepEqual(events.splice(0), ["ownership read"]);

  marker = environmentId;
  failedBuild = true;
  await assert.rejects(runVercelBuild(application, steps), { message: "Next.jsのビルドに失敗しました。" });
  assert.deepEqual(events.splice(0), ["ownership read", "Next.js build started"]);

  for (const override of [
    { VERCEL_BUILD_IMAGE: undefined }, { VERCEL_TARGET_ENV: "production" }, { MILLE_NATIVE_PREVIEW_PHASE: undefined },
    { MILLE_NATIVE_PREVIEW_DATABASE_URL: application.MILLE_NATIVE_PREVIEW_DATABASE_URL.replace(applicationEndpoint, "ep-standing") },
  ]) {
    await assert.rejects(runVercelBuild({ ...application, ...override }, steps), /Native Preview/);
    assert.deepEqual(events, []);
  }
});

test("the production build applies pending SQL through the existing guard without initializing or seeding", async t => {
  const database = new PGlite();
  t.after(() => database.close());
  const query: Query = async <Row extends DatabaseRow>(text: string, parameters?: unknown[]) =>
    (await database.query<Row>(text, parameters)).rows;
  const build = () => runVercelBuild(production, {
    build() {},
    migrate: configuration => migrateVercelDatabase(configuration, query),
  });
  const migrations = repositoryMigrationSources();
  const pending = migrations.filter(({ name }) => name >= "004_meal_api.sql");
  const fingerprint = ({ source }: (typeof migrations)[number]) => createHash("sha256").update(source).digest("hex");
  const history = () => query<{ name: string; sha256: string; applied_at: Date }>("SELECT * FROM schema_migrations ORDER BY name");
  const relations = () => query("SELECT to_regclass('public.mille_environment')::text AS marker, to_regclass('public.meal_command_requests')::text AS pending");

  await assert.rejects(build());
  assert.deepEqual(await relations(), [{ marker: null, pending: null }]);

  await database.exec(migrationSql(directConfiguration, true, migrations.filter(({ name }) => name < "004_meal_api.sql")));
  await database.exec(registerUserSql(directConfiguration, "existing-fixture", "existing@example.invalid", "Existing fixture"));
  const originalHistory = await history();
  const originalUsers = await query("SELECT * FROM app_users ORDER BY id");
  assert.ok(pending.length > 0);
  assert.deepEqual(await relations(), [{ marker: "mille_environment", pending: null }]);

  await database.exec("UPDATE mille_environment SET environment = 'preview', environment_id = 'mille-preview'");
  await assert.rejects(build());
  assert.deepEqual(await history(), originalHistory);
  assert.deepEqual(await relations(), [{ marker: "mille_environment", pending: null }]);
  await database.exec("UPDATE mille_environment SET environment = 'production', environment_id = 'mille-production'");

  await query("UPDATE schema_migrations SET sha256 = 'changed' WHERE name = $1", [originalHistory[1].name]);
  await assert.rejects(build());
  assert.deepEqual(await relations(), [{ marker: "mille_environment", pending: null }]);
  await query("UPDATE schema_migrations SET sha256 = $1 WHERE name = $2", [originalHistory[1].sha256, originalHistory[1].name]);

  // A deliberate name collision occurs after the pending migration has begun creating its tables.
  await database.exec("CREATE INDEX meals_workspace_search_order_idx ON meals (id)");
  await assert.rejects(build());
  assert.deepEqual(await history(), originalHistory);
  assert.deepEqual(await relations(), [{ marker: "mille_environment", pending: null }]);
  await database.exec("DROP INDEX meals_workspace_search_order_idx");

  await build();
  const applied = await history();
  assert.deepEqual(applied.slice(0, originalHistory.length), originalHistory);
  assert.deepEqual(applied.slice(originalHistory.length).map(({ name, sha256 }) => ({ name, sha256 })),
    pending.map(source => ({ name: source.name, sha256: fingerprint(source) })));
  assert.deepEqual(await relations(), [{ marker: "mille_environment", pending: "meal_command_requests" }]);
  assert.deepEqual(await query("SELECT * FROM app_users ORDER BY id"), originalUsers);
  await build();
  assert.deepEqual(await history(), applied);
});
