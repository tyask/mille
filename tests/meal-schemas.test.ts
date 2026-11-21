import assert from "node:assert/strict";
import test from "node:test";
import { createMealSchema, deleteMealSchema, mealRangeSchema, updateMealSchema } from "../lib/shared/meal-schemas";

const draft = { mealDate: "2028-02-29", mealType: "DINNER", dishes: [{ name: " 鮭 " }] };

test("meal input retains quantity text, normalizes optional values and keeps a date without a time zone", () => {
  assert.deepEqual(createMealSchema.parse(draft), {
    mealDate: "2028-02-29", mealType: "DINNER", servings: null,
    dishes: [{ name: "鮭", servings: null, recipeText: null, recipeUrl: null, ingredients: [] }],
  });
  const input = createMealSchema.parse({
    ...draft, servings: 0.29,
    dishes: [{
      name: "鮭", servings: 0.57, recipeText: "  包む\n蒸す  ", recipeUrl: " ",
      ingredients: [
        { name: "玉ねぎ", amountText: " 1/2 ", unit: "個" },
        { name: "塩", amountText: "少々" },
        { name: "油", amountText: "0" },
        { name: "こしょう", amountText: "" },
      ],
    }],
  });
  assert.equal(input.servings, 0.29);
  assert.equal(input.dishes[0].servings, 0.57);
  assert.equal(input.dishes[0].recipeText, "包む\n蒸す");
  assert.equal(input.dishes[0].recipeUrl, null);
  assert.deepEqual(input.dishes[0].ingredients.map(item => [item.amountText, item.unit]), [
    ["1/2", "個"], ["少々", null], ["0", null], [null, null],
  ]);
});

test("meal input rejects impossible dates, invalid servings, unknown fields and nonnew child IDs", () => {
  for (const mealDate of ["2026-02-29", "2028-04-31", "0000-01-01", "2028-02-29T00:00:00Z"]) {
    assert.equal(createMealSchema.safeParse({ ...draft, mealDate }).success, false, mealDate);
  }
  for (const servings of [0, -1, 100, 0.001, 1.234, "2"]) {
    assert.equal(createMealSchema.safeParse({ ...draft, servings }).success, false, String(servings));
  }
  assert.equal(createMealSchema.safeParse({ ...draft, mealType: "SNACK" }).success, false);
  assert.equal(createMealSchema.safeParse({ ...draft, status: "PLANNED" }).success, false);
  assert.equal(createMealSchema.safeParse({ ...draft, dishes: [{ name: "鮭", id: "assigned-by-client" }] }).success, false);
  assert.equal(createMealSchema.safeParse({ ...draft, dishes: [{ name: "鮭", ingredients: [{ name: "塩", id: "client" }] }] }).success, false);
  for (const name of ["　", "a\0b", "\uD800"]) {
    assert.equal(createMealSchema.safeParse({ ...draft, dishes: [{ name }] }).success, false);
  }
});

test("meal input enforces URL policy, recipe exclusivity and size limits", () => {
  const recipeUrl = "https://example.invalid/献立";
  assert.equal(createMealSchema.parse({ ...draft, dishes: [{ name: "鮭", recipeUrl }] }).dishes[0].recipeUrl, recipeUrl);
  for (const unsafeUrl of ["/recipe", "https:example.invalid", "ftp://example.invalid/", "https://user@example.invalid/",
    "https://@example.invalid/", "https://", "https://example.invalid/a b"]) {
    assert.equal(createMealSchema.safeParse({ ...draft, dishes: [{ name: "鮭", recipeUrl: unsafeUrl }] }).success, false, unsafeUrl);
  }
  assert.equal(createMealSchema.safeParse({ ...draft, dishes: [{ name: "鮭", recipeText: "蒸す", recipeUrl }] }).success, false);
  assert.equal(createMealSchema.safeParse({ ...draft, dishes: [] }).success, false);
  assert.equal(createMealSchema.safeParse({ ...draft, dishes: Array(21).fill(draft.dishes[0]) }).success, false);
  assert.equal(createMealSchema.safeParse({ ...draft, dishes: [{ name: "🐟".repeat(120) }] }).success, true);
  assert.equal(createMealSchema.safeParse({ ...draft, dishes: [{ name: "🐟".repeat(121) }] }).success, false);
  assert.equal(createMealSchema.safeParse({
    ...draft, dishes: [{ name: "鮭", ingredients: Array(101).fill({ name: "塩" }) }],
  }).success, false);
});

test("replacement and deletion require valid versions and ranges are at most 62 days", () => {
  assert.equal(updateMealSchema.safeParse({ ...draft, expectedVersion: 1 }).success, false);
  const normalized = createMealSchema.parse(draft);
  assert.equal(updateMealSchema.safeParse({ ...normalized, expectedVersion: 1 }).success, true);
  assert.equal(updateMealSchema.safeParse({
    ...normalized, expectedVersion: 2,
    dishes: [{ ...normalized.dishes[0], id: "retained-dish", ingredients: [{ id: "retained-item", name: "塩", amountText: null, unit: null }] }],
  }).success, true);
  for (const expectedVersion of [0, -1, 1.5, "1", 2_147_483_648]) {
    assert.equal(deleteMealSchema.safeParse({ expectedVersion }).success, false);
  }
  assert.equal(mealRangeSchema.safeParse({ from: "2026-01-01", to: "2026-03-04" }).success, true);
  assert.equal(mealRangeSchema.safeParse({ from: "9999-12-31", to: "+010000-01-01" }).success, true);
  assert.equal(mealRangeSchema.safeParse({ from: "9999-10-30", to: "+010000-01-01" }).success, false);
  assert.equal(createMealSchema.safeParse({ ...draft, mealDate: "+010000-01-01" }).success, false);
  for (const to of ["2025-12-31", "2026-01-01", "2026-03-05"]) {
    assert.equal(mealRangeSchema.safeParse({ from: "2026-01-01", to }).success, false, to);
  }
});
