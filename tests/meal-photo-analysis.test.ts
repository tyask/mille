import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeMealPhotoWithOpenAI, OPENAI_MEAL_PHOTO_MODEL, OPENAI_MEAL_PHOTO_PROMPT_VERSION, sampleMealPhotoAnalysis,
} from "../lib/server/meal-photo-analysis";
import { mealPhotoAnalysisSchema } from "../lib/shared/meal-photo-analysis";
import { MEAL_PHOTO_STORED_BYTE_LIMIT } from "../lib/shared/meal-photo-types";

const testImage = "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+9imf/zAD5gB8wA/5gB/8zQzyUeOAAAA=";
const bytes = Buffer.from(testImage, "base64");
const testKey = "sk-proj-mock-vision-key";
const candidates = sampleMealPhotoAnalysis();
type AnalysisOptions = Parameters<typeof analyzeMealPhotoWithOpenAI>[1];
type AnalysisMetrics = Parameters<NonNullable<AnalysisOptions["log"]>>[0];

function completion(content: unknown = candidates, overrides: {
  model?: string;
  reason?: string;
  refusal?: string;
  requestId?: string;
} = {}) {
  return Response.json({
    model: overrides.model ?? OPENAI_MEAL_PHOTO_MODEL,
    choices: [{ finish_reason: overrides.reason ?? "stop", message: { content: JSON.stringify(content), refusal: overrides.refusal ?? null } }],
    usage: { prompt_tokens: 235, completion_tokens: 142 },
  }, { headers: { "x-request-id": overrides.requestId ?? "req_test" } });
}

function analysisWith(fetch: typeof globalThis.fetch, overrides?: Partial<AnalysisOptions>) {
  const metrics: AnalysisMetrics[] = [];
  const options = { getApiKey: () => testKey, fetch, log: (event: AnalysisMetrics) => metrics.push(event), ...overrides };
  return { analyze: (image = bytes) => analyzeMealPhotoWithOpenAI(image, options), metrics };
}

test("OpenAI photo analysis sends only one sanitized WebP with a bounded strict response contract", async () => {
  const { analyze, metrics } = analysisWith(async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    assert.equal(init?.method, "POST");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${testKey}`);
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.model, OPENAI_MEAL_PHOTO_MODEL);
    assert.equal(payload.store, false);
    assert.equal(payload.max_completion_tokens, 1_200);
    assert.equal(payload.stream, false);
    assert.equal(payload.messages[0].role, "system");
    assert.deepEqual(payload.messages.slice(1), [{
      role: "user", content: [{ type: "image_url", image_url: { url: `data:image/webp;base64,${testImage}` } }],
    }]);
    const schema = payload.response_format.json_schema.schema;
    assert.equal(payload.response_format.json_schema.strict, true);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ["dishes"]);
    assert.equal(schema.properties.dishes.maxItems, 4);
    assert.deepEqual(schema.properties.dishes.items.properties.ingredients.items.required, ["name", "amountText", "unit"]);
    assert.doesNotMatch(String(init.body), /workspaceId|actorId|dishId|mealId|sk-proj-/u);
    return completion();
  });

  assert.deepEqual(await analyze(), candidates);
  const [{ elapsedMs, ...event }] = metrics;
  assert.ok(elapsedMs >= 0);
  assert.deepEqual(event, {
    model: OPENAI_MEAL_PHOTO_MODEL, promptVersion: OPENAI_MEAL_PHOTO_PROMPT_VERSION,
    result: "success", httpStatus: 200, requestId: "req_test", inputTokens: 235, outputTokens: 142,
  });
});

test("photo analysis allows empty results and preserves quantities and unknown amounts", async () => {
  assert.deepEqual(mealPhotoAnalysisSchema.parse(candidates), candidates);
  assert.deepEqual(candidates.dishes[0].ingredients[1], { name: "塩", amountText: null, unit: null });
  assert.deepEqual(candidates.dishes[1].ingredients[0], { name: "玉ねぎ", amountText: "1/2", unit: "個" });
  const { analyze } = analysisWith(async () => completion({ dishes: [] }));
  assert.deepEqual(await analyze(), { dishes: [] });
});

test("photo analysis rejects refused, partial, oversized and unexpected structured output", async () => {
  const responses = [
    completion(candidates, { model: "unexpected-model" }),
    completion(candidates, { reason: "length" }),
    completion(candidates, { refusal: "provider-private-refusal" }),
    completion({ dishes: [{ name: "private-dish", ingredients: [{ name: "鮭", unit: "g" }] }] }),
    completion({ dishes: [{ name: "  ", ingredients: [] }] }),
    completion({ dishes: [{ name: "鮭\0", ingredients: [] }] }),
    completion({ dishes: new Array(5).fill(candidates.dishes[0]) }),
    completion({ dishes: [], metadata: "provider-private" }),
    new Response("x".repeat(64 * 1024 + 1)),
  ];
  for (const response of responses) {
    const { analyze, metrics } = analysisWith(async () => response);
    await assert.rejects(analyze(), { code: "invalid_output" });
    assert.equal(metrics[0].result, "invalid_output");
    assert.doesNotMatch(JSON.stringify(metrics), /private|unexpected-model|鮭/u);
  }
});

test("photo analysis does not call upstream with invalid images or credentials", async () => {
  let requests = 0;
  const request = async () => {
    requests++;
    return completion();
  };
  const { analyze } = analysisWith(request);
  await assert.rejects(analyze(Buffer.from("another format")), { code: "unavailable" });
  await assert.rejects(analyze(Buffer.alloc(MEAL_PHOTO_STORED_BYTE_LIMIT + 1)), { code: "unavailable" });
  const invalidKey = analysisWith(request, { getApiKey: () => "private-invalid-key" });
  await assert.rejects(invalidKey.analyze(), { code: "unavailable" });
  assert.equal(requests, 0);
  assert.doesNotMatch(JSON.stringify(invalidKey.metrics), /private-invalid-key/u);
});

test("photo analysis maps remote failures and cancellation without logging image data or replaying the request", async () => {
  const failed = analysisWith(async () => new Response("private-remote-body", {
    status: 429, headers: { "x-request-id": "private@example.invalid" },
  }));
  await assert.rejects(failed.analyze(), { code: "unavailable" });
  assert.equal(failed.metrics[0].httpStatus, 429);
  assert.equal(failed.metrics[0].requestId, undefined);

  const controller = new AbortController();
  let requests = 0;
  const cancelled = analysisWith(async (_url, init) => {
    requests++;
    controller.abort(new Error("private-reason"));
    init?.signal?.throwIfAborted();
    return completion();
  }, { signal: controller.signal });
  await assert.rejects(cancelled.analyze(), { code: "timeout" });
  assert.equal(requests, 1);
  assert.equal(cancelled.metrics[0].result, "timeout");
  assert.doesNotMatch(JSON.stringify([...failed.metrics, ...cancelled.metrics]), /private|UklGR|sk-proj/u);
});
