import { MEAL_TYPES } from "@/lib/shared/meal-types";
import type { MealSelection } from "./meal-app";
import { isMealDate, tokyoToday } from "./meal-dates";

export type WorkspacePane = "meal" | "settings";

export function readMealLocation(get: (key: string) => string | null | undefined, today = tokyoToday()) {
  const date = get("date");
  const meal = MEAL_TYPES.find(value => value === get("meal")) ?? "DINNER";
  const selection: MealSelection = { date: date && isMealDate(date) ? date : today, view: get("view") === "month" ? "month" : "week", meal };
  const pane: WorkspacePane = get("section") === "settings" ? "settings" : "meal";
  return { selection, pane };
}

export function writeMealLocation(workspaceId: string, selection: MealSelection, pane: WorkspacePane, index: number, replace = false) {
  const url = new URL(window.location.href);
  if (workspaceId) url.searchParams.set("workspace", workspaceId);
  else url.searchParams.delete("workspace");
  url.searchParams.set("date", selection.date);
  url.searchParams.set("view", selection.view);
  url.searchParams.set("meal", selection.meal);
  if (pane === "settings") url.searchParams.set("section", "settings");
  else url.searchParams.delete("section");
  const historyState = { ...window.history.state, milleMealIndex: index };
  if (replace) window.history.replaceState(historyState, "", url);
  else window.history.pushState(historyState, "", url);
}
