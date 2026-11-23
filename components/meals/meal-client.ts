"use client";

import { useEffect, useState } from "react";
import type { MealDetail, MealSummary, MealType } from "@/lib/shared/meal-types";
import { getMealPeriod } from "./meal-dates";

export class MealApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
  }
}

export interface MealWrite {
  url: string;
  method: "POST" | "PUT" | "DELETE";
  json: string;
  key: string;
  createdAt: number;
}

export function mealWrite(url: string, method: MealWrite["method"], payload: unknown): MealWrite {
  return { url, method, json: JSON.stringify(payload), key: crypto.randomUUID(), createdAt: Date.now() };
}

export async function mealRequest<T>(url: string, signal?: AbortSignal, write?: MealWrite): Promise<T> {
  const response = await fetch(url, {
    method: write?.method ?? "GET",
    body: write?.json,
    headers: write && { "Content-Type": "application/json", "Idempotency-Key": write.key },
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  const result: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    const failure = result && typeof result === "object" ? result : {};
    const message = "error" in failure && typeof failure.error === "string"
      ? failure.error : "献立の処理に失敗しました。もう一度お試しください。";
    const code = "code" in failure && typeof failure.code === "string" ? failure.code : null;
    throw new MealApiError(message, response.status, code);
  }
  if (response.status !== 204 && result === undefined) throw new Error("応答を確認できませんでした。");
  return result as T;
}

export function listUrl(api: string, from: string, to: string): string {
  return `${api}/meals?${new URLSearchParams({ from, to })}`;
}

export function detailUrl(api: string, id: string): string {
  return `${api}/meals/${encodeURIComponent(id)}`;
}

export async function readMealSlot(api: string, date: string, mealType: MealType, signal: AbortSignal): Promise<MealDetail | null> {
  const { from, to } = getMealPeriod(date, "week");
  const { meals } = await mealRequest<{ meals: MealSummary[] }>(listUrl(api, from, to), signal);
  const meal = meals.find(item => item.mealDate === date && item.mealType === mealType);
  if (!meal) return null;
  const { meal: detail } = await mealRequest<{ meal: MealDetail }>(detailUrl(api, meal.id), signal);
  if (detail.mealDate !== date || detail.mealType !== mealType) {
    throw new Error("食事枠の内容が変わりました。もう一度お試しください。");
  }
  return detail;
}

type MealResource<T> = { status: "loading" } | { status: "error"; error: unknown } | { status: "loaded"; data: T };

export function useMealResource<T>(url: string | null, revision: number): MealResource<T> {
  const [result, setResult] = useState<{ url: string; revision: number; value: MealResource<T> } | null>(null);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    function publish(value: MealResource<T>) {
      if (!controller.signal.aborted && url) setResult({ url, revision, value });
    }
    void mealRequest<T>(url, controller.signal).then(
      data => publish({ status: "loaded", data }),
      error => publish({ status: "error", error }),
    );
    return () => controller.abort();
  }, [url, revision]);
  return result && result.url === url && result.revision === revision ? result.value : { status: "loading" };
}
