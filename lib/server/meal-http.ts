import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  copyMealSchema, createMealSchema, deleteMealSchema, dishSearchSchema,
  mealIdempotencyKeySchema, mealRangeSchema, updateMealSchema,
} from "../shared/meal-schemas";
import type { AppUser } from "../shared/types";
import { getMealRepository, MealDomainError, type MealRepository } from "./meals";
import { assertWorkspaceSameOrigin, privateApiHeaders, readWorkspaceJson } from "./workspace-http";
import { DomainError } from "./workspaces";

const mealBodyLimit = 256 * 1024;
const requestErrorCodes: Readonly<Record<number, string>> = {
  400: "INVALID_INPUT",
  403: "ORIGIN_REJECTED",
  413: "BODY_TOO_LARGE",
};

type MealApiDependencies = {
  getCurrentUser: () => Promise<AppUser | null>;
  getRepository: (user: AppUser) => Promise<MealRepository>;
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

export function createMealHandlers(dependencies: MealApiDependencies = {
  getCurrentUser: async () => (await import("./auth/current-user")).getCurrentUser(),
  getRepository: getMealRepository,
}) {
  async function handle(
    request: Request,
    status: number,
    operation: (repository: MealRepository) => Promise<unknown>,
    mutation = false,
  ): Promise<Response> {
    try {
      if (mutation) assertWorkspaceSameOrigin(request, dependencies.environment);
      const user = await dependencies.getCurrentUser();
      if (!user?.isEnabled) return failure(401, "UNAUTHENTICATED", "ログインしてください。");
      const result = await operation(await dependencies.getRepository(user));
      return status === 204 ? new Response(null, { status, headers: privateApiHeaders })
        : Response.json(result, { status, headers: privateApiHeaders });
    } catch (error) {
      if (error instanceof MealDomainError) {
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

  function write<T>(
    request: Request,
    status: number,
    schema: z.ZodType<T>,
    operation: (repository: MealRepository, input: T, key: string) => Promise<unknown>,
  ): Promise<Response> {
    return handle(request, status, async repository => {
      const key = mealIdempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
      if (!key.success) throw new DomainError(400, "有効なIdempotency-Keyを指定してください。");
      return operation(repository, await readWorkspaceJson(request, schema, mealBodyLimit), key.data);
    }, true);
  }

  return {
    list: (request: Request, workspaceId: string) => handle(request, 200, async repository => ({
      meals: await repository.list(workspaceId, mealRangeSchema.parse(queryInput(request))),
    })),
    create: (request: Request, workspaceId: string) => write(request, 201, createMealSchema, async (repository, input, key) => ({
      meal: await repository.create(workspaceId, input, key),
    })),
    get: (request: Request, workspaceId: string, mealId: string) => handle(request, 200, async repository => ({
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
    search: (request: Request, workspaceId: string) => handle(request, 200,
      repository => repository.search(workspaceId, searchInput(request))),
  };
}

export const mealHandlers = createMealHandlers();
