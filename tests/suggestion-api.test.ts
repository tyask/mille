import assert from "node:assert/strict";
import test from "node:test";
import { createMealHandlers } from "../lib/server/meal-http";
import type { MealRepository } from "../lib/server/meals";
import { SuggestionDomainError, type SuggestionService } from "../lib/server/suggestions";
import type { Suggestion, SuggestionConditions } from "../lib/shared/suggestion-types";
import { TEST_USERS } from "../lib/shared/test-users";

const origin = "https://mille.example.test";
const conditions: SuggestionConditions = {
  mealDate: "2026-11-24", mealType: "DINNER", servings: 2, ingredients: ["豆腐"],
  maxMinutes: 30, cuisine: "和食", request: "",
};
const suggestion: Suggestion = {
  id: "suggestion-1", version: 0, conditions, candidates: [], messages: [],
  request: { id: "request-1", status: "RUNNING", failure: null, message: null },
};
const sendKey = "request-key-1";

function request(body?: unknown, headers?: HeadersInit) {
  return new Request(`${origin}/api/workspaces/workspace-1/suggestions`, body === undefined ? undefined : {
    method: "POST", body: JSON.stringify(body),
    headers: headers ?? { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": sendKey },
  });
}

test("suggestion HTTP authenticates mutations, validates inputs and retains the generation result status", async () => {
  let calls = 0;
  const service: SuggestionService = {
    create: async (workspace, input, key) => {
      calls++;
      assert.equal(workspace, "workspace-1");
      assert.deepEqual(input, conditions);
      assert.equal(key, sendKey);
      return { status: 202, data: suggestion };
    },
    revise: async () => { throw new SuggestionDomainError(409, "VERSION_CONFLICT", "候補が更新されました。", 2); },
    get: async () => suggestion,
    adopt: async () => assert.fail("Invalid adoption should not reach the service"),
  };
  const dependencies = {
    getCurrentUser: async () => TEST_USERS[0],
    getRepository: async (): Promise<MealRepository> => assert.fail("Suggestion must not acquire a meal repository"),
    environment: { AUTH_URL: origin },
  };
  const api = createMealHandlers({ ...dependencies, getSuggestions: async () => service });
  const create = (value: Request) => api.createSuggestion(value, "workspace-1");
  const foreign = new Headers({ Origin: "https://other.example.test", "Content-Type": "application/json", "Idempotency-Key": sendKey });
  const missingKey = new Headers({ Origin: origin, "Content-Type": "application/json" });
  assert.equal((await create(request(conditions, foreign))).status, 403);
  assert.equal((await create(request(conditions, missingKey))).status, 400);
  assert.equal((await create(request({ ...conditions, workspaceId: "other" }))).status, 400);
  assert.equal((await create(request({ ...conditions, request: "a".repeat(16 * 1024) }))).status, 413);
  assert.equal((await api.adoptSuggestion(request({
    expectedVersion: 1, candidateId: "candidate-1", replaceVersion: 1, confirmReplacement: true,
  }), "workspace-1", suggestion.id)).status, 400);
  assert.equal(calls, 0);

  const response = await create(request({ ...conditions, ingredients: [" 豆腐 "] }));
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0, must-revalidate");
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.deepEqual(await response.json(), { suggestion });
  assert.equal(calls, 1);

  const conflict = await api.reviseSuggestion(request({ expectedVersion: 1, message: "時短で" }), "workspace-1", suggestion.id);
  assert.equal(conflict.status, 409);
  const failure = await conflict.json();
  assert.equal(failure.code, "VERSION_CONFLICT");
  assert.equal(failure.currentVersion, 2);
  assert.equal(typeof failure.requestId, "string");

  const unavailable = createMealHandlers(dependencies);
  assert.equal((await unavailable.getSuggestion(request(), "workspace-1", suggestion.id)).status, 404);
  const anonymous = createMealHandlers({ ...dependencies, getCurrentUser: async () => null });
  assert.equal((await anonymous.getSuggestion(request(), "workspace-1", suggestion.id)).status, 401);
});
