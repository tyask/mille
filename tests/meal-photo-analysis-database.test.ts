import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { DatabaseRow, Query } from "../lib/server/database/client";
import type { DatabaseConfiguration } from "../lib/server/database/environment";
import { OPENAI_MEAL_PHOTO_MODEL, OPENAI_MEAL_PHOTO_PROMPT_VERSION, sampleMealPhotoAnalysis } from "../lib/server/meal-photo-analysis";
import { createWorkspaceRepository } from "../lib/server/workspaces";
import { TEST_USERS } from "../lib/shared/test-users";
import { migrationSql, repositoryMigrationSources, seedSql } from "../scripts/db/sql";

const preview: DatabaseConfiguration = {
  mode: "hosted", url: "", host: "", environment: "preview", environmentId: "mille-pr-78",
};
const target = { environmentId: preview.environmentId, sourceSha: "a".repeat(40), deploymentId: "dpl_AnalysisFixture" };
const [owner, outsider] = TEST_USERS;
const firstImage = "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+9imf/zAD5gB8wA/5gB/8zQzyUeOAAAA=";
const secondImage = "UklGRjgAAABXRUJQVlA4ICwAAACwAQCdASoBAAEAAUAmJaACdLoABDAAAP7wbK//PzP90/zv16/ubHOLbdAAAA==";
const candidate = sampleMealPhotoAnalysis();

function imageHash(image: string) {
  return createHash("sha256").update(Buffer.from(image, "base64")).digest("hex");
}

type AnalysisStatus =
  "unauthenticated" | "missing" | "ready" | "pending" | "limited" | "started" | "released";

async function fixture(t: TestContext) {
  const database = new PGlite();
  t.after(() => database.close());
  const migrations = repositoryMigrationSources().filter(({ name }) => name <= "010_meal_photo_analysis.sql");
  assert.equal(migrations.at(-1)?.name, "010_meal_photo_analysis.sql");
  await database.exec(migrationSql(preview, true, migrations));
  await database.exec(seedSql(preview));
  const query: Query = async <Row extends DatabaseRow>(sql: string, parameters?: unknown[]) =>
    (await database.query<Row>(sql, parameters)).rows;
  const { id: workspaceId } = await createWorkspaceRepository(query, owner).create({ name: "写真解析の検証", type: "SHARED" });

  async function storePhoto(id = randomUUID(), image = firstImage) {
    await database.query(`INSERT INTO meal_photos (id, workspace_id, created_by, source_size, bytes, width, height, expires_at)
      VALUES ($1, $2, $3, octet_length(decode($4, 'base64')), decode($4, 'base64'), 1, 1, now() + interval '1 hour')`,
    [id, workspaceId, owner.id, image]);
    return { id, imageSha256: imageHash(image) };
  }

  async function command({
    photoId, operation = "start", lease = randomUUID(), payload, openAI = false, actor = owner,
  }: {
    photoId: string;
    operation?: "start" | "finish" | "fail";
    lease?: string;
    payload: object;
    openAI?: boolean;
    actor?: (typeof TEST_USERS)[number];
  }) {
    const model = openAI ? OPENAI_MEAL_PHOTO_MODEL : "sample";
    const promptVersion = openAI ? OPENAI_MEAL_PHOTO_PROMPT_VERSION : "sample-ja-1";
    const { rows } = await database.query<{ result: { status: AnalysisStatus; result?: unknown } }>(
      "SELECT mille_meal_photo_analysis($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) AS result",
      [actor.id, actor.email, operation, workspaceId, photoId, model, promptVersion, lease, JSON.stringify(payload)],
    );
    return rows[0].result;
  }

  async function attempts() {
    const { rows } = await database.query<{ request_count: number }>(
      "SELECT request_count FROM mille_meal_photo_preview",
    );
    return rows[0]?.request_count;
  }

  return { database, storePhoto, command, attempts };
}

test("photo analysis leases suppress duplicate jobs, preserve a cached result, and cascade on photo deletion", async t => {
  const { database, storePhoto, command } = await fixture(t);
  const { id: photoId, imageSha256 } = await storePhoto();
  const leases = [randomUUID(), randomUUID()];
  const starts = await Promise.all(leases.map(lease => command({ photoId, lease, payload: { imageSha256 } })));
  assert.deepEqual(starts.map(({ status }) => status).sort(), ["pending", "started"]);
  const lease = leases[starts.findIndex(({ status }) => status === "started")];
  const competingLease = leases.find(value => value !== lease);
  assert.ok(competingLease);

  assert.deepEqual(await command({ photoId, operation: "finish", lease: competingLease, payload: candidate }), { status: "pending" });
  assert.deepEqual(await command({ photoId, operation: "finish", lease, payload: candidate }), { status: "ready", result: candidate });
  assert.deepEqual(await command({ photoId, payload: { imageSha256 } }), { status: "ready", result: candidate });
  assert.deepEqual(await command({ photoId, actor: outsider, payload: { imageSha256 } }), { status: "missing" });

  assert.equal((await database.query("SELECT 1 FROM meal_photo_analyses WHERE photo_id = $1", [photoId])).rows.length, 1);
  await database.query("DELETE FROM meal_photos WHERE id = $1", [photoId]);
  assert.equal((await database.query("SELECT 1 FROM meal_photo_analyses WHERE photo_id = $1", [photoId])).rows.length, 0);
  assert.deepEqual(await command({ photoId, payload: { imageSha256 } }), { status: "missing" });
});

test("photo analysis rejects stale image bytes and supersedes an expired lease", async t => {
  const { database, storePhoto, command } = await fixture(t);
  const first = await storePhoto();
  await database.query("DELETE FROM meal_photos WHERE id = $1", [first.id]);
  const second = await storePhoto(first.id, secondImage);
  const photoId = second.id;
  assert.notEqual(first.imageSha256, second.imageSha256);
  assert.deepEqual(await command({ photoId, payload: { imageSha256: first.imageSha256 } }), { status: "missing" });
  assert.equal((await database.query("SELECT 1 FROM meal_photo_analyses WHERE photo_id = $1", [photoId])).rows.length, 0);

  const payload = { imageSha256: second.imageSha256 };
  const expired = randomUUID();
  assert.deepEqual(await command({ photoId, lease: expired, payload }), { status: "started" });
  await database.query("UPDATE meal_photo_analyses SET lease_expires_at = now() - interval '1 second' WHERE photo_id = $1", [photoId]);
  const active = randomUUID();
  assert.deepEqual(await command({ photoId, lease: active, payload }), { status: "started" });
  assert.deepEqual(await command({ photoId, lease: expired, operation: "finish", payload: candidate }), { status: "pending" });
  assert.deepEqual(await command({ photoId, lease: active, operation: "finish", payload: candidate }), { status: "ready", result: candidate });
});

test("the exact enabled Preview can reserve at most ten real photo-analysis calls", async t => {
  const { database, storePhoto, command, attempts } = await fixture(t);
  const { id: photoId, imageSha256 } = await storePhoto();
  const payload = { ...target, imageSha256 };
  assert.deepEqual(await command({ photoId, openAI: true, payload }), { status: "limited" });
  await database.query(`INSERT INTO mille_meal_photo_preview (environment_id, source_sha, deployment_id) VALUES ($1, $2, $3)`,
    [target.environmentId, target.sourceSha, target.deploymentId]);
  assert.deepEqual(await command({ photoId, openAI: true, payload }), { status: "limited" });
  await database.exec("UPDATE mille_meal_photo_preview SET enabled = TRUE");
  for (const mismatch of [
    { environmentId: "mille-pr-79" }, { sourceSha: "b".repeat(40) }, { deploymentId: "dpl_OtherPreview" },
  ]) {
    assert.deepEqual(await command({ photoId, openAI: true, payload: { ...payload, ...mismatch } }), { status: "limited" });
  }
  assert.equal(await attempts(), 0);

  for (let attempt = 1; attempt <= 10; attempt++) {
    const lease = randomUUID();
    assert.deepEqual(await command({ photoId, lease, openAI: true, payload }), { status: "started" });
    assert.deepEqual(await command({ photoId, openAI: true, payload }), { status: "pending" });
    assert.equal(await attempts(), attempt);
    if (attempt < 10) {
      assert.deepEqual(await command({ photoId, lease, openAI: true, operation: "fail", payload: {} }), { status: "released" });
    } else {
      assert.deepEqual(await command({ photoId, lease, openAI: true, operation: "finish", payload: candidate }), {
        status: "ready", result: candidate,
      });
    }
  }

  assert.deepEqual(await command({ photoId, openAI: true, payload }), { status: "ready", result: candidate });
  const next = await storePhoto();
  assert.deepEqual(await command({ photoId: next.id, openAI: true, payload: { ...target, imageSha256: next.imageSha256 } }),
    { status: "limited" });
  assert.equal(await attempts(), 10);
});
