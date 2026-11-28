import { z } from "zod";

export const MEAL_PHOTO_MAX_BYTES = 8 * 1024 * 1024;
export const MEAL_PHOTO_CHUNK_BYTES = 1024 * 1024;
export const MEAL_PHOTO_MAX_PIXELS = 20_000_000;
export const MEAL_PHOTO_MAX_EDGE = 1600;
export const MEAL_PHOTO_STORED_BYTE_LIMIT = 2 * 1024 * 1024;
export const MEAL_PHOTO_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export const mealPhotoIdSchema = z.uuidv4().transform(value => value.toLowerCase());
export const mealPhotoSizeSchema = z.number().int().min(1).max(MEAL_PHOTO_MAX_BYTES);

export interface MealPhoto {
  id: string;
  dishId: string | null;
  ready: boolean;
  width: number | null;
  height: number | null;
}
