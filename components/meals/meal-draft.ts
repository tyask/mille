import { updateMealSchema, type UpdateMealInput } from "@/lib/shared/meal-schemas";
import type { MealDetail, MealDish, MealIngredient, MealType } from "@/lib/shared/meal-types";

type IngredientDraft = {
  key: string;
  id?: string;
  name: string;
  amountText: string;
  unit: string;
};

export type DishDraft = {
  key: string;
  id?: string;
  name: string;
  servings: string;
  recipeMode: "text" | "url";
  recipeText: string;
  recipeUrl: string;
  ingredients: IngredientDraft[];
};

export type MealDraft = {
  mealDate: string;
  mealType: MealType;
  servings: string;
  dishes: DishDraft[];
};

export type MealDraftPayload = Omit<UpdateMealInput, "expectedVersion">;

export function newIngredientDraft(): IngredientDraft {
  return { key: crypto.randomUUID(), name: "", amountText: "", unit: "" };
}

export function newDishDraft(): DishDraft {
  return {
    key: crypto.randomUUID(), name: "", servings: "", recipeMode: "text",
    recipeText: "", recipeUrl: "", ingredients: [],
  };
}

export function newMealDraft(mealDate: string, mealType: MealType): MealDraft {
  return { mealDate, mealType, servings: "", dishes: [newDishDraft()] };
}

function ingredientDraft(ingredient: MealIngredient, id?: string): IngredientDraft {
  return {
    key: id ?? crypto.randomUUID(), id, name: ingredient.name,
    amountText: ingredient.amountText ?? "", unit: ingredient.unit ?? "",
  };
}

function dishDraft(dish: MealDish, servings: number | null, preserveIds: boolean): DishDraft {
  const id = preserveIds ? dish.id : undefined;
  return {
    key: id ?? crypto.randomUUID(),
    id,
    name: dish.name,
    servings: servings === null ? "" : String(servings),
    recipeMode: dish.recipeUrl ? "url" : "text",
    recipeText: dish.recipeText ?? "",
    recipeUrl: dish.recipeUrl ?? "",
    ingredients: dish.ingredients.map(ingredient => ingredientDraft(ingredient, preserveIds ? ingredient.id : undefined)),
  };
}

export function editMealDraft(meal: MealDetail): MealDraft {
  return {
    mealDate: meal.mealDate,
    mealType: meal.mealType,
    servings: meal.servings === null ? "" : String(meal.servings),
    dishes: meal.dishes.map(dish => dishDraft(dish, dish.servings, true)),
  };
}

function isBlankDish(dish: DishDraft): boolean {
  return !dish.id && !dish.name.trim() && !dish.servings.trim() && !dish.recipeText.trim()
    && !dish.recipeUrl.trim() && dish.ingredients.length === 0;
}

export function appendCopiedDish(destination: MealDraft, source: MealDetail, dishId: string): {
  draft: MealDraft;
  confirmCopyServings: boolean;
} {
  const dish = source.dishes.find(candidate => candidate.id === dishId);
  if (!dish) throw new Error("コピー元の料理が見つかりません。");
  if (destination.dishes.length >= 20) throw new Error("この献立には料理を20件登録しています。別の食事枠を選んでください。");

  const effectiveServings = dish.servings ?? source.servings;
  const copied = dishDraft(dish, effectiveServings, false);
  const hasOnlyPlaceholder = destination.dishes.length === 1 && isBlankDish(destination.dishes[0]);
  return {
    draft: { ...destination, dishes: hasOnlyPlaceholder ? [copied] : [...destination.dishes, copied] },
    confirmCopyServings: effectiveServings === null,
  };
}

function servingCount(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(trimmed) ? Number(trimmed) : NaN;
}

const mealDraftSchema = updateMealSchema.omit({ expectedVersion: true });

export function validateMealDraft(draft: MealDraft) {
  const payload: MealDraftPayload = {
    mealDate: draft.mealDate,
    mealType: draft.mealType,
    servings: servingCount(draft.servings),
    dishes: draft.dishes.map(dish => ({
      ...(dish.id ? { id: dish.id } : {}),
      name: dish.name,
      servings: servingCount(dish.servings),
      recipeText: dish.recipeMode === "text" ? dish.recipeText : null,
      recipeUrl: dish.recipeMode === "url" ? dish.recipeUrl : null,
      ingredients: dish.ingredients.map(ingredient => ({
        ...(ingredient.id ? { id: ingredient.id } : {}),
        name: ingredient.name, amountText: ingredient.amountText, unit: ingredient.unit,
      })),
    })),
  };
  return mealDraftSchema.safeParse(payload);
}
