import { z } from "zod";

const text = (maximum: number) => z.string().trim().min(1).max(maximum)
  .refine(value => !/[\uD800-\uDFFF]/u.test(value) && !value.includes("\0"));

export const mealPhotoAnalysisSchema = z.strictObject({
  dishes: z.array(z.strictObject({
    name: text(120),
    ingredients: z.array(z.strictObject({
      name: text(120),
      amountText: text(40).nullable(),
      unit: text(20).nullable(),
    })).max(12),
  })).max(4),
});

export type MealPhotoAnalysis = z.output<typeof mealPhotoAnalysisSchema>;
