import {
  createMealSchema,
  deleteMealSchema,
  mealIdSchema,
  mealRangeSchema,
  updateMealSchema,
  type CreateMealInput,
  type DeleteMealInput,
  type MealRangeInput,
  type UpdateMealInput,
} from "../shared/meal-schemas";
import type { MealDetail, MealSummary } from "../shared/meal-types";
import type { AppUser } from "../shared/types";
import { verifiedDatabaseQuery, type Query } from "./database/client";
import { DomainError } from "./workspaces";

const mealErrorCodes = ["UNAUTHENTICATED", "NOT_FOUND", "INVALID_INPUT", "SLOT_OCCUPIED", "VERSION_CONFLICT"] as const;
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
  create(workspaceId: string, input: CreateMealInput): Promise<MealDetail>;
  update(workspaceId: string, mealId: string, input: UpdateMealInput): Promise<MealDetail>;
  delete(workspaceId: string, mealId: string, input: DeleteMealInput): Promise<void>;
}

const readMeal = "SELECT mille_meal_read($1,$2,$3,$4::jsonb) AS result";
const changeMeal = "SELECT mille_meal_command($1,$2,$3,$4::jsonb) AS result";

export function createMealRepository(query: Query, user: AppUser): MealRepository {
  async function execute<T>(
    statement: string,
    operation: string,
    workspaceId: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    if (!user.isEnabled) throw new MealDomainError(401, "UNAUTHENTICATED", "ログインしてください。");
    const rows = await query<{ result: MealResult<T> }>(statement, [
      user.id,
      user.email.trim().toLowerCase(),
      operation,
      JSON.stringify({ ...payload, workspaceId: mealIdSchema.parse(workspaceId) }),
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

  return {
    list: async (workspaceId, input) => execute<MealSummary[]>(readMeal, "list", workspaceId, mealRangeSchema.parse(input)),
    get: async (workspaceId, mealId) => execute<MealDetail>(readMeal, "get", workspaceId, { mealId: mealIdSchema.parse(mealId) }),
    create: async (workspaceId, input) => execute<MealDetail>(changeMeal, "create", workspaceId, createMealSchema.parse(input)),
    update: async (workspaceId, mealId, input) => execute<MealDetail>(changeMeal, "update", workspaceId, {
      ...updateMealSchema.parse(input),
      mealId: mealIdSchema.parse(mealId),
    }),
    async delete(workspaceId, mealId, input) {
      await execute<null>(changeMeal, "delete", workspaceId, {
        ...deleteMealSchema.parse(input),
        mealId: mealIdSchema.parse(mealId),
      });
    },
  };
}

export async function getMealRepository(user: AppUser): Promise<MealRepository> {
  const { query } = await verifiedDatabaseQuery();
  return createMealRepository(query, user);
}
