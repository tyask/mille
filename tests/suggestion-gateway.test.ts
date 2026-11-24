import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createGatewayRecommendationProvider, GATEWAY_RECOMMENDATION_MODEL, GATEWAY_RECOMMENDATION_PROMPT_VERSION,
  type GatewayRecommendationMetrics,
} from "../lib/server/suggestion-gateway";
import type { RecommendationContext } from "../lib/server/suggestion-provider";

const context: RecommendationContext = {
  conditions: {
    mealDate: "2026-11-24", mealType: "DINNER", servings: 2, maxMinutes: 20,
    ingredients: ["豆腐"], cuisine: "和食", request: "野菜をあわせたい",
  },
  recentDishes: ["焼き魚"],
  previousCandidates: [],
  messages: ["副菜はさっぱりしたもの"],
};
const rawCandidate = {
  title: "豆腐と小松菜の献立",
  estimatedMinutes: 15,
  dishes: [{
    name: "豆腐と小松菜の炒め物",
    ingredients: [{ name: "豆腐", amountText: "1", unit: "丁" }],
    recipeText: "材料を切り、フライパンで炒める。",
  }],
  reasons: ["希望の食材を使う和食です。"],
};
const verifiedGateway = {
  enabledZeroDataRetention: true,
  routing: {
    finalProvider: "openai",
    modelAttempts: [{
      providerAttempts: [{ provider: "openai", credentialType: "system", inferenceEndpoint: { scope: "zone", geoRegion: "jp" } }],
    }],
  },
  generationId: "gen_test123",
  cost: "0.0012",
};

function completion({
  content = JSON.stringify({ candidates: [rawCandidate, { ...rawCandidate, title: "豆腐の別献立" }] }),
  finishReason = "stop",
  gateway = verifiedGateway,
  model = GATEWAY_RECOMMENDATION_MODEL,
}: { content?: string; finishReason?: string; gateway?: unknown; model?: string } = {}) {
  return Response.json({
    model,
    choices: [{
      finish_reason: finishReason,
      message: { content, refusal: null, provider_metadata: { gateway } },
    }],
    usage: { prompt_tokens: 100, completion_tokens: 200 },
  });
}

function testProvider(fetch: typeof globalThis.fetch, tokens = "preview.oidc.token") {
  const events: GatewayRecommendationMetrics[] = [];
  const provider = createGatewayRecommendationProvider({
    getOidcToken: () => tokens,
    fetch,
    log: event => events.push(event),
  });
  return { provider, events };
}

test("Gateway pins the model, provider, Japan, and ZDR, and returns validated candidate data", async () => {
  const controller = new AbortController();
  let requests = 0;
  const { provider, events } = testProvider(async (url, init) => {
    requests++;
    assert.equal(url, "https://ai-gateway.vercel.sh/v1/chat/completions");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.signal, controller.signal);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer preview.oidc.token");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, GATEWAY_RECOMMENDATION_MODEL);
    assert.equal(body.max_completion_tokens, 2_000);
    assert.equal(body.stream, false);
    assert.equal(body.store, false);
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(body.response_format.json_schema.schema.required, ["candidates"]);
    assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
    assert.deepEqual(body.providerOptions, {
      gateway: { only: ["openai"], inferenceRegion: { scope: "zone", geoRegion: "jp" }, zeroDataRetention: true },
    });
    assert.equal(body.tools, undefined);
    assert.equal(body.models, undefined);
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[1].role, "user");
    assert.deepEqual(JSON.parse(body.messages[1].content), context);
    return completion();
  });

  assert.equal(provider.model, GATEWAY_RECOMMENDATION_MODEL);
  assert.equal(provider.promptVersion, GATEWAY_RECOMMENDATION_PROMPT_VERSION);
  assert.deepEqual(await provider.generate(context, controller.signal), [
    { ...rawCandidate, dishes: [{ ...rawCandidate.dishes[0], servings: null, recipeUrl: null }] },
    { ...rawCandidate, title: "豆腐の別献立", dishes: [{ ...rawCandidate.dishes[0], servings: null, recipeUrl: null }] },
  ]);
  assert.equal(requests, 1);
  const [{ elapsedMs, ...event }] = events;
  assert.ok(elapsedMs >= 0);
  assert.deepEqual(event, {
    model: GATEWAY_RECOMMENDATION_MODEL, promptVersion: GATEWAY_RECOMMENDATION_PROMPT_VERSION,
    result: "success", provider: "openai", credentialType: "system", region: "jp", zeroDataRetention: true, httpStatus: 200,
    generationId: "gen_test123", costUsd: "0.0012", inputTokens: 100, outputTokens: 200,
  });
});

test("Gateway bounds the allowlisted input and sends only concise candidate summaries", async () => {
  const conditions = { ...context.conditions, privateEmail: "private@example.invalid" };
  const candidate = {
    id: "private-candidate-id",
    title: "豆".repeat(150),
    estimatedMinutes: 15,
    dishes: Array.from({ length: 5 }, () => ({
      name: "野".repeat(120),
      servings: 2,
      recipeText: "private-recipe",
      recipeUrl: "https://example.invalid/private",
      ingredients: Array.from({ length: 8 }, () => ({
        name: "菜".repeat(70), amountText: "private-amount", unit: "杯",
      })),
    })),
    reasons: ["private-reason"],
  };
  const lastMessage = "要".repeat(1_050);
  const extended: RecommendationContext = {
    conditions,
    recentDishes: Array.from({ length: 30 }, () => "煮".repeat(80)),
    previousCandidates: Array.from({ length: 4 }, () => candidate),
    messages: ["outdated-message", "第一", "第二", lastMessage],
  };
  const { provider } = testProvider(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const content: string = body.messages[1].content;
    const input = JSON.parse(content);
    assert.doesNotMatch(content, /private|outdated-message/u);
    assert.deepEqual(input.messages, ["第一", "第二", "要".repeat(1_000)]);
    assert.equal(input.recentDishes.length, 24);
    assert.equal(input.recentDishes[0], "煮".repeat(60));
    assert.equal(input.previousCandidates.length, 3);
    assert.equal(input.previousCandidates[0].title, "豆".repeat(80));
    assert.equal(input.previousCandidates[0].dishes.length, 3);
    assert.deepEqual(input.previousCandidates[0].dishes[0], {
      name: "野".repeat(80), ingredients: Array.from({ length: 5 }, () => "菜".repeat(40)),
    });
    return completion();
  });

  assert.ok(await provider.generate(extended));
});

test("Gateway rejects unverified routing and malformed output while retaining safe usage", async () => {
  const wrongRegion = {
    ...verifiedGateway,
    routing: {
      ...verifiedGateway.routing,
      modelAttempts: [{
        providerAttempts: [{ provider: "openai", credentialType: "system", inferenceEndpoint: { scope: "zone", geoRegion: "us" } }],
      }],
    },
  };
  const byok = {
    ...verifiedGateway,
    routing: {
      ...verifiedGateway.routing,
      modelAttempts: [{ providerAttempts: [{ ...verifiedGateway.routing.modelAttempts[0].providerAttempts[0], credentialType: "byok" }] }],
    },
  };
  const scenarios = [
    { response: completion({ gateway: wrongRegion }), verified: false },
    { response: completion({ gateway: byok }), verified: false },
    { response: completion({ gateway: { ...verifiedGateway, enabledZeroDataRetention: false } }), verified: false },
    { response: completion({ gateway: undefined, model: "unknown-model" }), verified: false },
    { response: completion({ content: "<unvalidated provider output>" }), verified: true },
    { response: completion({ content: JSON.stringify({ candidates: [rawCandidate] }) }), verified: true },
    { response: completion({ finishReason: "length" }), verified: true },
  ];
  for (const { response, verified } of scenarios) {
    const { provider, events } = testProvider(async () => response);
    assert.equal(await provider.generate(context), undefined);
    assert.equal(events[0].result, "invalid_output");
    assert.equal(events[0].inputTokens, 100);
    assert.equal(events[0].outputTokens, 200);
    assert.equal(events[0].region, verified ? "jp" : undefined);
    assert.doesNotMatch(JSON.stringify(events), /unvalidated|unknown-model|豆腐/u);
  }
});

test("Gateway bounds the response and keeps remote errors and credentials out of logs", async () => {
  let requests = 0;
  const oversized = testProvider(async () => {
    requests++;
    return new Response("x".repeat(64 * 1024 + 1));
  });
  assert.equal(await oversized.provider.generate(context), undefined);
  assert.equal(oversized.events[0].result, "invalid_output");

  const unauthorized = testProvider(async () => {
    requests++;
    return new Response("private-provider-message", { status: 403 });
  });
  await assert.rejects(unauthorized.provider.generate(context), { message: "献立提案サービスに接続できません。" });
  assert.equal(unauthorized.events[0].result, "unavailable");
  assert.equal(unauthorized.events[0].httpStatus, 403);
  assert.doesNotMatch(JSON.stringify(unauthorized.events), /private-provider-message|preview\.oidc\.token/u);

  const invalidToken = testProvider(async () => {
    requests++;
    return completion();
  }, "private-invalid-token");
  await assert.rejects(invalidToken.provider.generate(context), { message: "献立提案サービスに接続できません。" });
  assert.doesNotMatch(JSON.stringify(invalidToken.events), /private-invalid-token/u);
  assert.equal(requests, 2);
});

test("Gateway propagates cancellation and does not retry an aborted request", async () => {
  const controller = new AbortController();
  let requests = 0;
  const { provider, events } = testProvider(async (_url, init) => {
    requests++;
    assert.equal(init?.signal, controller.signal);
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      controller.abort(new Error("private-timeout-context"));
    });
  });

  await assert.rejects(provider.generate(context, controller.signal), { message: "献立提案サービスに接続できません。" });
  assert.equal(events[0].result, "timeout");
  assert.doesNotMatch(JSON.stringify(events), /private-timeout-context/u);
  await assert.rejects(provider.generate(context, controller.signal));
  assert.equal(requests, 1);
});

test("Gateway preserves a validated result if metrics logging fails", async () => {
  const provider = createGatewayRecommendationProvider({
    getOidcToken: () => "preview.oidc.token",
    fetch: async () => completion(),
    log: () => { throw new Error("log unavailable"); },
  });
  assert.ok(await provider.generate(context));
});
