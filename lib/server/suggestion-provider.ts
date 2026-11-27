import type { SuggestionCandidate, SuggestionConditions } from "../shared/suggestion-types";

export interface RecommendationContext {
  conditions: SuggestionConditions;
  recentDishes: readonly string[];
  previousCandidates: readonly SuggestionCandidate[];
  messages: readonly string[];
}

export interface RecommendationProvider {
  readonly model?: string;
  readonly promptVersion?: string;
  generate(context: RecommendationContext, signal?: AbortSignal): Promise<unknown>;
}

type SampleCandidate = Omit<SuggestionCandidate, "id">;
type Dish = SampleCandidate["dishes"][number];
type DishTemplate = readonly [name: string, ingredients: readonly string[]];
type Cuisine = "和食" | "洋食" | "中華";
type Menu = {
  cuisine: Cuisine;
  breakfast: boolean;
  minutes: number;
  main: DishTemplate;
};

const menus: readonly Menu[] = [
  { cuisine: "和食", breakfast: true, minutes: 5, main: ["梅おにぎり", ["ごはん", "梅干し", "のり"]] },
  { cuisine: "和食", breakfast: true, minutes: 8, main: ["しらすごはん", ["ごはん", "しらす", "青ねぎ"]] },
  { cuisine: "和食", breakfast: true, minutes: 12, main: ["卵焼きとごはん", ["卵", "ごはん", "だし"]] },
  { cuisine: "和食", breakfast: false, minutes: 10, main: ["ねぎ塩うどん", ["うどん", "青ねぎ", "ごま油"]] },
  { cuisine: "和食", breakfast: false, minutes: 15, main: ["豆腐のそぼろ丼", ["木綿豆腐", "ごはん", "しょうが"]] },
  { cuisine: "和食", breakfast: false, minutes: 20, main: ["鮭の塩焼き", ["鮭", "塩", "大根"]] },
  { cuisine: "洋食", breakfast: true, minutes: 5, main: ["りんごヨーグルト", ["りんご", "ヨーグルト", "オートミール"]] },
  { cuisine: "洋食", breakfast: true, minutes: 8, main: ["チーズトースト", ["食パン", "チーズ", "パセリ"]] },
  { cuisine: "洋食", breakfast: true, minutes: 12, main: ["トマトオムレツ", ["卵", "トマト", "玉ねぎ"]] },
  { cuisine: "洋食", breakfast: false, minutes: 10, main: ["トマトとツナのサンド", ["食パン", "トマト", "ツナ"]] },
  { cuisine: "洋食", breakfast: false, minutes: 15, main: ["きのこのパスタ", ["パスタ", "しめじ", "にんにく"]] },
  { cuisine: "洋食", breakfast: false, minutes: 20, main: ["鶏肉のハーブ焼き", ["鶏もも肉", "じゃがいも", "ローズマリー"]] },
  { cuisine: "中華", breakfast: true, minutes: 5, main: ["ザーサイのおにぎり", ["ごはん", "ザーサイ", "白ごま"]] },
  { cuisine: "中華", breakfast: true, minutes: 8, main: ["青ねぎの卵スープ", ["卵", "青ねぎ", "中華だし"]] },
  { cuisine: "中華", breakfast: true, minutes: 12, main: ["しょうがのおかゆ", ["ごはん", "しょうが", "青ねぎ"]] },
  { cuisine: "中華", breakfast: false, minutes: 10, main: ["青菜の卵炒め", ["小松菜", "卵", "ごま油"]] },
  { cuisine: "中華", breakfast: false, minutes: 15, main: ["きのこのあんかけ麺", ["中華麺", "しめじ", "片栗粉"]] },
  { cuisine: "中華", breakfast: false, minutes: 20, main: ["鶏肉とピーマンの炒め物", ["鶏もも肉", "ピーマン", "しょうが"]] },
];

const sides: Record<Cuisine, readonly DishTemplate[]> = {
  和食: [
    ["かつお節の冷ややっこ", ["絹ごし豆腐", "かつお節"]],
    ["きゅうりの浅漬け", ["きゅうり", "塩"]],
    ["わかめの酢の物", ["わかめ", "きゅうり", "酢"]],
  ],
  洋食: [
    ["キャベツのマリネ", ["キャベツ", "酢", "オリーブ油"]],
    ["コーンとトマトのサラダ", ["コーン", "トマト"]],
    ["豆のオリーブ油あえ", ["ミックスビーンズ", "オリーブ油"]],
  ],
  中華: [
    ["きゅうりのごまあえ", ["きゅうり", "白ごま", "ごま油"]],
    ["ザーサイ冷ややっこ", ["絹ごし豆腐", "ザーサイ"]],
    ["トマトの中華風あえ物", ["トマト", "酢", "ごま油"]],
  ],
};

const slotLabel = { BREAKFAST: "朝食", LUNCH: "昼食", DINNER: "夕食" };
const quickRequest = /時短|短め|短く|早く|手軽|簡単/u;
const sideRequest = /(?:副菜だけ|副菜(?:を|の)?(?:変|替|変更))/u;

function normalized(value: string) {
  return value.normalize("NFKC").toLowerCase();
}

function requestedCuisine(value: string): Cuisine | undefined {
  switch (normalized(value)) {
    case "和食": case "和風": return "和食";
    case "洋食": case "洋風": return "洋食";
    case "中華": case "中華風": return "中華";
  }
}

function dishFromTemplate([name, ingredients]: DishTemplate): Dish {
  return {
    name,
    servings: null,
    ingredients: ingredients.map(name => ({ name, amountText: null, unit: null })),
    recipeText: null,
    recipeUrl: null,
  };
}

function selectedSide(
  menu: Menu, day: number, recent: ReadonlySet<string>, previousName?: string,
) {
  const options = sides[menu.cuisine].filter(([name]) => name !== previousName);
  const lessRecent = options.filter(([name]) => !recent.has(normalized(name)));
  const pool = lessRecent.length > 0 ? lessRecent : options;
  return dishFromTemplate(pool[day % pool.length]);
}

function withRequestedIngredients(dishes: Dish[], ingredients: readonly string[]) {
  const alreadyIncluded = new Set(dishes.flatMap(dish => dish.ingredients.map(({ name }) => normalized(name))));
  const missing = ingredients.filter(name => {
    const key = normalized(name);
    if (alreadyIncluded.has(key)) return false;
    alreadyIncluded.add(key);
    return true;
  });
  if (missing.length > 0) dishes.push(dishFromTemplate(["希望食材を使う一品", missing]));
  return dishes;
}

function timePreference(conditions: SuggestionConditions, requests: readonly string[]) {
  const requestedLimits = requests.flatMap(request =>
    Array.from(normalized(request).matchAll(/([1-9][0-9]{0,2})\s*分(?:以内|まで|で)/g), match => Number(match[1])),
  );
  return {
    limit: Math.min(conditions.maxMinutes ?? Infinity, ...requestedLimits),
    hasRequestedLimit: requestedLimits.length > 0,
    preferQuick: requests.some(request => quickRequest.test(request)),
  };
}

function candidateReasons(conditions: SuggestionConditions, menu: Menu, options: {
  limit: number; hasHistory: boolean; revisedSide?: boolean; unhandledRequest?: boolean;
}) {
  const servingLabel = conditions.servings === null ? "" : `・${conditions.servings}人分`;
  const slot = `${slotLabel[conditions.mealType]}${servingLabel}`;
  const change = options.revisedSide ? "の副菜を差し替えた" : "の";
  const reasons = [`${slot}に向けた${menu.cuisine}${change}試験例です。`];
  if (menu.minutes > options.limit) reasons.push("希望時間を超えるため、調理時間を確認してください。");
  if (conditions.ingredients.length > 0) reasons.push("希望食材を材料欄に含めています。");
  if (options.unhandledRequest) reasons.push("試験例で反映できる自由な要望には限りがあります。");
  if (options.hasHistory) reasons.push("最近の記録と料理名が重なりにくい候補を優先しました。");
  return reasons.slice(0, 4);
}

function generateSample(context: RecommendationContext): SampleCandidate[] {
  const { conditions, previousCandidates, messages, recentDishes } = context;
  const recent = new Set(recentDishes.map(normalized));
  const cuisine = requestedCuisine(conditions.cuisine);
  const { limit, preferQuick } = timePreference(conditions, [conditions.request, ...messages]);
  const latestRequest = messages.at(-1) ?? conditions.request;
  const day = Math.floor(Date.parse(conditions.mealDate) / 86_400_000);
  const mealIndex = { BREAKFAST: 0, LUNCH: 1, DINNER: 2 }[conditions.mealType];
  const position = day + mealIndex + messages.length;
  const rotation = ((position % menus.length) + menus.length) % menus.length;
  const orderedMenus = [...menus.slice(rotation), ...menus.slice(0, rotation)];

  if (sideRequest.test(latestRequest) && previousCandidates.length >= 2) {
    const currentMenus = previousCandidates.map(candidate => menus.find(menu => menu.main[0] === candidate.dishes[0]?.name));
    if (currentMenus.every(menu => menu !== undefined) && previousCandidates.every(candidate => candidate.dishes.length >= 2)) {
      return previousCandidates.map(({ title, estimatedMinutes, dishes }, index) => ({
        title,
        estimatedMinutes,
        dishes: withRequestedIngredients([
          dishes[0],
          selectedSide(currentMenus[index], rotation + index, recent, dishes[1].name),
        ], conditions.ingredients),
        reasons: candidateReasons(conditions, currentMenus[index], { limit, hasHistory: recent.size > 0, revisedSide: true }),
      }));
    }
  }

  const previous = new Set(previousCandidates.map(candidate => candidate.dishes[0]?.name));
  const breakfast = conditions.mealType === "BREAKFAST";
  const desiredIngredients = new Set(conditions.ingredients.map(normalized));
  const minutesOverLimit = (menu: Menu) => Math.max(0, menu.minutes - limit);
  const cuisineMismatch = (menu: Menu) => Number(cuisine !== undefined && menu.cuisine !== cuisine);
  const slotMismatch = (menu: Menu) => Number(menu.breakfast !== breakfast);
  const recentMatch = (menu: Menu) => Number(recent.has(normalized(menu.main[0])));
  const ingredientMatch = (menu: Menu) => menu.main[1].filter(name => desiredIngredients.has(normalized(name))).length;
  const previousMatch = (menu: Menu) => Number(previous.has(menu.main[0]));
  const ranked = orderedMenus.sort((left, right) =>
    minutesOverLimit(left) - minutesOverLimit(right)
    || cuisineMismatch(left) - cuisineMismatch(right)
    || slotMismatch(left) - slotMismatch(right)
    || recentMatch(left) - recentMatch(right)
    || ingredientMatch(right) - ingredientMatch(left)
    || previousMatch(left) - previousMatch(right)
    || (preferQuick ? left.minutes - right.minutes : 0),
  );
  const latestTime = timePreference(conditions, [latestRequest]);
  const unhandledRequest = Boolean(latestRequest) && !latestTime.preferQuick && !latestTime.hasRequestedLimit;

  return ranked.slice(0, 3).map((menu, index) => {
    const { main, minutes } = menu;
    return {
      title: `${main[0]}の献立`,
      estimatedMinutes: minutes,
      dishes: withRequestedIngredients([
        dishFromTemplate(main),
        selectedSide(menu, rotation + index, recent),
      ], conditions.ingredients),
      reasons: candidateReasons(conditions, menu, { limit, hasHistory: recent.size > 0, unhandledRequest }),
    };
  });
}

export const sampleRecommendationProvider: RecommendationProvider = {
  model: "sample-v1",
  async generate(context, signal) {
    signal?.throwIfAborted();
    return generateSample(context);
  },
};
