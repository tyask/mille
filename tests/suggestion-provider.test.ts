import assert from "node:assert/strict";
import test from "node:test";
import { sampleRecommendationProvider, type RecommendationContext } from "../lib/server/suggestion-provider";
import { recommendationOutputSchema } from "../lib/shared/suggestion-schemas";

const initialContext: RecommendationContext = {
  conditions: {
    mealDate: "2026-11-23",
    mealType: "BREAKFAST",
    servings: 2.5,
    ingredients: ["卵", "白菜", "白菜"],
    maxMinutes: 12,
    cuisine: "和食",
    request: "手軽に作りたい",
  },
  recentDishes: [],
  previousCandidates: [],
  messages: [],
};

async function sample(context = initialContext) {
  return recommendationOutputSchema.parse(await sampleRecommendationProvider.generate(context));
}

test("sample suggestions honor the slot, cuisine, time, people, ingredients, and have no external recipe URLs", async () => {
  const candidates = await sample();
  assert.deepEqual(candidates, await sample());
  assert.equal(candidates.length, 3);
  for (const candidate of candidates) {
    assert.match(candidate.reasons[0], /朝食・2\.5人分.*和食の試験例/u);
    assert.ok(candidate.estimatedMinutes !== null && candidate.estimatedMinutes <= 12);
    const ingredients = candidate.dishes.flatMap(dish => dish.ingredients);
    assert.ok(ingredients.some(ingredient => ingredient.name === "卵"));
    assert.equal(ingredients.filter(ingredient => ingredient.name === "白菜").length, 1);
    assert.ok(candidate.dishes.every(dish => dish.recipeUrl === null));
  }
});

test("sample suggestions move a recent dish behind otherwise comparable candidates", async () => {
  const initial = await sample();
  const repeatedMain = initial[0].dishes[0].name;
  const ranked = await sample({ ...initialContext, recentDishes: [repeatedMain] });
  assert.notEqual(ranked[0].dishes[0].name, repeatedMain);
  assert.equal(ranked.at(-1)?.dishes[0].name, repeatedMain);
});

test("a side-only request swaps the side and keeps the principal dish", async () => {
  const initial = await sample();
  const revised = await sample({
    ...initialContext,
    previousCandidates: initial.map((candidate, index) => ({ ...candidate, id: String(index) })),
    messages: ["副菜だけ変えたい"],
  });
  for (const [index, candidate] of revised.entries()) {
    assert.equal(candidate.title, initial[index].title);
    assert.deepEqual(candidate.dishes[0], initial[index].dishes[0]);
    assert.notEqual(candidate.dishes[1].name, initial[index].dishes[1].name);
    assert.match(candidate.reasons[0], /副菜を差し替えた試験例/u);
  }
});

test("a shorter time request constrains samples and impossible times get a specific note", async () => {
  const shortened = await sample({ ...initialContext, messages: ["8分以内にしたい"] });
  assert.ok(shortened.every(candidate => candidate.estimatedMinutes !== null && candidate.estimatedMinutes <= 8));
  const impossible = await sample({ ...initialContext, messages: ["1分以内にしたい"] });
  assert.ok(impossible.every(candidate => candidate.reasons.some(reason => reason.includes("希望時間を超える"))));
  await assert.rejects(sampleRecommendationProvider.generate(initialContext, AbortSignal.abort()), { name: "AbortError" });
});
