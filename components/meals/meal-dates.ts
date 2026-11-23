import type { MealType } from "@/lib/shared/meal-types";

export type MealView = "week" | "month";

export const MEAL_TYPE_LABELS: Record<MealType, string> = {
  BREAKFAST: "朝食",
  LUNCH: "昼食",
  DINNER: "夕食",
};

const dayMilliseconds = 24 * 60 * 60 * 1_000;
const firstDay = Date.parse("0001-01-01");
const lastDay = Date.parse("9999-12-31");
const tokyoDateFormat = new Intl.DateTimeFormat("sv-SE", {
  year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Tokyo",
});
const displayDateFormat = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric", month: "long", day: "numeric", weekday: "short", timeZone: "UTC",
});

function dateKey(time: number) {
  return new Date(time).toISOString().split("T")[0];
}

export function isMealDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && dateKey(time) === value;
}

export function tokyoToday() {
  return tokyoDateFormat.format(new Date());
}

export function formatMealDate(date: string) {
  return displayDateFormat.format(new Date(date));
}

export function mealWeekday(date: string) {
  return (new Date(date).getUTCDay() + 6) % 7;
}

export function getMealPeriod(date: string, view: MealView) {
  const day = new Date(date);
  let first: number;
  let end: number;
  if (view === "week") {
    first = day.getTime() - mealWeekday(date) * dayMilliseconds;
    end = first + 7 * dayMilliseconds;
  } else {
    first = day.setUTCDate(1);
    end = day.setUTCMonth(day.getUTCMonth() + 1);
  }
  first = Math.max(first, firstDay);
  end = Math.min(end, lastDay + dayMilliseconds);

  return {
    from: dateKey(first),
    to: dateKey(end),
    days: Array.from({ length: (end - first) / dayMilliseconds }, (_, index) => dateKey(first + index * dayMilliseconds)),
  };
}

export function moveMealPeriod(date: string, view: MealView, direction: -1 | 1) {
  const current = new Date(date);
  if (view === "week") {
    const time = current.getTime() + direction * 7 * dayMilliseconds;
    const weekStart = time - mealWeekday(date) * dayMilliseconds;
    if (weekStart > lastDay || weekStart + 6 * dayMilliseconds < firstDay) return date;
    return dateKey(Math.min(lastDay, Math.max(firstDay, time)));
  }
  const day = current.getUTCDate();
  current.setUTCDate(1);
  const target = current.setUTCMonth(current.getUTCMonth() + direction);
  if (target < firstDay || target > lastDay) return date;
  const monthEnd = new Date(target);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0);
  return dateKey(current.setUTCDate(Math.min(day, monthEnd.getUTCDate())));
}
