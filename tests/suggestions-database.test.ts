import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { DatabaseRow, Query } from "../lib/server/database/client";
import type { DatabaseConfiguration } from "../lib/server/database/environment";
import { createMealRepository } from "../lib/server/meals";
import type { RecommendationContext, RecommendationProvider } from "../lib/server/suggestion-provider";
import { createSuggestionService, SuggestionDomainError } from "../lib/server/suggestions";
import type { SuggestionConditions } from "../lib/shared/suggestion-types";
import { TEST_USERS } from "../lib/shared/test-users";
import { migrationSql, repositoryMigrationSources, seedSql } from "../scripts/db/sql";

const [owner, member] = TEST_USERS;
const workspaceId = "family-workspace";
const otherWorkspaceId = "other-workspace";
const preview: DatabaseConfiguration = { mode: "hosted", url: "", host: "", environment: "preview", environmentId: "mille-preview" };
const conditions: SuggestionConditions = {
  mealDate: "2026-11-20", mealType: "DINNER", servings: 3,
  ingredients: ["玉ねぎ"], maxMinutes: 25, cuisine: "和食", request: "魚を使う",
};

const dish = (name: string) => ({
  name, servings: null, recipeText: null, recipeUrl: null,
  ingredients: [{ name: "玉ねぎ", amountText: "1/2", unit: "個" }],
});
const recommendations = (names = ["鮭の塩焼き", "味噌汁"]) => names.map(name => ({
  title: name, estimatedMinutes: 15, dishes: [dish(name)], reasons: ["試験用の候補"],
}));
const provider: RecommendationProvider = { model: "fixture", generate: async () => recommendations() };

async function fixture(t: TestContext, incremental = false) {
  const database = new PGlite();
  t.after(() => database.close());
  const query: Query = async <Row extends DatabaseRow>(statement: string, parameters?: unknown[]) =>
    (await database.query<Row>(statement, parameters)).rows;
  if (incremental) {
    await database.exec(migrationSql(preview, true, repositoryMigrationSources().filter(({ name }) => name < "005")));
  } else {
    await database.exec(migrationSql(preview, true));
  }
  await database.exec(seedSql(preview));
  await query("INSERT INTO workspaces (id, name, type, created_by) VALUES ($1, '家族', 'SHARED', $3), ($2, '個人用', 'PERSONAL', $3)",
    [workspaceId, otherWorkspaceId, owner.id]);
  await query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $3, 'OWNER'), ($1, $4, 'MEMBER'), ($2, $3, 'OWNER')",
    [workspaceId, otherWorkspaceId, owner.id, member.id]);
  return { database, query, meals: createMealRepository(query, owner) };
}

const expectCode = (code: string, currentVersion?: number) => (error: unknown) =>
  error instanceof SuggestionDomainError && error.code === code
  && (currentVersion === undefined || error.currentVersion === currentVersion);

test("suggestion history works after an incremental migration and contains only recent recorded dishes in the workspace", async t => {
  const { database, query, meals } = await fixture(t, true);
  const addMeal = (ws: string, mealDate: string, name: string) => meals.create(ws, {
    mealDate, mealType: "DINNER", servings: null, dishes: [dish(name)],
  });
  await addMeal(workspaceId, "2026-11-06", "二週間前の記録");
  await addMeal(workspaceId, "2026-11-17", "家族の記録");
  await addMeal(workspaceId, "2026-11-05", "期間外の料理");
  await addMeal(workspaceId, "2026-11-20", "対象当日の料理");
  await addMeal(otherWorkspaceId, "2026-11-15", "別ワークスペースの記録");
  await database.exec(migrationSql(preview));
  const ownerService = createSuggestionService(query, owner, provider);
  const planned = await ownerService.create(workspaceId, { ...conditions, mealDate: "2026-11-16" }, "plan-input");
  await ownerService.adopt(workspaceId, planned.data.id, {
    expectedVersion: 1, candidateId: planned.data.candidates[0].id,
  }, "adopt");

  const seen: RecommendationContext[] = [];
  const historyProvider: RecommendationProvider = {
    async generate(context) {
      seen.push(context);
      return recommendations();
    },
  };
  const service = createSuggestionService(query, member, historyProvider);
  const created = await service.create(workspaceId, conditions, "family");
  assert.equal(created.status, 201);
  assert.equal(created.data.request.status, "SUCCEEDED");
  assert.equal(created.data.version, 1);
  assert.deepEqual(created.data.conditions, conditions);
  assert.deepEqual(seen[0].recentDishes, ["家族の記録", "二週間前の記録"]);
  assert.equal(new Set(created.data.candidates.map(candidate => candidate.id)).size, 2);
  const isolated = await createSuggestionService(query, owner, historyProvider)
    .create(otherWorkspaceId, { ...conditions, mealDate: "2026-11-10" }, "isolated");
  assert.deepEqual(seen[1].recentDishes, []);
  await assert.rejects(service.get(otherWorkspaceId, isolated.data.id), expectCode("NOT_FOUND"));
  await assert.rejects(service.get(workspaceId, isolated.data.id), expectCode("NOT_FOUND"));
  const version = await query<{ status: string }>("SELECT status FROM meals WHERE meal_date = DATE '2026-11-17'");
  assert.equal(version[0].status, "RECORDED");
});

test("request replays never rerun a provider and failed revisions preserve confirmed candidates and input", async t => {
  const { query } = await fixture(t);
  const entered = Promise.withResolvers<RecommendationContext>();
  const complete = Promise.withResolvers<unknown>();
  let calls = 0;
  const service = createSuggestionService(query, owner, {
    model: "fixture-original", promptVersion: "original-1",
    async generate(context) {
      calls++;
      entered.resolve(context);
      return complete.promise;
    },
  });
  const first = service.create(workspaceId, conditions, "same-creation");
  await Promise.race([entered.promise, first]);
  const inProgress = await service.create(workspaceId, conditions, "same-creation");
  assert.equal(inProgress.status, 202);
  assert.equal(inProgress.data.version, 0);
  assert.equal(inProgress.data.request.status, "RUNNING");
  assert.deepEqual(await service.get(workspaceId, inProgress.data.id), inProgress.data);
  await assert.rejects(service.create(workspaceId, { ...conditions, cuisine: "洋食" }, "same-creation"),
    expectCode("IDEMPOTENCY_KEY_REUSED"));
  await assert.rejects(service.revise(workspaceId, inProgress.data.id, { expectedVersion: 0, message: "短く" }, "new"),
    expectCode("GENERATION_IN_PROGRESS"));
  complete.resolve(recommendations());
  const original = await first;
  assert.deepEqual(await service.create(workspaceId, conditions, "same-creation"), original);
  assert.equal(calls, 1);

  const failedService = createSuggestionService(query, member, {
    model: "fixture-failed", promptVersion: "failed-1", generate: async () => [{ title: "不完全" }],
  });
  const change = { expectedVersion: 1, message: "副菜だけ変えて" };
  const failed = await failedService.revise(workspaceId, original.data.id, change, "same-revision");
  assert.equal(failed.data.request.status, "FAILED");
  assert.equal(failed.data.request.failure, "INVALID_OUTPUT");
  assert.equal(failed.data.request.message, change.message);
  assert.equal(failed.data.version, 1);
  assert.deepEqual(failed.data.candidates, original.data.candidates);
  const changingService = createSuggestionService(query, member, {
    model: "fixture-revision", promptVersion: "revision-2",
    async generate(context) {
      assert.deepEqual(context.messages, [change.message]);
      assert.deepEqual(context.previousCandidates, original.data.candidates);
      return recommendations(["焼き魚", "冷ややっこ"]);
    },
  });
  assert.deepEqual(await changingService.revise(workspaceId, original.data.id, change, "same-revision"), failed);
  const revised = await changingService.revise(workspaceId, original.data.id, change, "successful-revision");
  assert.equal(revised.data.version, 2);
  assert.deepEqual(revised.data.messages, [change.message]);
  assert.equal(revised.data.candidates[0].title, "焼き魚");
  assert.deepEqual(await service.create(workspaceId, conditions, "same-creation"), original);
  await assert.rejects(service.revise(workspaceId, original.data.id, change, "stale-revision"), expectCode("VERSION_CONFLICT", 2));
  assert.deepEqual(await query("SELECT request_key, provider_model, prompt_version FROM meal_suggestion_requests ORDER BY request_key"), [
    { request_key: "same-creation", provider_model: "fixture-original", prompt_version: "original-1" },
    { request_key: "same-revision", provider_model: "fixture-failed", prompt_version: "failed-1" },
    { request_key: "successful-revision", provider_model: "fixture-revision", prompt_version: "revision-2" },
  ]);

  await query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [workspaceId, member.id]);
  await assert.rejects(changingService.revise(workspaceId, original.data.id, change, "successful-revision"), expectCode("NOT_FOUND"));
  await query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
  assert.deepEqual(await query("SELECT id FROM meal_suggestion_requests"), []);
});

test("timeouts and expired completion are recoverable, and authorization is checked again before saving", async t => {
  const { query } = await fixture(t);
  const slow = createSuggestionService(query, owner, { generate: () => new Promise(() => {}) }, 5);
  const timeout = await slow.create(workspaceId, conditions, "timed-out");
  assert.equal(timeout.data.request.failure, "TIMEOUT");

  const started = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<unknown>();
  const late = createSuggestionService(query, owner, {
    generate() {
      started.resolve();
      return complete.promise;
    },
  });
  const old = late.revise(workspaceId, timeout.data.id, { expectedVersion: 0, message: "第一案" }, "expired-revision");
  await Promise.race([started.promise, old]);
  await query("UPDATE meal_suggestion_requests SET lease_until = clock_timestamp() - interval '1 second' WHERE request_key = $1",
    ["expired-revision"]);
  assert.equal((await late.get(workspaceId, timeout.data.id)).request.status, "EXPIRED");

  const current = createSuggestionService(query, member, provider);
  const recovered = await current.revise(workspaceId, timeout.data.id, { expectedVersion: 0, message: "第二案" }, "new-revision");
  assert.equal(recovered.data.request.status, "SUCCEEDED");
  complete.resolve(recommendations(["古い応答", "古い副菜"]));
  assert.equal((await old).data.request.status, "EXPIRED");
  assert.deepEqual(await current.get(workspaceId, timeout.data.id), recovered.data);

  const revokedRequest = createSuggestionService(query, member, {
    async generate() {
      await query("UPDATE app_users SET is_enabled = false WHERE id = $1", [member.id]);
      return recommendations();
    },
  });
  await assert.rejects(revokedRequest.revise(workspaceId, timeout.data.id,
    { expectedVersion: 1, message: "残さない要望" }, "revoked-revision"), expectCode("UNAUTHENTICATED"));
  const retained = await late.get(workspaceId, timeout.data.id);
  assert.equal(retained.request.status, "RUNNING");
  assert.deepEqual(retained.candidates, recovered.data.candidates);
  assert.deepEqual(retained.messages, ["第二案"]);
});

test("adoption stores the selected candidate, honors revision and replacement versions, and replays once", async t => {
  const { query, meals } = await fixture(t);
  const service = createSuggestionService(query, owner, provider);
  const first = await service.create(workspaceId, conditions, "new");
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<unknown>();
  const revisionService = createSuggestionService(query, owner, {
    generate() {
      entered.resolve();
      return response.promise;
    },
  });
  const next = revisionService.revise(workspaceId, first.data.id,
    { expectedVersion: 1, message: "追加要望" }, "revised");
  await Promise.race([entered.promise, next]);
  try {
    await assert.rejects(service.adopt(workspaceId, first.data.id,
      { candidateId: first.data.candidates[1].id, expectedVersion: 1 }, "pending-adoption"),
    expectCode("GENERATION_IN_PROGRESS"));
  } finally {
    response.resolve(recommendations());
  }
  const second = await next;
  const id = first.data.id;
  const selected = second.data.candidates[1];
  const input = { candidateId: selected.id, expectedVersion: 2 };
  await assert.rejects(service.adopt(workspaceId, id, { candidateId: first.data.candidates[0].id, expectedVersion: 1 },
    "obsolete"), expectCode("VERSION_CONFLICT", 2));
  const writes = await Promise.all([
    service.adopt(workspaceId, id, input, "adopt"),
    service.adopt(workspaceId, id, input, "adopt"),
  ]);
  const [planned] = writes;
  assert.deepEqual(writes[1], planned);
  assert.equal(planned.status, "PLANNED");
  assert.equal(planned.mealDate, conditions.mealDate);
  assert.equal(planned.mealType, conditions.mealType);
  assert.equal(planned.servings, conditions.servings);
  assert.equal(planned.dishes[0].name, selected.dishes[0].name);
  assert.deepEqual(planned.dishes[0].ingredients.map(({ name, amountText, unit }) => ({ name, amountText, unit })),
    selected.dishes[0].ingredients);
  await assert.rejects(service.adopt(workspaceId, id, input, "different"), expectCode("SLOT_OCCUPIED"));
  await assert.rejects(service.adopt(workspaceId, id, {
    ...input, replaceMealId: "different-id", replaceVersion: planned.version, confirmReplacement: true,
  }, "wrong-id"), expectCode("VERSION_CONFLICT", planned.version));

  const different = second.data.candidates[0];
  const replaced = await service.adopt(workspaceId, id, {
    expectedVersion: 2, candidateId: different.id,
    replaceMealId: planned.id, replaceVersion: planned.version, confirmReplacement: true,
  }, "replace");
  assert.equal(replaced.id, planned.id);
  assert.equal(replaced.version, planned.version + 1);
  assert.equal(replaced.dishes[0].name, different.dishes[0].name);
  assert.deepEqual(await service.adopt(workspaceId, id, input, "adopt"), planned);

  const recorded = await meals.create(workspaceId, {
    mealDate: "2026-11-21", mealType: "DINNER", servings: null, dishes: [dish("手動記録")],
  });
  const forRecorded = await service.create(workspaceId, { ...conditions, mealDate: recorded.mealDate }, "recorded");
  await assert.rejects(service.adopt(workspaceId, forRecorded.data.id,
    { candidateId: forRecorded.data.candidates[0].id, expectedVersion: 1 }, "never-replace"), expectCode("SLOT_OCCUPIED"));
  assert.deepEqual(await meals.get(workspaceId, recorded.id), recorded);
});
