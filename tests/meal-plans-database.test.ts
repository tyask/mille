import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { DatabaseRow, Query } from "../lib/server/database/client";
import type { DatabaseConfiguration } from "../lib/server/database/environment";
import { createMealRepository, MealDomainError } from "../lib/server/meals";
import { createWorkspaceRepository } from "../lib/server/workspaces";
import { createMealSchema, type UpdateMealInput } from "../lib/shared/meal-schemas";
import type { MealDetail } from "../lib/shared/meal-types";
import { TEST_USERS } from "../lib/shared/test-users";
import { migrationSql, repositoryMigrationSources, seedSql } from "../scripts/db/sql";

const preview: DatabaseConfiguration = {
  mode: "hosted", url: "", host: "", environment: "preview", environmentId: "mille-preview",
};
const [owner, member] = TEST_USERS;
const november = { from: "2026-11-01", to: "2026-12-01" };
const plansMigration = "005_meal_plans.sql";

type AdoptionResult = { ok: true; data: MealDetail } | { ok: false; code: string; status: number };
type Replacement = { replaceMealId: string; replaceVersion: number };

function mealInput(mealDate = "2026-11-10", name = "鮭のホイル焼き") {
  return createMealSchema.parse({ mealDate, mealType: "DINNER", servings: 2, dishes: [{
    name, recipeText: "野菜と一緒に包んで焼く。", ingredients: [{ name: "玉ねぎ", amountText: "1/2", unit: "個" }],
  }] });
}

function editedMeal(meal: MealDetail): UpdateMealInput {
  return {
    mealDate: meal.mealDate, mealType: meal.mealType, servings: 3, expectedVersion: meal.version,
    dishes: meal.dishes.map(({ id, name, servings, recipeUrl, ingredients }) => ({
      id, name, servings, recipeUrl, ingredients, recipeText: "フライパンで焼く。",
    })),
  };
}

async function fixture(t: TestContext, beforePlans = false) {
  const database = new PGlite();
  t.after(() => database.close());
  const migrations = repositoryMigrationSources().filter(({ name }) => name <= plansMigration);
  assert.equal(migrations.at(-1)?.name, plansMigration);
  const initialMigrations = beforePlans ? migrations.slice(0, -1) : migrations;
  await database.exec(migrationSql(preview, true, initialMigrations));
  await database.exec(seedSql(preview));
  const query: Query = async <Row extends DatabaseRow>(text: string, parameters?: unknown[]) =>
    (await database.query<Row>(text, parameters)).rows;
  const ownerWorkspaces = createWorkspaceRepository(query, owner);
  const { id: workspaceId } = await ownerWorkspaces.create({ name: "家族の献立", type: "SHARED" });
  const { token } = await ownerWorkspaces.invite(workspaceId, member.email);
  await createWorkspaceRepository(query, member).acceptInvite(token);

  const adopt = async (
    input = mealInput(), replacement: Partial<Replacement> = {},
    actor: (typeof TEST_USERS)[number] = owner, workspace = workspaceId,
  ) => {
    const { rows } = await database.query<{ result: AdoptionResult }>(
      "SELECT mille_meal_adopt_plan($1, $2, $3::jsonb) AS result",
      [actor.id, actor.email, JSON.stringify({ ...input, ...replacement, workspaceId: workspace })],
    );
    return rows[0].result;
  };
  return {
    database, workspaceId, ownerWorkspaces, adopt,
    migrate: () => database.exec(migrationSql(preview, false, migrations)),
    ownerMeals: createMealRepository(query, owner), memberMeals: createMealRepository(query, member),
  };
}

function plannedMeal(result: AdoptionResult) {
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.data.status, "PLANNED");
  return result.data;
}

function adoptionError(result: AdoptionResult, status: number, code: string) {
  assert.ok(!result.ok, JSON.stringify(result));
  assert.equal(result.status, status);
  assert.equal(result.code, code);
}

function mealError(status: number, code: MealDomainError["code"], currentVersion?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof MealDomainError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    if (currentVersion !== undefined) assert.equal(error.currentVersion, currentVersion);
    return true;
  };
}

test("the incremental migration retains recorded meals and replays while excluding plans from dish search", async t => {
  const { workspaceId, ownerMeals, memberMeals, adopt, migrate } = await fixture(t, true);
  const recordedInput = mealInput("2026-11-09");
  const recorded = await ownerMeals.create(workspaceId, recordedInput, "old-create");
  assert.equal(recorded.status, "RECORDED");
  await migrate();
  assert.deepEqual(await memberMeals.get(workspaceId, recorded.id), recorded);
  assert.deepEqual(await ownerMeals.create(workspaceId, recordedInput, "old-create"), recorded);

  const planned = plannedMeal(await adopt());
  assert.deepEqual(await memberMeals.get(workspaceId, planned.id), planned);
  assert.deepEqual((await memberMeals.list(workspaceId, november)).map(({ status }) => status), ["RECORDED", "PLANNED"]);
  const edited = await memberMeals.update(workspaceId, planned.id, editedMeal(planned));
  assert.equal(edited.status, "PLANNED");
  assert.equal(edited.dishes[0].recipeText, "フライパンで焼く。");
  assert.deepEqual((await memberMeals.search(workspaceId, { q: "鮭" })).items.map(({ mealId }) => mealId), [recorded.id]);
  await assert.rejects(memberMeals.copy(workspaceId, edited.id, {
    sourceVersion: edited.version, targetDate: "2026-11-11", targetMealType: edited.mealType,
  }, "copy-plan"), mealError(409, "NOT_RECORDED"));
});

test("adoption only replaces the confirmed planned row and version, including after deletion and recreation", async t => {
  const { workspaceId, ownerWorkspaces, ownerMeals, memberMeals, adopt } = await fixture(t);
  const received = plannedMeal(await adopt());
  const confirmation = { replaceMealId: received.id, replaceVersion: received.version };
  const replacementInput = mealInput(received.mealDate, "肉じゃが");
  adoptionError(await adopt(replacementInput), 409, "SLOT_OCCUPIED");
  adoptionError(await adopt(replacementInput, { replaceVersion: received.version }), 400, "INVALID_INPUT");
  adoptionError(await adopt(replacementInput, { replaceMealId: received.id }), 400, "INVALID_INPUT");

  const replacement = plannedMeal(await adopt(replacementInput, confirmation, member));
  assert.equal(replacement.version, received.version + 1);
  assert.equal(replacement.updatedBy.id, member.id);
  assert.equal(replacement.dishes[0].name, "肉じゃが");
  adoptionError(await adopt(replacementInput, confirmation), 409, "VERSION_CONFLICT");

  await memberMeals.delete(workspaceId, replacement.id, { expectedVersion: replacement.version });
  adoptionError(await adopt(replacementInput, confirmation), 409, "VERSION_CONFLICT");
  const recreated = plannedMeal(await adopt());
  assert.notEqual(recreated.id, received.id);
  assert.equal(recreated.version, received.version);
  adoptionError(await adopt(replacementInput, confirmation), 409, "VERSION_CONFLICT");
  assert.deepEqual(await ownerMeals.get(workspaceId, recreated.id), recreated);

  const recorded = await ownerMeals.create(workspaceId, mealInput("2026-11-11"));
  adoptionError(await adopt(mealInput(recorded.mealDate), { replaceMealId: recorded.id, replaceVersion: recorded.version }), 409, "SLOT_OCCUPIED");
  assert.deepEqual(await ownerMeals.get(workspaceId, recorded.id), recorded);
  const { id: privateId } = await ownerWorkspaces.create({ name: "個人の献立", type: "PERSONAL" });
  adoptionError(await adopt(mealInput(), {}, member, privateId), 404, "NOT_FOUND");
});

test("recording commits the edited content and status together, replays once, and rejects stale writes", async t => {
  const { database, workspaceId, ownerMeals, memberMeals, adopt } = await fixture(t);
  const planned = plannedMeal(await adopt());
  const input = editedMeal(planned);
  await assert.rejects(memberMeals.record(workspaceId, planned.id, { ...input, mealDate: "2026-11-11" }, "record-meal"),
    mealError(400, "INVALID_INPUT"));
  await assert.rejects(memberMeals.record(workspaceId, planned.id, { ...input, mealType: "LUNCH" }, "record-meal"),
    mealError(400, "INVALID_INPUT"));
  assert.deepEqual(await ownerMeals.get(workspaceId, planned.id), planned);
  await database.exec("ALTER TABLE meal_command_requests ADD CONSTRAINT reject_record_key CHECK (request_key <> 'rejected-record')");
  await assert.rejects(memberMeals.record(workspaceId, planned.id, input, "rejected-record"), /reject_record_key/);
  assert.deepEqual(await ownerMeals.get(workspaceId, planned.id), planned);

  const [recorded, replay] = await Promise.all([
    memberMeals.record(workspaceId, planned.id, input, "record-meal"),
    memberMeals.record(workspaceId, planned.id, input, "record-meal"),
  ]);
  assert.deepEqual(replay, recorded);
  assert.equal(recorded.id, planned.id);
  assert.equal(recorded.status, "RECORDED");
  assert.equal(recorded.version, planned.version + 1);
  assert.equal(recorded.updatedBy.id, member.id);
  assert.equal(recorded.servings, 3);
  assert.equal(recorded.dishes[0].id, planned.dishes[0].id);
  assert.equal(recorded.dishes[0].recipeText, "フライパンで焼く。");
  assert.deepEqual((await ownerMeals.search(workspaceId, { q: "鮭" })).items.map(({ mealId }) => mealId), [recorded.id]);
  await assert.rejects(ownerMeals.record(workspaceId, planned.id, input, "stale-record"), mealError(409, "VERSION_CONFLICT", recorded.version));
  await assert.rejects(ownerMeals.record(workspaceId, planned.id, editedMeal(recorded), "another-record"), mealError(409, "NOT_PLANNED"));
  await assert.rejects(memberMeals.record(workspaceId, planned.id, { ...input, servings: 4 }, "record-meal"), mealError(409, "IDEMPOTENCY_KEY_REUSED"));

  await database.query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [workspaceId, member.id]);
  await assert.rejects(memberMeals.record(workspaceId, planned.id, input, "record-meal"), mealError(404, "NOT_FOUND"));
  assert.deepEqual(await ownerMeals.get(workspaceId, recorded.id), recorded);
});
