import assert from "node:assert/strict";
import test from "node:test";
import { preparePreviewDatabase, previewDatabaseEnvironmentId } from "../scripts/preview/database";

test("PR ごとに別の DB 環境 ID を要求する", () => {
  assert.equal(previewDatabaseEnvironmentId(12), "mille-pr-12");
  assert.notEqual(previewDatabaseEnvironmentId(12), previewDatabaseEnvironmentId(13));
  assert.throws(() => previewDatabaseEnvironmentId(0));
  assert.throws(() => previewDatabaseEnvironmentId(Number.MAX_SAFE_INTEGER + 1));
});

test("DB 名・直接接続・TLS の不一致は接続前に拒否する", async () => {
  const expected = {
    pr: 12, initialize: false, expectedDatabase: "mille",
    expectedHost: "ep-test.neon.tech",
  };
  await assert.rejects(preparePreviewDatabase({
    ...expected, connectionString: "postgresql://dummy:dummy@ep-test.neon.tech/foreign?sslmode=require",
  }), /名前または直接接続設定/);
  await assert.rejects(preparePreviewDatabase({
    ...expected, expectedHost: "ep-test-pooler.neon.tech",
    connectionString: "postgresql://dummy:dummy@ep-test-pooler.neon.tech/mille?sslmode=require",
  }), /名前または直接接続設定/);
  await assert.rejects(preparePreviewDatabase({
    ...expected, connectionString: "postgresql://dummy:dummy@ep-test.neon.tech/mille",
  }), /名前または直接接続設定/);
});
