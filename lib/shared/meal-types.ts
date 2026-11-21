export const MEAL_TYPES = ["BREAKFAST", "LUNCH", "DINNER"] as const;

export type MealType = typeof MEAL_TYPES[number];

export interface MealDishSummary {
  id: string;
  position: number;
  name: string;
}

export interface MealIngredient {
  id: string;
  name: string;
  amountText: string | null;
  unit: string | null;
}

export interface MealDish extends MealDishSummary {
  servings: number | null;
  recipeText: string | null;
  recipeUrl: string | null;
  ingredients: MealIngredient[];
}

interface MealHeader {
  id: string;
  workspaceId: string;
  mealDate: string;
  mealType: MealType;
  servings: number | null;
  status: "RECORDED";
  version: number;
  updatedBy: { id: string; name: string };
  updatedAt: string;
}

export interface MealSummary extends MealHeader {
  dishes: MealDishSummary[];
}

export interface MealDetail extends MealHeader {
  dishes: MealDish[];
}

export interface DishSearchItem {
  mealDate: string;
  mealType: MealType;
  mealId: string;
  dishId: string;
  position: number;
  dishName: string;
}

export interface DishSearchPage {
  items: DishSearchItem[];
  nextCursor: string | null;
}
