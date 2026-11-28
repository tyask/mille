import { mealPhotoAnalysisSchema } from "@/lib/shared/meal-photo-analysis";
import { MEAL_PHOTO_CHUNK_BYTES } from "@/lib/shared/meal-photo-types";

export function mealPhotoUrl(api: string, photoId: string) {
  return `${api}/meal-photos/${encodeURIComponent(photoId)}`;
}

export class MealPhotoRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function photoRequest(url: string, options: RequestInit) {
  const response = await fetch(url, {
    ...options,
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) {
    const result: unknown = await response.json().catch(() => null);
    if (result && typeof result === "object" && "error" in result && typeof result.error === "string") {
      throw new MealPhotoRequestError(result.error, response.status);
    }
    throw new MealPhotoRequestError("写真の処理に失敗しました。もう一度お試しください。", response.status);
  }
  return response;
}

export async function uploadMealPhoto(api: string, photoId: string, file: File, signal: AbortSignal) {
  const created = await photoRequest(`${api}/meal-photos`, {
    method: "POST",
    body: JSON.stringify({ photoId, size: file.size }),
    headers: { "Content-Type": "application/json" },
    signal,
  });
  const body: unknown = await created.json().catch(() => null);
  if (body && typeof body === "object" && "photo" in body && body.photo
    && typeof body.photo === "object" && "ready" in body.photo && body.photo.ready === true) return;
  const url = mealPhotoUrl(api, photoId);
  for (let offset = 0; offset < file.size; offset += MEAL_PHOTO_CHUNK_BYTES) {
    await photoRequest(`${url}/chunks/${offset / MEAL_PHOTO_CHUNK_BYTES}`, {
      method: "PUT",
      body: file.slice(offset, offset + MEAL_PHOTO_CHUNK_BYTES),
      headers: { "Content-Type": "application/octet-stream" },
      signal,
    });
  }
  await photoRequest(`${url}/complete`, { method: "POST", signal });
}

export async function analyzeMealPhoto(api: string, photoId: string, signal: AbortSignal) {
  const response = await photoRequest(`${mealPhotoUrl(api, photoId)}/analysis`, { method: "POST", signal });
  return {
    result: mealPhotoAnalysisSchema.parse(await response.json()),
    sample: response.headers.get("X-Mille-Photo-Analysis") === "sample",
  };
}

export async function discardMealPhotoDraft(api: string, photoId: string) {
  await photoRequest(mealPhotoUrl(api, photoId), { method: "DELETE", signal: AbortSignal.timeout(5_000) });
}
