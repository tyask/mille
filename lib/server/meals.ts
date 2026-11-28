import { createHash } from "node:crypto";
import {
  copyMealSchema,
  createMealSchema,
  deleteMealSchema,
  dishSearchPositionSchema,
  dishSearchSchema,
  mealIdempotencyKeySchema,
  mealIdSchema,
  mealRangeSchema,
  updateMealSchema,
  type CopyMealInput,
  type CreateMealInput,
  type DeleteMealInput,
  type DishSearchInput,
  type MealRangeInput,
  type UpdateMealInput,
} from "../shared/meal-schemas";
import type { DishSearchPage, MealDetail, MealSummary } from "../shared/meal-types";
import type { AppUser } from "../shared/types";
import { verifiedDatabaseQuery, type Query } from "./database/client";
import { DomainError } from "./workspaces";

const mealErrorCodes = [
  "UNAUTHENTICATED", "NOT_FOUND", "INVALID_INPUT", "SLOT_OCCUPIED", "VERSION_CONFLICT", "IDEMPOTENCY_KEY_REUSED",
  "NOT_PLANNED", "NOT_RECORDED",
] as const;
type MealErrorCode = typeof mealErrorCodes[number];

export class MealDomainError extends DomainError {
  constructor(status: number, public readonly code: MealErrorCode, message: string, public readonly currentVersion?: number) {
    super(status, message);
    this.name = "MealDomainError";
  }
}

type MealResult<T> = { ok: true; data: T }
  | { ok: false; status: number; code: MealErrorCode; error: string; currentVersion?: number };

export interface MealRepository {
  list(workspaceId: string, input: MealRangeInput): Promise<MealSummary[]>;
  get(workspaceId: string, mealId: string): Promise<MealDetail>;
  create(workspaceId: string, input: CreateMealInput, idempotencyKey?: string): Promise<MealDetail>;
  update(workspaceId: string, mealId: string, input: UpdateMealInput, idempotencyKey?: string): Promise<MealDetail>;
  record(workspaceId: string, mealId: string, input: UpdateMealInput, idempotencyKey: string): Promise<MealDetail>;
  delete(workspaceId: string, mealId: string, input: DeleteMealInput, idempotencyKey?: string): Promise<void>;
  copy(workspaceId: string, mealId: string, input: CopyMealInput, idempotencyKey: string): Promise<MealDetail>;
  search(workspaceId: string, input: DishSearchInput): Promise<DishSearchPage>;
}

const readMeal = "SELECT mille_meal_read($1,$2,$3,$4::jsonb) AS result";
const changeMeal = "SELECT mille_meal_command($1,$2,$3,$4::jsonb) AS result";
const changeMealIdempotently = "SELECT mille_meal_command_idempotent($1,$2,$3,$4::jsonb,$5,$6) AS result";
const searchDishes = "SELECT mille_meal_dish_search($1,$2,$3::jsonb) AS result";

type MealMutation = "create" | "update" | "record" | "delete" | "copy";
type DishSearchPosition = ReturnType<typeof dishSearchPositionSchema.parse>;
type DishSearchResult = Omit<DishSearchPage, "nextCursor"> & { nextCursor: DishSearchPosition | null };

function mealPayload(workspaceId: string, payload: Record<string, unknown>) {
  return JSON.stringify({ ...payload, workspaceId: mealIdSchema.parse(workspaceId) });
}

function decodeDishCursor(cursor: string, binding: string): DishSearchPosition {
  const bytes = Buffer.from(cursor, "base64url");
  if (bytes.toString("base64url") === cursor) {
    try {
      const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (Array.isArray(decoded) && decoded.length === 2 && decoded[0] === binding) {
        const position = dishSearchPositionSchema.safeParse(decoded[1]);
        if (position.success) return position.data;
      }
    } catch {
      // Invalid UTF-8 or JSON is handled like any other invalid cursor.
    }
  }
  throw new MealDomainError(400, "INVALID_INPUT", "検索カーソルが無効です。検索をやり直してください。");
}

export function createMealRepository(query: Query, user: AppUser): MealRepository {
  async function execute<T>(statement: string, ...parameters: unknown[]): Promise<T> {
    if (!user.isEnabled) throw new MealDomainError(401, "UNAUTHENTICATED", "ログインしてください。");
    const rows = await query<{ result: MealResult<T> }>(statement, [
      user.id,
      user.email.trim().toLowerCase(),
      ...parameters,
    ]);
    const result = rows[0]?.result;
    if (!result || typeof result.ok !== "boolean") throw new Error("Invalid meal database response");
    if (result.ok) return result.data;
    if (!Number.isInteger(result.status) || result.status < 400 || result.status > 499
      || !mealErrorCodes.includes(result.code) || typeof result.error !== "string"
      || (result.currentVersion !== undefined && (!Number.isSafeInteger(result.currentVersion) || result.currentVersion < 1))) {
      throw new Error("Invalid meal database error");
    }
    throw new MealDomainError(result.status, result.code, result.error, result.currentVersion);
  }

  function mutate<T>(operation: MealMutation, workspaceId: string, input: Record<string, unknown>, idempotencyKey?: string) {
    const payload = mealPayload(workspaceId, input);
    if (idempotencyKey === undefined && operation !== "record" && operation !== "copy") {
      return execute<T>(changeMeal, operation, payload);
    }
    const key = mealIdempotencyKeySchema.parse(idempotencyKey);
    // Each operation identifies its HTTP method and route. The normalized payload includes the target IDs.
    const hash = createHash("sha256").update(JSON.stringify([operation, payload])).digest("hex");
    return execute<T>(changeMealIdempotently, operation, payload, key, hash);
  }

  return {
    list: async (workspaceId, input) => execute<MealSummary[]>(readMeal, "list", mealPayload(workspaceId, mealRangeSchema.parse(input))),
    get: async (workspaceId, mealId) => execute<MealDetail>(readMeal, "get", mealPayload(workspaceId, { mealId: mealIdSchema.parse(mealId) })),
    create: async (workspaceId, input, key) => mutate<MealDetail>("create", workspaceId, createMealSchema.parse(input), key),
    update: async (workspaceId, mealId, input, key) => mutate<MealDetail>("update", workspaceId, {
      ...updateMealSchema.parse(input),
      mealId: mealIdSchema.parse(mealId),
    }, key),
    record: async (workspaceId, mealId, input, key) => mutate<MealDetail>("record", workspaceId, {
      ...updateMealSchema.parse(input),
      mealId: mealIdSchema.parse(mealId),
    }, key),
    async delete(workspaceId, mealId, input, key) {
      await mutate<null>("delete", workspaceId, {
        ...deleteMealSchema.parse(input),
        mealId: mealIdSchema.parse(mealId),
      }, key);
    },
    copy: async (workspaceId, mealId, input, key) => mutate<MealDetail>("copy", workspaceId, {
      ...copyMealSchema.parse(input),
      mealId: mealIdSchema.parse(mealId),
    }, key),
    async search(workspaceId, input) {
      const { q, by, limit, cursor } = dishSearchSchema.parse(input);
      const workspace = mealIdSchema.parse(workspaceId);
      // Existing name-search cursors keep their binding.
      const scope = by === "name" ? [workspace, q] : [workspace, q, by];
      const binding = createHash("sha256").update(JSON.stringify(scope)).digest("base64url");
      const position = cursor === undefined ? undefined : decodeDishCursor(cursor, binding);
      const result = await execute<DishSearchResult>(searchDishes, mealPayload(workspace, { q, by, limit, cursor: position }));
      return {
        items: result.items,
        nextCursor: result.nextCursor === null
          ? null
          : Buffer.from(JSON.stringify([binding, result.nextCursor])).toString("base64url"),
      };
    },
  };
}

export async function getMealRepository(user: AppUser): Promise<MealRepository> {
  const { query } = await verifiedDatabaseQuery();
  return createMealRepository(query, user);
}
