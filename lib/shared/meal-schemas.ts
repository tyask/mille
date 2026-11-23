import { z } from "zod";
import { MEAL_TYPES } from "./meal-types";

const databaseText = z.string().refine(
  value => !/[\uD800-\uDFFF]/u.test(value) && !value.includes("\0"),
  "入力できない文字が含まれています。",
);

export function textWithin(limit: number) {
  return databaseText.transform(value => value.trim())
    .refine(value => Array.from(value).length <= limit, `${limit}文字以内で入力してください。`);
}

const name = textWithin(120).refine(value => value.length > 0, "名前を入力してください。");
const nullableText = (limit: number) => textWithin(limit).transform(value => value || null).nullable();

const recipeUrl = nullableText(2_048).refine(value => {
  if (value === null) return true;
  const authority = /^https?:\/\/([^/?#]+)/i.exec(value)?.[1];
  if (!authority || authority.includes("@") || /[\s\\]/u.test(value)) return false;
  try { return Boolean(new URL(value).hostname); } catch { return false; }
}, "資格情報を含まないHTTPまたはHTTPSのURLを入力してください。");

const servings = z.number().min(0.01).max(99)
  .refine(value => /^\d+(?:\.\d{1,2})?$/.test(String(value)), "人数は小数第2位まで入力できます。")
  .nullable();
const mealDate = z.iso.date().refine(value => !value.startsWith("0000-"), "実在する日付を入力してください。");
const mealType = z.enum(MEAL_TYPES);
const expectedVersion = z.number().int().min(1).max(2_147_483_647);

export const mealIdSchema = databaseText.refine(value => value.trim() === value && value.length > 0);

const ingredientFields = { name, amountText: nullableText(40), unit: nullableText(20) };
const newIngredient = z.strictObject({
  ...ingredientFields,
  amountText: ingredientFields.amountText.default(null),
  unit: ingredientFields.unit.default(null),
});
const updatedIngredient = z.strictObject({ ...ingredientFields, id: mealIdSchema.optional() });

const dishFields = { name, servings, recipeText: nullableText(10_000), recipeUrl };
function hasSingleRecipe(dish: { recipeText: string | null; recipeUrl: string | null }) {
  return dish.recipeText === null || dish.recipeUrl === null;
}
const recipeError = { path: ["recipeUrl"], message: "レシピの本文またはURLのどちらかを入力してください。" };

const newDish = z.strictObject({
  ...dishFields,
  servings: dishFields.servings.default(null),
  recipeText: dishFields.recipeText.default(null),
  recipeUrl: dishFields.recipeUrl.default(null),
  ingredients: z.array(newIngredient).max(100).default([]),
}).refine(hasSingleRecipe, recipeError);

const updatedDish = z.strictObject({
  ...dishFields,
  id: mealIdSchema.optional(),
  ingredients: z.array(updatedIngredient).max(100),
}).refine(hasSingleRecipe, recipeError);

export const createMealSchema = z.strictObject({
  mealDate,
  mealType,
  servings: servings.default(null),
  dishes: z.array(newDish).min(1).max(20),
});

export const updateMealSchema = z.strictObject({
  mealDate,
  mealType,
  servings,
  dishes: z.array(updatedDish).min(1).max(20),
  expectedVersion,
});

export const deleteMealSchema = z.strictObject({ expectedVersion });

export const copyMealSchema = z.strictObject({
  sourceVersion: expectedVersion,
  targetDate: mealDate,
  targetMealType: mealType,
});

// A comma can represent multiple header values joined together by Fetch.
export const mealIdempotencyKeySchema = z.string().regex(/^[!-~]{1,128}$/)
  .refine(value => !value.includes(","));

const dayInMilliseconds = 24 * 60 * 60 * 1_000;
// An expanded ISO date is needed only for the exclusive end of 9999-12-31.
const lastRangeEnd = "+010000-01-01";
export const mealRangeSchema = z.strictObject({ from: mealDate, to: z.union([mealDate, z.literal(lastRangeEnd)]) })
  .refine(({ from, to }) => {
    const days = (Date.parse(to) - Date.parse(from)) / dayInMilliseconds;
    return days > 0 && days <= 62;
  }, { path: ["to"], message: "取得する日付の範囲を1〜62日にしてください。" });

export const dishSearchSchema = z.strictObject({
  q: textWithin(100).refine(value => value.length > 0, "料理名を入力してください。"),
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,2048}$/).optional(),
});

export const dishSearchPositionSchema = z.strictObject({
  mealDate,
  mealId: mealIdSchema.max(128),
  position: z.number().int().min(0).max(19),
  dishId: mealIdSchema.max(128),
});

export type CreateMealInput = z.input<typeof createMealSchema>;
export type UpdateMealInput = z.input<typeof updateMealSchema>;
export type DeleteMealInput = z.input<typeof deleteMealSchema>;
export type CopyMealInput = z.input<typeof copyMealSchema>;
export type MealRangeInput = z.input<typeof mealRangeSchema>;
export type DishSearchInput = z.input<typeof dishSearchSchema>;
