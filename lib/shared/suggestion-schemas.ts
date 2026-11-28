import { z } from "zod";
import { createMealSchema, mealIdSchema, textWithin, updateMealSchema } from "./meal-schemas";

const { mealDate, mealType, servings, dishes } = createMealSchema.shape;
const { expectedVersion } = updateMealSchema.shape;

export const suggestionConditionsSchema = z.strictObject({
  mealDate,
  mealType,
  servings,
  ingredients: z.array(textWithin(80).refine(Boolean, "食材名を入力してください。")).max(12),
  maxMinutes: z.number().int().min(1).max(240).nullable(),
  cuisine: textWithin(80),
  request: textWithin(1_000),
});

export const reviseSuggestionSchema = z.strictObject({
  expectedVersion: z.int32().min(0),
  message: textWithin(1_000).refine(Boolean, "追加の要望を入力してください。"),
});

export const adoptSuggestionSchema = z.strictObject({
  expectedVersion,
  candidateId: mealIdSchema.max(128),
  replaceMealId: mealIdSchema.max(128).optional(),
  replaceVersion: expectedVersion.optional(),
  confirmReplacement: z.literal(true).optional(),
}).refine(({ replaceMealId, replaceVersion, confirmReplacement }) =>
  Boolean(replaceMealId) === Boolean(confirmReplacement) && Boolean(replaceVersion) === Boolean(confirmReplacement),
{ path: ["confirmReplacement"], message: "置き換える予定と確認内容を指定してください。" });

const recommendationCandidateSchema = z.strictObject({
  title: textWithin(120).refine(Boolean),
  estimatedMinutes: z.number().int().min(1).max(240).nullable(),
  dishes: dishes.refine(items => items.every(dish => dish.recipeUrl === null && dish.photoId === undefined)),
  reasons: z.array(textWithin(200).refine(Boolean)).max(4),
});

export const recommendationOutputSchema = z.array(recommendationCandidateSchema).min(2).max(4);
