import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import type { DatabaseRow, Query } from "../lib/server/database/client";
import type { DatabaseConfiguration } from "../lib/server/database/environment";
import { createMealPhotoRepository, MealPhotoDomainError, sanitizeMealPhoto } from "../lib/server/meal-photos";
import { createMealRepository, MealDomainError } from "../lib/server/meals";
import { createWorkspaceRepository } from "../lib/server/workspaces";
import { MEAL_PHOTO_CHUNK_BYTES, MEAL_PHOTO_MAX_BYTES, MEAL_PHOTO_STORED_BYTE_LIMIT } from "../lib/shared/meal-photo-types";
import type { MealDetail } from "../lib/shared/meal-types";
import { TEST_USERS } from "../lib/shared/test-users";
import { migrationSql, seedSql } from "../scripts/db/sql";

const [owner, member] = TEST_USERS;
const preview: DatabaseConfiguration = { mode: "hosted", url: "", host: "", environment: "preview", environmentId: "mille-preview" };
const mealInput = { mealType: "DINNER", mealDate: "2026-11-28", dishes: [{ name: "焼き野菜" }] } as const;

function smallPhoto() {
  return sharp({ create: { width: 16, height: 20, channels: 3, background: "orange" } }).png().toBuffer();
}

function photoError(status: number, code: MealPhotoDomainError["code"]) {
  return (error: unknown) => error instanceof MealPhotoDomainError && error.status === status && error.code === code;
}

function mealError(status: number, code: MealDomainError["code"]) {
  return (error: unknown) => error instanceof MealDomainError && error.status === status && error.code === code;
}

async function fixture(t: TestContext) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(migrationSql(preview, true));
  await db.exec(seedSql(preview));
  const query: Query = async <Row extends DatabaseRow>(statement: string, parameters?: unknown[]) =>
    (await db.query<Row>(statement, parameters)).rows;
  const workspaces = createWorkspaceRepository(query, owner);
  const memberWorkspaces = createWorkspaceRepository(query, member);
  const { id: workspaceId } = await workspaces.create({ name: "写真の記録", type: "SHARED" });
  const { id: privateWorkspaceId } = await workspaces.create({ name: "個人用", type: "PERSONAL" });
  const { token } = await workspaces.invite(workspaceId, member.email);
  await memberWorkspaces.acceptInvite(token);
  const photos = createMealPhotoRepository(query, owner);
  async function upload(scope = workspaceId, source?: Uint8Array) {
    const id = randomUUID();
    const bytes = source ?? await smallPhoto();
    await photos.create(scope, id, { size: bytes.byteLength });
    for (let offset = 0; offset < bytes.byteLength; offset += MEAL_PHOTO_CHUNK_BYTES) {
      await photos.writeChunk(scope, id, offset / MEAL_PHOTO_CHUNK_BYTES, bytes.subarray(offset, offset + MEAL_PHOTO_CHUNK_BYTES));
    }
    await photos.complete(scope, id);
    return id;
  }
  return { db, photos, memberPhotos: createMealPhotoRepository(query, member), workspaces, upload, workspaceId, privateWorkspaceId,
    meals: createMealRepository(query, owner), memberMeals: createMealRepository(query, member) };
}

function edit(meal: MealDetail, photoId?: string | null) {
  const [dish] = meal.dishes;
  return { mealDate: meal.mealDate, mealType: meal.mealType, servings: meal.servings, expectedVersion: meal.version,
    dishes: [{ id: dish.id, name: dish.name, servings: dish.servings, recipeText: dish.recipeText,
      recipeUrl: dish.recipeUrl, ingredients: dish.ingredients, photoId }],
  };
}

test("photo validation decodes JPEG, PNG and WebP, orients/resizes, and strips source metadata", async () => {
  const jpeg = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "gold" } })
    .jpeg().withMetadata({ orientation: 6 }).toBuffer();
  assert.ok((await sharp(jpeg).metadata()).exif);
  const result = await sanitizeMealPhoto(jpeg);
  assert.deepEqual([result.width, result.height], [800, 1600]);
  const derivative = await sharp(result.bytes).metadata();
  assert.equal(derivative.format, "webp");
  assert.equal(derivative.exif, undefined);
  assert.equal(derivative.xmp, undefined);
  assert.equal(derivative.orientation, undefined);
  assert.ok(result.bytes.byteLength <= MEAL_PHOTO_STORED_BYTE_LIMIT);
  const png = await smallPhoto();
  const webp = await sharp(png).webp().toBuffer();
  for (const source of [png, webp]) {
    const normalized = await sanitizeMealPhoto(source);
    assert.deepEqual([normalized.width, normalized.height], [16, 20]);
  }
});

test("photo validation rejects unsupported, truncated, oversized or over-dimensioned images", async () => {
  const gif = await sharp(await smallPhoto()).gif().toBuffer();
  const tooWide = await sharp({ create: { width: 4500, height: 4500, channels: 3, background: "white" } }).png().toBuffer();
  await assert.rejects(sanitizeMealPhoto(gif), photoError(422, "PHOTO_INVALID"));
  await assert.rejects(sanitizeMealPhoto((await smallPhoto()).subarray(0, 40)), photoError(422, "PHOTO_INVALID"));
  await assert.rejects(sanitizeMealPhoto(tooWide), photoError(422, "PHOTO_INVALID"));
  await assert.rejects(sanitizeMealPhoto(new Uint8Array(MEAL_PHOTO_MAX_BYTES + 1)), photoError(413, "BODY_TOO_LARGE"));
});

test("draft chunks retry without replacement and are removed after storage of a validated derivative", async t => {
  const { photos, memberPhotos, workspaceId, db } = await fixture(t);
  const source = await sharp(randomBytes(1024 * 768 * 3), { raw: { width: 1024, height: 768, channels: 3 } }).png().toBuffer();
  const id = randomUUID();
  const initial = await photos.create(workspaceId, id, { size: source.byteLength });
  assert.deepEqual(initial, { id, dishId: null, ready: false, width: null, height: null });
  assert.deepEqual(await photos.create(workspaceId, id, { size: source.byteLength }), initial);
  await assert.rejects(photos.create(workspaceId, id, { size: source.byteLength - 1 }), photoError(409, "PHOTO_CONFLICT"));
  await assert.rejects(photos.complete(workspaceId, id), photoError(409, "PHOTO_CONFLICT"));
  await assert.rejects(photos.writeChunk(workspaceId, id, 0, source.subarray(0, 42)), photoError(400, "INVALID_INPUT"));
  const first = source.subarray(0, MEAL_PHOTO_CHUNK_BYTES);
  await photos.writeChunk(workspaceId, id, 0, first);
  await photos.writeChunk(workspaceId, id, 0, first);
  await assert.rejects(photos.writeChunk(workspaceId, id, 0, Buffer.alloc(first.byteLength)), photoError(409, "PHOTO_CONFLICT"));
  await assert.rejects(memberPhotos.complete(workspaceId, id), photoError(404, "NOT_FOUND"));
  for (let offset = MEAL_PHOTO_CHUNK_BYTES; offset < source.byteLength; offset += MEAL_PHOTO_CHUNK_BYTES) {
    await photos.writeChunk(workspaceId, id, offset / MEAL_PHOTO_CHUNK_BYTES, source.subarray(offset, offset + MEAL_PHOTO_CHUNK_BYTES));
  }
  const completed = await photos.complete(workspaceId, id);
  assert.deepEqual(completed, { id, dishId: null, ready: true, width: 1024, height: 768 });
  assert.deepEqual(await photos.complete(workspaceId, id), completed);
  assert.deepEqual(await photos.create(workspaceId, id, { size: source.byteLength }), completed);
  assert.equal((await db.query<{ count: number }>("SELECT count(*)::int AS count FROM meal_photo_upload_chunks")).rows[0]?.count, 0);
  await assert.rejects(memberPhotos.read(workspaceId, id), photoError(404, "NOT_FOUND"));
  const image = await photos.read(workspaceId, id);
  assert.equal(image.contentType, "image/webp");
  assert.ok(image.bytes.byteLength <= MEAL_PHOTO_STORED_BYTE_LIMIT);
});

test("meal photo changes share the meal version, authorization, rollback and idempotency checks", async t => {
  const { db, photos, memberPhotos, workspaceId, privateWorkspaceId, meals, memberMeals, upload } = await fixture(t);
  const photoId = await upload();
  const create = { ...mealInput, dishes: [{ ...mealInput.dishes[0], photoId }] };
  const meal = await meals.create(workspaceId, create, "photo-create");
  assert.equal(meal.dishes[0].photoId, photoId);
  assert.deepEqual(await meals.create(workspaceId, create, "photo-create"), meal);
  assert.equal((await memberMeals.get(workspaceId, meal.id)).dishes[0].photoId, photoId);
  assert.equal((await memberPhotos.read(workspaceId, photoId)).contentType, "image/webp");
  await assert.rejects(photos.read(privateWorkspaceId, photoId), photoError(404, "NOT_FOUND"));
  await memberPhotos.remove(workspaceId, photoId);
  assert.equal((await photos.read(workspaceId, photoId)).contentType, "image/webp");

  const retained = await memberMeals.update(workspaceId, meal.id, edit(meal));
  assert.equal(retained.dishes[0].photoId, photoId);
  await assert.rejects(meals.update(workspaceId, meal.id, edit(meal, null)), mealError(409, "VERSION_CONFLICT"));
  const privatePhoto = await upload(privateWorkspaceId);
  await assert.rejects(meals.update(workspaceId, meal.id, edit(retained, privatePhoto)), mealError(404, "NOT_FOUND"));
  const replacement = await upload();
  await assert.rejects(memberMeals.update(workspaceId, meal.id, edit(retained, replacement)), mealError(404, "NOT_FOUND"));
  assert.deepEqual(await meals.get(workspaceId, meal.id), retained);
  const rewritten = await meals.update(workspaceId, meal.id, edit(retained, replacement), "photo-replace");
  assert.equal(rewritten.dishes[0].photoId, replacement);
  assert.deepEqual(await meals.update(workspaceId, meal.id, edit(retained, replacement), "photo-replace"), rewritten);
  await assert.rejects(photos.read(workspaceId, photoId), photoError(404, "NOT_FOUND"));

  await db.query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [workspaceId, member.id]);
  await assert.rejects(memberPhotos.read(workspaceId, replacement), photoError(404, "NOT_FOUND"));
  const detached = await meals.update(workspaceId, meal.id, edit(rewritten, null));
  assert.equal(detached.dishes[0].photoId, undefined);
  await assert.rejects(photos.read(workspaceId, replacement), photoError(404, "NOT_FOUND"));
});

test("invalid, expired, and workspace or dish-deleted photo data is removed", async t => {
  const { db, photos, workspaceId, meals, workspaces, upload } = await fixture(t);
  const invalid = randomUUID();
  await photos.create(workspaceId, invalid, { size: 5 });
  await photos.writeChunk(workspaceId, invalid, 0, Buffer.from("abcde"));
  await assert.rejects(photos.complete(workspaceId, invalid), photoError(422, "PHOTO_INVALID"));
  assert.equal((await db.query("SELECT id FROM meal_photos WHERE id = $1", [invalid])).rows.length, 0);

  const expired = randomUUID();
  await photos.create(workspaceId, expired, { size: 1 });
  await photos.writeChunk(workspaceId, expired, 0, Buffer.from("a"));
  await db.query("UPDATE meal_photos SET expires_at = now() - interval '1 second' WHERE id = $1", [expired]);
  await assert.rejects(photos.complete(workspaceId, expired), photoError(404, "NOT_FOUND"));
  const attached = await upload();
  assert.equal((await db.query("SELECT photo_id FROM meal_photo_upload_chunks WHERE photo_id = $1", [expired])).rows.length, 0);
  const meal = await meals.create(workspaceId, {
    ...mealInput, dishes: [{ ...mealInput.dishes[0], photoId: attached }, { name: "汁物" }],
  });
  const [, kept] = meal.dishes;
  const changed = await meals.update(workspaceId, meal.id, {
    ...edit(meal), dishes: [{ id: kept.id, name: kept.name, servings: null, recipeText: null, recipeUrl: null, ingredients: [] }],
  });
  await assert.rejects(photos.read(workspaceId, attached), photoError(404, "NOT_FOUND"));

  const another = await upload();
  const updated = await meals.update(workspaceId, meal.id, edit(changed, another));
  await meals.delete(workspaceId, meal.id, { expectedVersion: updated.version });
  await assert.rejects(photos.read(workspaceId, another), photoError(404, "NOT_FOUND"));
  await upload();
  await workspaces.delete(workspaceId, "写真の記録");
  assert.equal((await db.query("SELECT id FROM meal_photos WHERE workspace_id = $1", [workspaceId])).rows.length, 0);
});
