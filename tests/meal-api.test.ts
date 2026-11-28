import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { DatabaseRow, Query } from "../lib/server/database/client";
import type { DatabaseConfiguration } from "../lib/server/database/environment";
import { createMealHandlers } from "../lib/server/meal-http";
import { createMealRepository } from "../lib/server/meals";
import { createWorkspaceRepository } from "../lib/server/workspaces";
import type { DishSearchPage, MealDetail, MealSummary } from "../lib/shared/meal-types";
import { TEST_USERS } from "../lib/shared/test-users";
import type { AppUser } from "../lib/shared/types";
import { migrationSql, seedSql } from "../scripts/db/sql";

const origin = "https://mille.example.test";
const [owner, member] = TEST_USERS;

function get(workspaceId: string, path: string) {
  return new Request(`${origin}/api/workspaces/${workspaceId}/${path}`);
}

function write(
  workspaceId: string,
  path: string,
  method: "POST" | "PUT" | "DELETE",
  body: unknown,
  options: { key?: string; raw?: string; headers?: Record<string, string | null> } = {},
) {
  const headers = new Headers({
    Origin: origin,
    "Content-Type": "application/json",
    "Idempotency-Key": options.key ?? randomUUID(),
  });
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return new Request(`${origin}/api/workspaces/${workspaceId}/${path}`, {
    method, headers, body: options.raw ?? JSON.stringify(body),
  });
}

function assertPrivate(response: Response, status: number) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0, must-revalidate");
  assert.equal(response.headers.get("vary"), "Cookie");
}

async function expectError(response: Response, status: number, code: string, currentVersion?: number) {
  assertPrivate(response, status);
  const body = await response.json();
  assert.equal(body.code, code);
  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0);
  assert.equal(typeof body.requestId, "string");
  assert.ok(body.requestId.length > 0);
  assert.equal(body.currentVersion, currentVersion);
  return body;
}

async function expectMeal(response: Response, status: number) {
  assertPrivate(response, status);
  const { meal } = await response.json() as { meal: MealDetail };
  assert.ok(meal.id);
  return meal;
}

const minimalMeal = { mealDate: "2026-11-10", mealType: "DINNER", dishes: [{ name: "鮭" }] };

test("meal HTTP rejects inactive sessions, disallowed origins and invalid input before writing", async () => {
  let calls = 0;
  const query: Query = async () => { calls++; throw new Error("unexpected database query"); };
  function handlers(user: AppUser | null) {
    return createMealHandlers({
      getCurrentUser: async () => user,
      getRepository: async actor => createMealRepository(query, actor),
      environment: { AUTH_URL: origin },
    });
  }
  const workspaceId = "workspace-test";
  for (const actor of [null, { ...owner, isEnabled: false }]) {
    await expectError(await handlers(actor).list(get(workspaceId, "meals?from=2026-11-01&to=2026-12-01"), workspaceId), 401, "UNAUTHENTICATED");
  }
  const api = handlers(owner);
  const disallowedOrigins: Record<string, string | null>[] = [
    { Origin: null },
    { Origin: "https://elsewhere.example.test" },
    { "Sec-Fetch-Site": "cross-site" },
  ];
  for (const headers of disallowedOrigins) {
    const request = write(workspaceId, "meals", "POST", minimalMeal, { headers });
    await expectError(await api.create(request, workspaceId), 403, "ORIGIN_REJECTED");
  }
  for (const request of [
    write(workspaceId, "meals", "POST", minimalMeal, { headers: { "Idempotency-Key": null } }),
    write(workspaceId, "meals", "POST", minimalMeal, { key: "invalid,key" }),
    write(workspaceId, "meals", "POST", minimalMeal, { headers: { "Content-Type": "text/plain" } }),
    write(workspaceId, "meals", "POST", undefined, { raw: "{" }),
    write(workspaceId, "meals", "POST", { ...minimalMeal, mealDate: "2026-02-30" }),
    write(workspaceId, "meals", "POST", { ...minimalMeal, status: "PLANNED" }),
  ]) {
    await expectError(await api.create(request, workspaceId), 400, "INVALID_INPUT");
  }
  await expectError(await api.list(get(workspaceId, "meals?from=2026-01-01&to=2026-03-05"), workspaceId), 400, "INVALID_INPUT");
  await expectError(await api.search(get(workspaceId, "dish-search?q=鮭&q=塩"), workspaceId), 400, "INVALID_INPUT");
  await expectError(await api.search(get(workspaceId, "dish-search?q=鮭&by=recipe"), workspaceId), 400, "INVALID_INPUT");
  await expectError(await api.search(get(workspaceId, "dish-search?q=鮭&limit=51"), workspaceId), 400, "INVALID_INPUT");
  assert.equal(calls, 0);
});

test("meal HTTP enforces the actual JSON byte limit independently of Content-Length", async () => {
  const workspaceId = "workspace-test";
  const meal: MealDetail = {
    id: "meal-test", workspaceId, mealDate: minimalMeal.mealDate, mealType: "DINNER", servings: null,
    status: "RECORDED", version: 1, updatedBy: { id: owner.id, name: owner.name }, updatedAt: "2026-11-10T00:00:00.000Z",
    dishes: [{ id: "dish-test", name: "鮭", position: 0, servings: null, recipeText: null, recipeUrl: null, ingredients: [] }],
  };
  let calls = 0;
  const query: Query = async <Row extends DatabaseRow>() => {
    calls++;
    return [{ result: { ok: true, data: meal } }] as unknown as Row[];
  };
  const api = createMealHandlers({
    getCurrentUser: async () => owner,
    getRepository: async actor => createMealRepository(query, actor),
    environment: { AUTH_URL: origin },
  });
  const json = JSON.stringify(minimalMeal);
  const exactBody = json.padEnd(json.length + 256 * 1024 - Buffer.byteLength(json), " ");
  const exact = write(workspaceId, "meals", "POST", undefined, { raw: exactBody });
  assert.equal(exact.headers.get("content-length"), null);
  assert.deepEqual(await expectMeal(await api.create(exact, workspaceId), 201), meal);
  const lengthHeaders: Record<string, string>[] = [{}, { "Content-Length": "1" }];
  for (const headers of lengthHeaders) {
    const oversized = write(workspaceId, "meals", "POST", undefined, { raw: `${exactBody} `, headers });
    await expectError(await api.create(oversized, workspaceId), 413, "BODY_TOO_LARGE");
  }
  assert.equal(calls, 1);
});

test("meal HTTP through PGlite", async t => {
  const database = new PGlite();
  t.after(() => database.close());
  const preview: DatabaseConfiguration = { mode: "hosted", url: "", host: "", environment: "preview", environmentId: "mille-preview" };
  await database.exec(migrationSql(preview, true));
  await database.exec(seedSql(preview));
  const query: Query = async <Row extends DatabaseRow>(sql: string, parameters?: unknown[]) =>
    (await database.query<Row>(sql, parameters)).rows;
  const workspaces = createWorkspaceRepository(query, owner);
  const memberWorkspaces = createWorkspaceRepository(query, member);
  function handlers(actor: AppUser) {
    return createMealHandlers({
      getCurrentUser: async () => actor,
      getRepository: async user => createMealRepository(query, user),
      environment: { AUTH_URL: origin },
    });
  }
  const api = handlers(owner);
  const memberApi = handlers(member);

  async function sharedWorkspace(name: string) {
    const { id } = await workspaces.create({ name, type: "SHARED" });
    const { token } = await workspaces.invite(id, member.email);
    await memberWorkspaces.acceptInvite(token);
    return id;
  }

  await t.test("CRUD preserves list boundaries, version conflicts, and successful replays", async () => {
    const id = await sharedWorkspace("献立の登録と更新");
    const key = randomUUID();
    const input = {
      ...minimalMeal,
      dishes: [{ name: "  鮭  ", recipeText: "焼く", ingredients: [{ name: "塩", amountText: "少々" }] }],
    };
    const created = await expectMeal(await api.create(write(id, "meals", "POST", input, { key }), id), 201);
    const path = `meals/${created.id}`;
    assert.equal(created.dishes[0].name, "鮭");
    assert.equal(created.dishes[0].ingredients[0].amountText, "少々");
    assert.deepEqual(await expectMeal(await memberApi.get(get(id, path), id, created.id), 200), created);
    await expectError(await api.create(write(id, "meals", "POST", input), id), 409, "SLOT_OCCUPIED");
    await expectError(await api.create(write(id, "meals", "POST", { ...input, servings: 2 }, { key }), id), 409, "IDEMPOTENCY_KEY_REUSED");

    const sameRangeEnd = { ...minimalMeal, mealDate: "2026-11-11" };
    const other = await expectMeal(await api.create(write(id, "meals", "POST", sameRangeEnd), id), 201);
    const listResponse = await memberApi.list(get(id, "meals?from=2026-11-10&to=2026-11-11"), id);
    assertPrivate(listResponse, 200);
    const { meals } = await listResponse.json() as { meals: MealSummary[] };
    assert.deepEqual(meals.map(meal => meal.id), [created.id]);
    const { id: dishId, position, name } = created.dishes[0];
    assert.deepEqual(meals[0].dishes, [{ id: dishId, position, name }]);

    const update = {
      ...minimalMeal, expectedVersion: created.version, servings: 2,
      dishes: [{ id: dishId, name, servings: null, recipeText: "焼く", recipeUrl: null, ingredients: created.dishes[0].ingredients }],
    };
    const move = write(id, path, "PUT", { ...update, mealDate: other.mealDate });
    await expectError(await memberApi.update(move, id, created.id), 409, "SLOT_OCCUPIED");
    const updateKey = randomUUID();
    const updated = await expectMeal(await memberApi.update(write(id, path, "PUT", update, { key: updateKey }), id, created.id), 200);
    assert.equal(updated.version, 2);
    assert.equal(updated.updatedBy.id, member.id);
    assert.deepEqual(await expectMeal(await memberApi.update(write(id, path, "PUT", update, { key: updateKey }), id, created.id), 200), updated);
    await expectError(await api.update(write(id, path, "PUT", update), id, created.id), 409, "VERSION_CONFLICT", 2);

    const equivalent = { ...input, servings: null, dishes: [{ ...input.dishes[0], name, servings: null, recipeUrl: null }] };
    assert.deepEqual(await expectMeal(await api.create(write(id, "meals", "POST", equivalent, { key }), id), 201), created);
    await expectError(await api.remove(write(id, path, "DELETE", { expectedVersion: 1 }), id, created.id), 409, "VERSION_CONFLICT", 2);

    const deleteKey = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      const request = write(id, path, "DELETE", { expectedVersion: 2 }, { key: deleteKey });
      const response = await api.remove(request, id, created.id);
      assertPrivate(response, 204);
      assert.equal(await response.text(), "");
    }
    await expectError(await api.get(get(id, path), id, created.id), 404, "NOT_FOUND");
  });

  await t.test("whole-meal copies keep the original and search pages bind workspace and query", async () => {
    const id = await sharedWorkspace("献立のコピーと検索");
    const privateWorkspace = await workspaces.create({ name: "別の献立", type: "PERSONAL" });
    const queryText = "%_\\";
    const input = {
      ...minimalMeal,
      dishes: [
        { name: `鮭${queryText}レシピ`, ingredients: [{ name: "塩", amountText: "少々" }] },
        { name: "鮭のレシピ" },
      ],
    };
    const source = await expectMeal(await api.create(write(id, "meals", "POST", input), id), 201);
    const path = `meals/${source.id}/copies`;
    const copyInput = { sourceVersion: 1, targetDate: "2026-11-12", targetMealType: "LUNCH" };
    const key = randomUUID();
    await expectError(await memberApi.copy(write(id, path, "POST", { ...copyInput, sourceVersion: 2 }), id, source.id), 409, "VERSION_CONFLICT", 1);
    const copied = await expectMeal(await memberApi.copy(write(id, path, "POST", copyInput, { key }), id, source.id), 201);
    assert.equal(copied.mealDate, "2026-11-12");
    assert.equal(copied.mealType, "LUNCH");
    assert.notEqual(copied.id, source.id);
    assert.notEqual(copied.dishes[0].id, source.dishes[0].id);
    assert.notEqual(copied.dishes[0].ingredients[0].id, source.dishes[0].ingredients[0].id);
    assert.equal(copied.dishes[0].ingredients[0].amountText, "少々");
    assert.deepEqual(await expectMeal(await memberApi.copy(write(id, path, "POST", copyInput, { key }), id, source.id), 201), copied);
    await expectError(await memberApi.copy(write(id, path, "POST", copyInput), id, source.id), 409, "SLOT_OCCUPIED");
    assert.deepEqual(await expectMeal(await api.get(get(id, `meals/${source.id}`), id, source.id), 200), source);

    const searchPath = `dish-search?${new URLSearchParams({ q: queryText, limit: "1" })}`;
    const firstResponse = await memberApi.search(get(id, searchPath), id);
    assertPrivate(firstResponse, 200);
    const first = await firstResponse.json() as DishSearchPage;
    assert.deepEqual(first.items.map(item => item.dishId), [copied.dishes[0].id]);
    assert.ok(first.nextCursor);
    const cursor = encodeURIComponent(first.nextCursor);
    const secondResponse = await memberApi.search(get(id, `${searchPath}&cursor=${cursor}`), id);
    assertPrivate(secondResponse, 200);
    const second = await secondResponse.json() as DishSearchPage;
    assert.deepEqual(second.items.map(item => item.dishId), [source.dishes[0].id]);
    assert.equal(second.nextCursor, null);
    const explicitName = await memberApi.search(get(id, `${searchPath}&by=name&cursor=${cursor}`), id);
    assertPrivate(explicitName, 200);
    assert.deepEqual(await explicitName.json(), second);
    await expectError(await memberApi.search(get(id, `${searchPath}&by=ingredient&cursor=${cursor}`), id), 400, "INVALID_INPUT");
    const badCursor = Buffer.from("[]").toString("base64url");
    await expectError(await memberApi.search(get(id, `${searchPath}&cursor=${badCursor}`), id), 400, "INVALID_INPUT");
    await expectError(await memberApi.search(get(id, `dish-search?q=鮭&cursor=${cursor}`), id), 400, "INVALID_INPUT");
    await expectError(await api.search(get(privateWorkspace.id, `${searchPath}&cursor=${cursor}`), privateWorkspace.id), 400, "INVALID_INPUT");
    await expectError(await memberApi.search(get(privateWorkspace.id, searchPath), privateWorkspace.id), 404, "NOT_FOUND");
    await expectError(await api.get(get(privateWorkspace.id, `meals/${source.id}`), privateWorkspace.id, source.id), 404, "NOT_FOUND");

    await database.query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [id, member.id]);
    await expectError(await memberApi.copy(write(id, path, "POST", copyInput, { key }), id, source.id), 404, "NOT_FOUND");
  });

  await t.test("ingredient search returns one result per recorded dish and keeps pagination scoped", async () => {
    const id = await sharedWorkspace("食材の検索");
    const other = await workspaces.create({ name: "別の食材", type: "PERSONAL" });
    const keyword = "ねぎ%_\\";
    const input = {
      ...minimalMeal,
      dishes: [
        { name: "冷ややっこ", ingredients: [{ name: `青${keyword}` }, { name: `青${keyword}の葉` }] },
        { name: `名前だけ${keyword}` },
        { name: "野菜炒め", ingredients: [{ name: "青ねぎABC" }] },
      ],
    };
    async function create(workspace: string, mealDate: string) {
      return expectMeal(await api.create(write(workspace, "meals", "POST", { ...input, mealDate }), workspace), 201);
    }
    const older = await create(id, "2026-11-10");
    const newer = await create(id, "2026-11-11");
    const plan = await create(id, "2026-11-12");
    await database.query("UPDATE meals SET status = 'PLANNED' WHERE id = $1", [plan.id]);
    await create(other.id, "2026-11-13");

    const ingredientPath = `dish-search?${new URLSearchParams({ q: keyword, by: "ingredient", limit: "1" })}`;
    const firstResponse = await memberApi.search(get(id, ingredientPath), id);
    assertPrivate(firstResponse, 200);
    const first = await firstResponse.json() as DishSearchPage;
    assert.deepEqual(first.items.map(({ dishId, mealDate }) => [dishId, mealDate]), [[newer.dishes[0].id, newer.mealDate]]);
    assert.ok(first.nextCursor);
    const pageTwo = `${ingredientPath}&cursor=${encodeURIComponent(first.nextCursor)}`;
    const secondResponse = await memberApi.search(get(id, pageTwo), id);
    assertPrivate(secondResponse, 200);
    const second = await secondResponse.json() as DishSearchPage;
    assert.deepEqual(second.items.map(({ dishId, mealDate }) => [dishId, mealDate]), [[older.dishes[0].id, older.mealDate]]);
    assert.equal(second.nextCursor, null);

    const namePath = pageTwo.replace("by=ingredient", "by=name");
    await expectError(await memberApi.search(get(id, namePath), id), 400, "INVALID_INPUT");
    await expectError(await api.search(get(other.id, pageTwo), other.id), 400, "INVALID_INPUT");
    await expectError(await memberApi.search(get(other.id, ingredientPath), other.id), 404, "NOT_FOUND");
    const names = await memberApi.search(get(id, ingredientPath.replace("by=ingredient", "by=name")), id);
    assertPrivate(names, 200);
    assert.deepEqual((await names.json() as DishSearchPage).items.map(item => item.dishId), [newer.dishes[1].id]);
  });

  await t.test("failed storage rolls back child writes and keeps the retry key available", async () => {
    const id = await sharedWorkspace("献立の保存失敗");
    const constraint = "fixture_http_ingredient_failure";
    await database.exec(`ALTER TABLE dish_ingredients ADD CONSTRAINT ${constraint} CHECK (name <> '失敗用')`);
    const key = randomUUID();
    const input = { ...minimalMeal, dishes: [{ name: "鮭" }, { name: "サラダ", ingredients: [{ name: "失敗用" }] }] };
    try {
      const failure = await expectError(await api.create(write(id, "meals", "POST", input, { key }), id), 500, "INTERNAL_ERROR");
      assert.ok(!JSON.stringify(failure).includes(constraint));
      const response = await api.list(get(id, "meals?from=2026-11-01&to=2026-12-01"), id);
      assertPrivate(response, 200);
      assert.deepEqual(await response.json(), { meals: [] });
    } finally {
      await database.exec(`ALTER TABLE dish_ingredients DROP CONSTRAINT ${constraint}`);
    }
    const retried = await expectMeal(await api.create(write(id, "meals", "POST", input, { key }), id), 201);
    assert.deepEqual(retried.dishes.map(dish => dish.name), ["鮭", "サラダ"]);
  });
});
