import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { DatabaseRow, Query } from "../lib/server/database/client";
import type { DatabaseConfiguration } from "../lib/server/database/environment";
import {
  canUseSuggestions, gatewayPreviewEnabled, gatewayPreviewTarget, reserveGatewayRequest,
} from "../lib/server/suggestion-preview";
import { sampleRecommendationProvider } from "../lib/server/suggestion-provider";
import { createSuggestionService, SuggestionDomainError } from "../lib/server/suggestions";
import { TEST_USERS } from "../lib/shared/test-users";
import { migrationSql, repositoryMigrationSources, seedSql } from "../scripts/db/sql";

const preview: DatabaseConfiguration = {
  mode: "hosted", url: "postgresql://fixture:dummy@ep-pr-fixture.neon.tech/mille?sslmode=require",
  host: "ep-pr-fixture.neon.tech", environment: "preview", environmentId: "mille-pr-74",
};
const target = { environmentId: preview.environmentId, sourceSha: "a".repeat(40), deploymentId: "dpl_PreviewFixture" };
const binding = [target.environmentId, target.sourceSha, target.deploymentId];
const environment = {
  VERCEL: "1", VERCEL_ENV: "preview", AUTH_MODE: "test", MILLE_SOURCE_SHA: target.sourceSha,
  MILLE_PREVIEW_DATABASE_URL: preview.url, MILLE_PREVIEW_DATABASE_HOST: preview.host,
  MILLE_PREVIEW_ENVIRONMENT_ID: preview.environmentId, VERCEL_DEPLOYMENT_ID: target.deploymentId,
};

async function openPreview(t: TestContext, beforeGateway = false) {
  const database = new PGlite();
  t.after(() => database.close());
  const migrations = repositoryMigrationSources();
  const initialMigrations = beforeGateway
    ? migrations.filter(({ name }) => name < "007_suggestion_gateway_preview.sql")
    : migrations;
  await database.exec(migrationSql(preview, true, initialMigrations));
  return database;
}

test("only the dedicated test-auth preview and authenticated fixture identities qualify", () => {
  for (const user of TEST_USERS) assert.equal(canUseSuggestions(user, environment), true);
  for (const user of [
    { ...TEST_USERS[0], isEnabled: false },
    { ...TEST_USERS[0], isTest: false },
    { ...TEST_USERS[0], email: TEST_USERS[1].email },
    { ...TEST_USERS[0], id: "other-fixture" },
  ]) assert.equal(canUseSuggestions(user, environment), false);
  assert.equal(canUseSuggestions(TEST_USERS[0], { ...environment, VERCEL_ENV: "production" }), false);
  assert.equal(canUseSuggestions(TEST_USERS[0], { ...environment, AUTH_MODE: "google" }), false);
  assert.equal(canUseSuggestions(TEST_USERS[0], { ...environment, MILLE_PREVIEW_DATABASE_HOST: "other.neon.tech" }), false);

  assert.deepEqual(gatewayPreviewTarget(preview, environment), target);
  assert.deepEqual(gatewayPreviewTarget(preview, { ...environment, VERCEL_TARGET_ENV: "preview" }), target);
  for (const override of [
    { VERCEL: undefined }, { VERCEL_ENV: "production" }, { VERCEL_TARGET_ENV: "production" }, { AUTH_MODE: "google" },
    { MILLE_SOURCE_SHA: "A".repeat(40) }, { VERCEL_DEPLOYMENT_ID: "dpl_" },
  ]) assert.equal(gatewayPreviewTarget(preview, { ...environment, ...override }), null);
  assert.equal(gatewayPreviewTarget({ ...preview, environment: "production" }, environment), null);
  assert.equal(gatewayPreviewTarget({ ...preview, environmentId: "mille-preview" }, environment), null);
  assert.equal(gatewayPreviewTarget({ ...preview, environmentId: "mille-pr-074" }, environment), null);
  assert.equal(gatewayPreviewTarget({ mode: "memory", url: "", token: "", environment: "development",
    environmentId: "local-memory" }, environment), null);
});

test("the gateway preview migration adds an empty singleton with strict target and budget constraints", async t => {
  const database = await openPreview(t, true);
  const table = () => database.query<{ name: string | null }>(
    "SELECT to_regclass('public.mille_suggestion_gateway_preview')::text AS name",
  );
  assert.equal((await table()).rows[0].name, null);
  await database.exec(migrationSql(preview));
  assert.equal((await table()).rows[0].name, "mille_suggestion_gateway_preview");
  assert.deepEqual((await database.query("SELECT * FROM mille_suggestion_gateway_preview")).rows, []);

  const insert = `INSERT INTO mille_suggestion_gateway_preview (environment_id, source_sha, deployment_id)
    VALUES ($1, $2, $3) RETURNING id, enabled, request_count`;
  for (const invalid of [
    ["mille-preview", target.sourceSha, target.deploymentId],
    ["mille-pr-074", target.sourceSha, target.deploymentId],
    [target.environmentId, "A".repeat(40), target.deploymentId],
    [target.environmentId, "a".repeat(39), target.deploymentId],
    [target.environmentId, target.sourceSha, "dpl_"],
    [target.environmentId, target.sourceSha, "dpl_Preview-Fixture"],
  ]) {
    await assert.rejects(database.query(insert, invalid), { code: "23514" });
  }
  const initial = await database.query(insert, binding);
  assert.deepEqual(initial.rows, [{ id: true, enabled: false, request_count: 0 }]);
  await assert.rejects(database.query(insert, binding), { code: "23505" });
  await assert.rejects(database.query("UPDATE mille_suggestion_gateway_preview SET id = false"), { code: "23514" });
  for (const count of [-1, 11]) {
    await assert.rejects(database.query("UPDATE mille_suggestion_gateway_preview SET request_count = $1", [count]),
      { code: "23514" });
  }
});

test("only a matching enabled preview can reserve up to ten gateway requests", async t => {
  const database = await openPreview(t);
  const query: Query = async <Row extends DatabaseRow>(statement: string, parameters?: unknown[]) =>
    (await database.query<Row>(statement, parameters)).rows;

  assert.equal(await gatewayPreviewEnabled(query, target), false);
  assert.equal(await reserveGatewayRequest(query, target), false);
  await database.query(`INSERT INTO mille_suggestion_gateway_preview (environment_id, source_sha, deployment_id)
    VALUES ($1, $2, $3)`, binding);
  assert.equal(await gatewayPreviewEnabled(query, target), false);
  assert.equal(await reserveGatewayRequest(query, target), false);
  await database.query("UPDATE mille_suggestion_gateway_preview SET enabled = true WHERE id = true");
  assert.equal(await gatewayPreviewEnabled(query, target), true);
  for (const mismatch of [
    { ...target, environmentId: "mille-pr-75" },
    { ...target, sourceSha: "b".repeat(40) },
    { ...target, deploymentId: "dpl_OtherFixture" },
  ]) {
    assert.equal(await gatewayPreviewEnabled(query, mismatch), false);
    assert.equal(await reserveGatewayRequest(query, mismatch), false);
  }

  const [owner, outsider] = TEST_USERS;
  const workspaceId = "private-fixture";
  await database.exec(seedSql(preview));
  await query("INSERT INTO workspaces (id, name, type, created_by) VALUES ($1, '自宅', 'PERSONAL', $2)", [workspaceId, owner.id]);
  await query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'OWNER')", [workspaceId, owner.id]);
  const conditions = { mealDate: "2026-11-24", mealType: "DINNER" as const, servings: 2,
    ingredients: ["豆腐"], maxMinutes: 20, cuisine: "和食", request: "" };
  const { data: suggestion } = await createSuggestionService(query, owner, sampleRecommendationProvider)
    .create(workspaceId, conditions, "owner-create");
  const outsiderService = createSuggestionService(query, outsider, {
    async generate(context, signal) {
      await reserveGatewayRequest(query, target);
      return sampleRecommendationProvider.generate(context, signal);
    },
  });
  const notFound = (error: unknown) => error instanceof SuggestionDomainError && error.code === "NOT_FOUND";
  await assert.rejects(outsiderService.create(workspaceId, conditions, "outsider-create"), notFound);
  await assert.rejects(outsiderService.revise(workspaceId, suggestion.id, { expectedVersion: 1, message: "副菜だけ変えて" },
    "outsider-revise"), notFound);
  assert.deepEqual(await query("SELECT request_count FROM mille_suggestion_gateway_preview"), [{ request_count: 0 }]);

  const results = await Promise.all(Array.from({ length: 16 }, () => reserveGatewayRequest(query, target)));
  assert.equal(results.filter(reserved => reserved).length, 10);
  assert.equal(await reserveGatewayRequest(query, target), false);
  assert.deepEqual((await database.query("SELECT request_count FROM mille_suggestion_gateway_preview")).rows,
    [{ request_count: 10 }]);
});
