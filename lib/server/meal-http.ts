import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  copyMealSchema, createMealSchema, deleteMealSchema, dishSearchSchema,
  mealIdempotencyKeySchema, mealRangeSchema, updateMealSchema,
} from "../shared/meal-schemas";
import { adoptSuggestionSchema, reviseSuggestionSchema, suggestionConditionsSchema } from "../shared/suggestion-schemas";
import type { AppUser } from "../shared/types";
import { isTestAuthEnabled } from "./auth/auth-mode";
import { getMealRepository, MealDomainError, type MealRepository } from "./meals";
import { getSuggestionService, SuggestionDomainError, type SuggestionService } from "./suggestions";
import { assertWorkspaceSameOrigin, privateApiHeaders, readWorkspaceJson } from "./workspace-http";
import { DomainError } from "./workspaces";

const mealBodyLimit = 256 * 1024;
const suggestionBodyLimit = 16 * 1024;
const requestErrorCodes: Readonly<Record<number, string>> = {
  400: "INVALID_INPUT",
  403: "ORIGIN_REJECTED",
  413: "BODY_TOO_LARGE",
};

type MealApiDependencies = {
  getCurrentUser: () => Promise<AppUser | null>;
  getRepository: (user: AppUser) => Promise<MealRepository>;
  getSuggestions?: (user: AppUser) => Promise<SuggestionService>;
  environment?: Readonly<Record<string, string | undefined>>;
};

function queryInput(request: Request): Record<string, string> {
  const entries = Array.from(new URL(request.url).searchParams);
  if (new Set(entries.map(([key]) => key)).size !== entries.length) {
    throw new DomainError(400, "同じ検索条件は一度だけ指定してください。");
  }
  return Object.fromEntries(entries);
}

function searchInput(request: Request) {
  const { limit, ...query } = queryInput(request);
  if (limit !== undefined && !/^\d{1,2}$/.test(limit)) {
    throw new DomainError(400, "検索件数を1〜50の整数で指定してください。");
  }
  return dishSearchSchema.parse({ ...query, limit: limit === undefined ? undefined : Number(limit) });
}

function failure(status: number, code: string, error: string, currentVersion?: number): Response {
  return Response.json({ error, code, requestId: randomUUID(), currentVersion }, { status, headers: privateApiHeaders });
}

function jsonResponse(result: unknown, status: number): Response {
  return status === 204 ? new Response(null, { status, headers: privateApiHeaders })
    : Response.json(result, { status, headers: privateApiHeaders });
}

async function readMutation<T>(request: Request, schema: z.ZodType<T>, limit: number) {
  const key = mealIdempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  if (!key.success) throw new DomainError(400, "有効なIdempotency-Keyを指定してください。");
  return { input: await readWorkspaceJson(request, schema, limit), key: key.data };
}

function suggestionsUnavailable() {
  return new SuggestionDomainError(404, "NOT_FOUND", "献立提案を利用できません。");
}

export function createMealHandlers(dependencies: MealApiDependencies = {
  getCurrentUser: async () => (await import("./auth/current-user")).getCurrentUser(),
  getRepository: getMealRepository,
  getSuggestions: user => {
    if (!isTestAuthEnabled()) throw suggestionsUnavailable();
    return getSuggestionService(user);
  },
}) {
  async function handle(
    request: Request,
    operation: (user: AppUser) => Promise<Response>,
    mutation = false,
  ): Promise<Response> {
    try {
      if (mutation) assertWorkspaceSameOrigin(request, dependencies.environment);
      const user = await dependencies.getCurrentUser();
      if (!user?.isEnabled) return failure(401, "UNAUTHENTICATED", "ログインしてください。");
      return await operation(user);
    } catch (error) {
      if (error instanceof MealDomainError || error instanceof SuggestionDomainError) {
        return failure(error.status, error.code, error.message, error.code === "VERSION_CONFLICT" ? error.currentVersion : undefined);
      }
      if (error instanceof z.ZodError) {
        return failure(400, "INVALID_INPUT", error.issues[0]?.message ?? "入力内容を確認してください。");
      }
      if (error instanceof DomainError && requestErrorCodes[error.status]) {
        return failure(error.status, requestErrorCodes[error.status], error.message);
      }
      return failure(500, "INTERNAL_ERROR", "処理に失敗しました。時間をおいてもう一度お試しください。");
    }
  }

  function read(request: Request, operation: (repository: MealRepository) => Promise<unknown>) {
    return handle(request, async user => jsonResponse(await operation(await dependencies.getRepository(user)), 200));
  }

  function write<T>(
    request: Request,
    status: number,
    schema: z.ZodType<T>,
    operation: (repository: MealRepository, input: T, key: string) => Promise<unknown>,
  ): Promise<Response> {
    return handle(request, async user => {
      const repository = await dependencies.getRepository(user);
      const { input, key } = await readMutation(request, schema, mealBodyLimit);
      return jsonResponse(await operation(repository, input, key), status);
    }, true);
  }

  function getSuggestions(user: AppUser) {
    if (!dependencies.getSuggestions) throw suggestionsUnavailable();
    return dependencies.getSuggestions(user);
  }

  function writeSuggestion<T>(
    request: Request,
    schema: z.ZodType<T>,
    operation: (service: SuggestionService, input: T, key: string) => Promise<Response>,
  ) {
    return handle(request, async user => {
      const service = await getSuggestions(user);
      const { input, key } = await readMutation(request, schema, suggestionBodyLimit);
      return operation(service, input, key);
    }, true);
  }

  return {
    list: (request: Request, workspaceId: string) => read(request, async repository => ({
      meals: await repository.list(workspaceId, mealRangeSchema.parse(queryInput(request))),
    })),
    create: (request: Request, workspaceId: string) => write(request, 201, createMealSchema, async (repository, input, key) => ({
      meal: await repository.create(workspaceId, input, key),
    })),
    get: (request: Request, workspaceId: string, mealId: string) => read(request, async repository => ({
      meal: await repository.get(workspaceId, mealId),
    })),
    update: (request: Request, workspaceId: string, mealId: string) => write(request, 200, updateMealSchema, async (repository, input, key) => ({
      meal: await repository.update(workspaceId, mealId, input, key),
    })),
    remove: (request: Request, workspaceId: string, mealId: string) => write(request, 204, deleteMealSchema,
      (repository, input, key) => repository.delete(workspaceId, mealId, input, key)),
    copy: (request: Request, workspaceId: string, mealId: string) => write(request, 201, copyMealSchema, async (repository, input, key) => ({
      meal: await repository.copy(workspaceId, mealId, input, key),
    })),
    record: (request: Request, workspaceId: string, mealId: string) => write(request, 200, updateMealSchema, async (repository, input, key) => ({
      meal: await repository.record(workspaceId, mealId, input, key),
    })),
    search: (request: Request, workspaceId: string) => read(request,
      repository => repository.search(workspaceId, searchInput(request))),
    createSuggestion: (request: Request, workspaceId: string) =>
      writeSuggestion(request, suggestionConditionsSchema, async (service, input, key) => {
        const { status, data } = await service.create(workspaceId, input, key);
        return jsonResponse({ suggestion: data }, status);
      }),
    getSuggestion: (request: Request, workspaceId: string, suggestionId: string) =>
      handle(request, async user => {
        const service = await getSuggestions(user);
        return jsonResponse({ suggestion: await service.get(workspaceId, suggestionId) }, 200);
      }),
    reviseSuggestion: (request: Request, workspaceId: string, suggestionId: string) =>
      writeSuggestion(request, reviseSuggestionSchema, async (service, input, key) => {
        const { status, data } = await service.revise(workspaceId, suggestionId, input, key);
        return jsonResponse({ suggestion: data }, status);
      }),
    adoptSuggestion: (request: Request, workspaceId: string, suggestionId: string) =>
      writeSuggestion(request, adoptSuggestionSchema, async (service, input, key) =>
        jsonResponse({ meal: await service.adopt(workspaceId, suggestionId, input, key) }, 200)),
  };
}

export const mealHandlers = createMealHandlers();
