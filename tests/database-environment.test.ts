import assert from "node:assert/strict";
import test from "node:test";
import { databaseConfiguration, hostedDatabaseConfiguration, isTestEnvironmentConfigured } from "../lib/server/database/environment";

const token = "a".repeat(64);
const memory = { NODE_ENV: "development", AUTH_MODE: "test", MILLE_DB_MODE: "memory",
  MILLE_MEMORY_DATABASE_URL: "http://127.0.0.1:43210", MILLE_MEMORY_DATABASE_TOKEN: token };
const preview = { AUTH_MODE: "test", VERCEL_ENV: "preview",
  MILLE_PREVIEW_DATABASE_URL: "postgresql://fixture:dummy@ep-preview.neon.tech/mille?sslmode=require",
  MILLE_PREVIEW_DATABASE_HOST: "ep-preview.neon.tech", MILLE_PREVIEW_ENVIRONMENT_ID: "mille-preview" };

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
