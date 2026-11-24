import { createHash, randomUUID } from "node:crypto";
import { mealIdSchema, mealIdempotencyKeySchema } from "../shared/meal-schemas";
import type { MealDetail } from "../shared/meal-types";
import {
  adoptSuggestionSchema, recommendationOutputSchema, reviseSuggestionSchema, suggestionConditionsSchema,
} from "../shared/suggestion-schemas";
import type {
  AdoptSuggestionInput, ReviseSuggestionInput, Suggestion, SuggestionCandidate, SuggestionConditions, SuggestionFailure, SuggestionMode,
} from "../shared/suggestion-types";
import type { AppUser } from "../shared/types";
import { verifiedDatabaseQuery, type Query } from "./database/client";
import { createGatewayRecommendationProvider } from "./suggestion-gateway";
import { canUseSuggestions, gatewayPreviewEnabled, gatewayPreviewTarget, reserveGatewayRequest } from "./suggestion-preview";
import { sampleRecommendationProvider, type RecommendationProvider } from "./suggestion-provider";
import { DomainError } from "./workspaces";

const suggestionErrorCodes = [
  "UNAUTHENTICATED", "NOT_FOUND", "INVALID_INPUT", "VERSION_CONFLICT",
  "IDEMPOTENCY_KEY_REUSED", "GENERATION_IN_PROGRESS", "SLOT_OCCUPIED",
] as const;
type SuggestionErrorCode = typeof suggestionErrorCodes[number];

export class SuggestionDomainError extends DomainError {
  constructor(
    status: number, public readonly code: SuggestionErrorCode | "MODE_CHANGED", message: string, public readonly currentVersion?: number,
  ) {
    super(status, message);
    this.name = "SuggestionDomainError";
  }
}

type GenerationResponse = { status: 200 | 201 | 202; data: Suggestion };
type GenerationOperation = "create" | "revise";
type Operation = GenerationOperation | "get" | "finish" | "adopt";
type DatabaseResult<T> = { ok: true; data: T; recentDishes?: string[] }
  | { ok: false; status: number; code: SuggestionErrorCode; error: string; currentVersion?: number };
type GenerationResult = { candidates: SuggestionCandidate[] } | { failure: SuggestionFailure };

export interface SuggestionService {
  create(workspaceId: string, input: SuggestionConditions, key: string): Promise<GenerationResponse>;
  get(workspaceId: string, suggestionId: string): Promise<Suggestion>;
  revise(workspaceId: string, suggestionId: string, input: ReviseSuggestionInput, key: string): Promise<GenerationResponse>;
  adopt(workspaceId: string, suggestionId: string, input: AdoptSuggestionInput, key: string): Promise<MealDetail>;
}

const command = "SELECT mille_suggestion_command($1,$2,$3,$4::jsonb) AS result";

function idempotencyFields(operation: Operation, payload: object, key: string) {
  return {
    requestKey: mealIdempotencyKeySchema.parse(key),
    requestHash: createHash("sha256").update(JSON.stringify([operation, payload])).digest("hex"),
  };
}

async function generateCandidates(
  provider: RecommendationProvider, suggestion: Suggestion, recentDishes: string[], timeoutMs: number,
): Promise<GenerationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException("Recommendation timed out", "TimeoutError")), timeoutMs);
  try {
    const timedOut = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    const { conditions, candidates, messages, request } = suggestion;
    const currentMessages = request.message ? [...messages, request.message] : messages;
    const output = await Promise.race([
      provider.generate({
        conditions, recentDishes, previousCandidates: candidates, messages: currentMessages.slice(-12),
      }, controller.signal),
      timedOut,
    ]);
    const parsed = recommendationOutputSchema.safeParse(output);
    if (!parsed.success) return { failure: "INVALID_OUTPUT" };
    return { candidates: parsed.data.map(candidate => ({ ...candidate, id: randomUUID() })) };
  } catch {
    return { failure: controller.signal.aborted ? "TIMEOUT" : "UNAVAILABLE" };
  } finally {
    clearTimeout(timeout);
  }
}

export function createSuggestionService(
  query: Query, user: AppUser, provider: RecommendationProvider, timeoutMs = 25_000,
): SuggestionService {
  async function execute<T>(operation: Operation, workspaceId: string, payload: object) {
    if (!user.isEnabled) throw new SuggestionDomainError(401, "UNAUTHENTICATED", "ログインしてください。");
    const rows = await query<{ result: DatabaseResult<T> }>(command, [
      user.id, user.email.trim().toLowerCase(), operation,
      JSON.stringify({ ...payload, workspaceId: mealIdSchema.parse(workspaceId) }),
    ]);
    const result = rows[0]?.result;
    if (!result || typeof result.ok !== "boolean") throw new Error("Invalid suggestion database response");
    if (result.ok) return result;
    if (!suggestionErrorCodes.includes(result.code) || typeof result.error !== "string"
      || ![400, 401, 404, 409].includes(result.status)
      || (result.currentVersion !== undefined && (!Number.isSafeInteger(result.currentVersion) || result.currentVersion < 0))) {
      throw new Error("Invalid suggestion database error");
    }
    throw new SuggestionDomainError(result.status, result.code, result.error, result.currentVersion);
  }

  async function begin(operation: GenerationOperation, workspaceId: string, payload: object, key: string): Promise<GenerationResponse> {
    const result = await execute<Suggestion>(operation, workspaceId, {
      ...payload, ...idempotencyFields(operation, payload, key),
      providerModel: provider.model ?? "unknown", promptVersion: provider.promptVersion ?? "1",
    });
    if (result.recentDishes === undefined) {
      const status = result.data.request.status === "RUNNING" ? 202 : operation === "create" ? 201 : 200;
      return { status, data: result.data };
    }

    const generation = await generateCandidates(provider, result.data, result.recentDishes, timeoutMs);
    const completion = await execute<Suggestion>("finish", workspaceId, {
      suggestionId: result.data.id, requestId: result.data.request.id, ...generation,
    });
    return { status: operation === "create" ? 201 : 200, data: completion.data };
  }

  return {
    create: async (workspaceId, input, key) =>
      begin("create", workspaceId, { conditions: suggestionConditionsSchema.parse(input) }, key),
    get: async (workspaceId, suggestionId) =>
      (await execute<Suggestion>("get", workspaceId, { suggestionId: mealIdSchema.parse(suggestionId) })).data,
    revise: async (workspaceId, suggestionId, input, key) =>
      begin("revise", workspaceId, { suggestionId: mealIdSchema.parse(suggestionId), ...reviseSuggestionSchema.parse(input) }, key),
    async adopt(workspaceId, suggestionId, input, key) {
      const payload = { suggestionId: mealIdSchema.parse(suggestionId), ...adoptSuggestionSchema.parse(input) };
      return (await execute<MealDetail>("adopt", workspaceId, { ...payload, ...idempotencyFields("adopt", payload, key) })).data;
    },
  };
}

export async function getSuggestionService(user: AppUser, expectedMode?: SuggestionMode): Promise<SuggestionService> {
  if (!canUseSuggestions(user)) throw new SuggestionDomainError(404, "NOT_FOUND", "献立提案を利用できません。");
  const { query, configuration } = await verifiedDatabaseQuery();
  if (expectedMode === undefined) return createSuggestionService(query, user, sampleRecommendationProvider);

  const target = gatewayPreviewTarget(configuration);
  const activeTarget = target && await gatewayPreviewEnabled(query, target) ? target : null;
  if (expectedMode !== (activeTarget ? "gateway" : "sample")) {
    throw new SuggestionDomainError(409, "MODE_CHANGED", "提案の試験設定が変わりました。画面を再読み込みしてください。");
  }
  if (!activeTarget) return createSuggestionService(query, user, sampleRecommendationProvider);

  const provider = createGatewayRecommendationProvider({
    getOidcToken: async () => {
      const { headers } = await import("next/headers");
      return (await headers()).get("x-vercel-oidc-token") ?? "";
    },
    fetch: async (input, options) => {
      options?.signal?.throwIfAborted();
      if (!await reserveGatewayRequest(query, activeTarget)) throw new Error("Gateway Preview の試験枠を利用できません。");
      options?.signal?.throwIfAborted();
      return fetch(input, options);
    },
    log: event => console.info("mille.suggestion.gateway", JSON.stringify(event)),
  });
  return createSuggestionService(query, user, provider);
}
