import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { DatabaseRow, Query } from "../lib/server/database/client";
import type { DatabaseConfiguration } from "../lib/server/database/environment";
import { createMealRepository, MealDomainError } from "../lib/server/meals";
import { createWorkspaceRepository } from "../lib/server/workspaces";
import { TEST_USERS } from "../lib/shared/test-users";
import { disableUserSql, migrationSql, seedSql } from "../scripts/db/sql";

const preview: DatabaseConfiguration = { mode: "hosted", url: "", host: "", environment: "preview", environmentId: "mille-preview" };
const [owner, member] = TEST_USERS;
const november = { from: "2026-11-01", to: "2026-12-01" };

type Repository = ReturnType<typeof createMealRepository>;
type Meal = Awaited<ReturnType<Repository["create"]>>;
type CreateInput = Parameters<Repository["create"]>[1];
type UpdateInput = Parameters<Repository["update"]>[2];

function mealInput(mealDate = "2026-11-10"): CreateInput {
  return {
    mealDate,
    mealType: "DINNER",
    servings: 2.25,
    dishes: [
      {
        name: "鮭のホイル焼き",
        servings: null,
        recipeText: "野菜を切る。\n包んで蒸し焼きにする。",
        recipeUrl: null,
        ingredients: [
          { name: "玉ねぎ", amountText: "1/2", unit: "個" },
          { name: "塩", amountText: "少々", unit: null },
          { name: "油", amountText: null, unit: null },
          { name: "胡椒", amountText: "0", unit: "g" },
        ],
      },
      {
        name: "スープ",
        servings: 0.5,
        recipeText: null,
        recipeUrl: "https://example.invalid/recipes/soup",
        ingredients: [{ name: "水", amountText: "200", unit: "ml" }],
      },
      { name: "ご飯", servings: null, recipeText: null, recipeUrl: null, ingredients: [] },
    ],
  };
}

function updateInput(meal: Meal): UpdateInput {
  return {
    mealDate: meal.mealDate,
    mealType: meal.mealType,
    servings: meal.servings,
    expectedVersion: meal.version,
    dishes: meal.dishes.map(({ id, name, servings, recipeText, recipeUrl, ingredients }) => ({
      id, name, servings, recipeText, recipeUrl,
      ingredients: ingredients.map(({ id, name, amountText, unit }) => ({ id, name, amountText, unit })),
    })),
  };
}

function domainError(status: number, code: MealDomainError["code"], currentVersion?: number) {
  return (failure: unknown) => {
    assert.ok(failure instanceof MealDomainError);
    assert.equal(failure.status, status);
    assert.equal(failure.code, code);
    assert.equal(failure.currentVersion, currentVersion);
    return true;
  };
}

async function fixture(t: TestContext) {
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec(migrationSql(preview, true));
  await database.exec(seedSql(preview));
  const query: Query = async <Row extends DatabaseRow>(text: string, parameters?: unknown[]) =>
    (await database.query<Row>(text, parameters)).rows;
  const ownerWorkspaces = createWorkspaceRepository(query, owner);
  const memberWorkspaces = createWorkspaceRepository(query, member);
  const { id: workspaceId } = await ownerWorkspaces.create({ name: "家族の献立", type: "SHARED" });
  const { token } = await ownerWorkspaces.invite(workspaceId, member.email);
  await memberWorkspaces.acceptInvite(token);
  return {
    database, query, workspaceId, ownerWorkspaces, memberWorkspaces,
    ownerMeals: createMealRepository(query, owner),
    memberMeals: createMealRepository(query, member),
  };
}

test("shared members can save and read meal details; date range summaries exclude recipes and ingredients", async t => {
  const { workspaceId, ownerMeals, memberMeals } = await fixture(t);
  assert.deepEqual(await memberMeals.list(workspaceId, november), []);
  const meal = await ownerMeals.create(workspaceId, mealInput());
  const minimal = await memberMeals.create(workspaceId, {
    mealDate: "2026-12-01", mealType: "BREAKFAST", dishes: [{ name: "みそ汁" }],
  });

  assert.equal(meal.workspaceId, workspaceId);
  assert.equal(meal.mealDate, "2026-11-10");
  assert.equal(meal.mealType, "DINNER");
  assert.equal(meal.status, "RECORDED");
  assert.equal(meal.servings, 2.25);
  assert.equal(meal.version, 1);
  assert.deepEqual(meal.updatedBy, { id: owner.id, name: owner.name });
  assert.ok(Number.isFinite(Date.parse(meal.updatedAt)));
  assert.equal(meal.dishes[0].recipeText, "野菜を切る。\n包んで蒸し焼きにする。");
  assert.equal(meal.dishes[1].recipeUrl, "https://example.invalid/recipes/soup");
  assert.equal(meal.dishes[1].servings, 0.5);
  assert.deepEqual(meal.dishes[0].ingredients.map(ingredient => ingredient.amountText), ["1/2", "少々", null, "0"]);
  assert.equal(minimal.servings, null);
  assert.equal(minimal.dishes[0].servings, null);
  assert.equal(minimal.dishes[0].recipeText, null);
  assert.equal(minimal.dishes[0].recipeUrl, null);
  assert.deepEqual(minimal.dishes[0].ingredients, []);
  assert.deepEqual(await memberMeals.get(workspaceId, meal.id), meal);
  assert.deepEqual(await memberMeals.list(workspaceId, november), [{
    ...meal,
    dishes: meal.dishes.map(({ id, position, name }) => ({ id, position, name })),
  }]);
  assert.deepEqual((await ownerMeals.list(workspaceId, { from: "2026-12-01", to: "2026-12-02" })).map(({ id }) => id), [minimal.id]);

  const lastDate = await ownerMeals.create(workspaceId, {
    mealDate: "9999-12-31", mealType: "DINNER", dishes: [{ name: "みそ汁" }],
  });
  const lastDay = await memberMeals.list(workspaceId, { from: "9999-12-31", to: "+010000-01-01" });
  assert.deepEqual(lastDay.map(({ id }) => id), [lastDate.id]);
});

test("each operation rechecks account identity and current membership and hides other workspaces' meals", async t => {
  const { database, query, workspaceId, ownerMeals, memberMeals, ownerWorkspaces } = await fixture(t);
  const { id: privateId } = await ownerWorkspaces.create({ name: "個人の献立", type: "PERSONAL" });
  const privateMeal = await ownerMeals.create(privateId, mealInput());
  const sharedMeal = await ownerMeals.create(workspaceId, mealInput());

  const notFound = domainError(404, "NOT_FOUND");
  await assert.rejects(memberMeals.list(privateId, november), notFound);
  await assert.rejects(memberMeals.get(privateId, privateMeal.id), notFound);
  await assert.rejects(memberMeals.get(workspaceId, privateMeal.id), notFound);
  await assert.rejects(memberMeals.create(privateId, mealInput("2026-11-11")), notFound);
  await assert.rejects(memberMeals.update(workspaceId, privateMeal.id, updateInput(privateMeal)), notFound);
  await assert.rejects(memberMeals.delete(workspaceId, privateMeal.id, { expectedVersion: privateMeal.version }), notFound);

  const wrongEmail = createMealRepository(query, { ...member, email: owner.email });
  await assert.rejects(wrongEmail.get(workspaceId, sharedMeal.id), domainError(401, "UNAUTHENTICATED"));
  await assert.rejects(wrongEmail.update(workspaceId, sharedMeal.id, updateInput(sharedMeal)), domainError(401, "UNAUTHENTICATED"));

  await database.query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [workspaceId, member.id]);
  await assert.rejects(memberMeals.get(workspaceId, sharedMeal.id), notFound);
  await assert.rejects(memberMeals.delete(workspaceId, sharedMeal.id, { expectedVersion: sharedMeal.version }), notFound);

  await database.exec(disableUserSql(preview, owner.id));
  await assert.rejects(ownerMeals.list(workspaceId, november), domainError(401, "UNAUTHENTICATED"));
  await assert.rejects(ownerMeals.update(workspaceId, sharedMeal.id, updateInput(sharedMeal)), domainError(401, "UNAUTHENTICATED"));
});

test("the production marker rejects preexisting test identities at the meal DB boundary", async t => {
  const { database, workspaceId, ownerMeals } = await fixture(t);
  const meal = await ownerMeals.create(workspaceId, mealInput());
  // Simulate a misconfigured marker in the disposable database only.
  await database.exec("UPDATE mille_environment SET environment = 'production', environment_id = 'mille-production'");
  await assert.rejects(ownerMeals.get(workspaceId, meal.id), domainError(401, "UNAUTHENTICATED"));
  await assert.rejects(ownerMeals.delete(workspaceId, meal.id, { expectedVersion: meal.version }), domainError(401, "UNAUTHENTICATED"));
});

test("full replacement keeps retained child IDs through reordering and removes omitted children", async t => {
  const { database, workspaceId, ownerMeals, memberMeals } = await fixture(t);
  const before = await ownerMeals.create(workspaceId, mealInput());
  const input = updateInput(before);
  const [fish, soup, rice] = input.dishes;
  const [onion, salt, oil, pepper] = fish.ingredients;
  const after = await memberMeals.update(workspaceId, before.id, {
    ...input,
    mealDate: "2026-11-11",
    servings: null,
    dishes: [
      soup,
      { ...fish, ingredients: [pepper, onion, salt, { name: "レモン", amountText: "1/4", unit: "個" }] },
      { name: "サラダ", servings: null, recipeText: null, recipeUrl: null, ingredients: [] },
    ],
  });

  assert.equal(after.id, before.id);
  assert.equal(after.mealDate, "2026-11-11");
  assert.equal(after.servings, null);
  assert.equal(after.version, before.version + 1);
  assert.deepEqual(after.updatedBy, { id: member.id, name: member.name });
  assert.deepEqual(after.dishes.map(dish => dish.position), [0, 1, 2]);
  assert.deepEqual(after.dishes.slice(0, 2).map(dish => dish.id), [soup.id, fish.id]);
  assert.notEqual(after.dishes[2].id, rice.id);
  const updatedIngredients = after.dishes[1].ingredients;
  assert.deepEqual(updatedIngredients.slice(0, 3).map(({ id }) => id), [pepper.id, onion.id, salt.id]);
  assert.deepEqual(updatedIngredients.map(({ amountText }) => amountText), ["0", "1/2", "少々", "1/4"]);
  assert.deepEqual((await database.query("SELECT id FROM meal_dishes WHERE id = $1", [rice.id])).rows, []);
  assert.deepEqual((await database.query("SELECT id FROM dish_ingredients WHERE id = $1", [oil.id])).rows, []);
  assert.deepEqual(await ownerMeals.get(workspaceId, before.id), after);

  await memberMeals.delete(workspaceId, after.id, { expectedVersion: after.version });
  await assert.rejects(ownerMeals.get(workspaceId, after.id), domainError(404, "NOT_FOUND"));
  assert.deepEqual((await database.query("SELECT id FROM meal_dishes")).rows, []);
  assert.deepEqual((await database.query("SELECT id FROM dish_ingredients")).rows, []);
});

test("the write command rejects foreign and duplicate child IDs before altering a meal", async t => {
  const { database, workspaceId, ownerMeals, memberMeals, memberWorkspaces } = await fixture(t);
  const { id: otherWorkspaceId } = await memberWorkspaces.create({ name: "別の献立", type: "PERSONAL" });
  const foreignMeal = await memberMeals.create(otherWorkspaceId, mealInput());
  const meal = await ownerMeals.create(workspaceId, mealInput());
  const update = updateInput(meal);
  const [fish, soup] = update.dishes;
  const inputs = [
    [{ ...fish, id: foreignMeal.dishes[0].id }],
    [{ ...fish, ingredients: [{ ...fish.ingredients[0], id: foreignMeal.dishes[0].ingredients[0].id }] }],
    [{ ...fish, ingredients: [soup.ingredients[0]] }],
    [fish, fish],
    [{ ...fish, ingredients: [fish.ingredients[0], fish.ingredients[0]] }],
  ];

  for (const dishes of inputs) {
    const { rows } = await database.query<{ result: { ok: boolean; status: number; code: string } }>(
      "SELECT mille_meal_command($1, $2, 'update', $3::jsonb) AS result",
      [owner.id, owner.email, JSON.stringify({ ...update, mealId: meal.id, workspaceId, dishes })],
    );
    assert.equal(rows[0].result.ok, false);
    assert.equal(rows[0].result.status, 400);
    assert.equal(rows[0].result.code, "INVALID_INPUT");
    assert.deepEqual(await ownerMeals.get(workspaceId, meal.id), meal);
  }
  assert.deepEqual(await memberMeals.get(otherWorkspaceId, foreignMeal.id), foreignMeal);
});

test("competing meal writes cannot claim the same slot or overwrite a newer version", async t => {
  const { workspaceId, ownerMeals, memberMeals } = await fixture(t);
  const attempts = await Promise.allSettled([
    ownerMeals.create(workspaceId, mealInput()),
    memberMeals.create(workspaceId, mealInput()),
  ]);
  const created = attempts.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  assert.equal(created.length, 1);
  const rejectedCreate = attempts.find(result => result.status === "rejected");
  assert.ok(rejectedCreate);
  domainError(409, "SLOT_OCCUPIED")(rejectedCreate.reason);

  const [meal] = created;
  const other = await ownerMeals.create(workspaceId, mealInput("2026-11-11"));
  const update = updateInput(meal);
  await assert.rejects(memberMeals.update(workspaceId, meal.id, { ...update, mealDate: other.mealDate }), domainError(409, "SLOT_OCCUPIED"));
  assert.deepEqual(await ownerMeals.get(workspaceId, meal.id), meal);
  assert.deepEqual(await ownerMeals.get(workspaceId, other.id), other);

  const updates = await Promise.allSettled([
    ownerMeals.update(workspaceId, meal.id, { ...update, servings: 1 }),
    memberMeals.update(workspaceId, meal.id, { ...update, servings: 3 }),
  ]);
  const updated = updates.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].version, meal.version + 1);
  const rejectedUpdate = updates.find(result => result.status === "rejected");
  assert.ok(rejectedUpdate);
  domainError(409, "VERSION_CONFLICT", updated[0].version)(rejectedUpdate.reason);
  await assert.rejects(memberMeals.delete(workspaceId, meal.id, { expectedVersion: meal.version }), domainError(409, "VERSION_CONFLICT", updated[0].version));
  assert.deepEqual(await memberMeals.get(workspaceId, meal.id), updated[0]);
});

test("a late child constraint failure rolls back the meal and all earlier child writes", async t => {
  const { database, workspaceId, ownerMeals, memberMeals } = await fixture(t);
  const meal = await ownerMeals.create(workspaceId, mealInput());
  await database.exec("ALTER TABLE dish_ingredients ADD CONSTRAINT fixture_ingredient_failure CHECK (name <> '失敗テスト用食材')");
  const rejectedIngredient = { name: "失敗テスト用食材", amountText: null, unit: null };
  const update = updateInput(meal);
  const [fish, soup] = update.dishes;
  await assert.rejects(memberMeals.update(workspaceId, meal.id, {
    ...update,
    mealDate: "2026-11-11",
    dishes: [{ ...fish, name: "更新テスト用料理" }, { ...soup, ingredients: [rejectedIngredient] }],
  }), /fixture_ingredient_failure/);
  assert.deepEqual(await ownerMeals.get(workspaceId, meal.id), meal);

  await assert.rejects(memberMeals.create(workspaceId, {
    ...mealInput("2026-11-11"),
    dishes: [
      { name: "先に保存する料理", ingredients: [{ name: "野菜" }] },
      { name: "保存に失敗する料理", ingredients: [rejectedIngredient] },
    ],
  }), /fixture_ingredient_failure/);
  assert.deepEqual((await ownerMeals.list(workspaceId, november)).map(({ id }) => id), [meal.id]);
  const { rows } = await database.query("SELECT (SELECT count(*)::int FROM meal_dishes) AS dishes, (SELECT count(*)::int FROM dish_ingredients) AS ingredients");
  assert.deepEqual(rows, [{ dishes: 3, ingredients: 5 }]);
});
