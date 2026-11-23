import type { Page, Response, Route } from "playwright";
import type { MealDetail, MealSummary, MealType } from "../../lib/shared/meal-types";

type MealCase = { page: Page; checks: string[] };
type SharedMealCases = {
  owner: MealCase;
  member: MealCase;
  workspaceId: string;
  personalId: string;
  onStage: (stage: string, actor: "owner" | "member") => void;
};

const firstDate = "2026-02-05";
const secondDate = "2026-02-06";
const originalDish = "焦がし玉ねぎのスープ";
const secondDish = "じゃがいものロースト";
const revisedDish = "温野菜のロースト";
const unusedDraft = "更新競合で保持する料理名";
const replacementDish = "オートミール";

function requireCondition(condition: unknown): asserts condition {
  if (!condition) throw new Error("MEAL_BROWSER_CHECK_FAILED");
}

async function get<T>(page: Page, path: string) {
  const result = await page.evaluate(async target => {
    const response = await fetch(target, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
    return { status: response.status, body: await response.json(), cacheControl: response.headers.get("cache-control") };
  }, path);
  return result as { status: number; body: T; cacheControl: string | null };
}

function mealListPath(workspaceId: string) {
  return `/api/workspaces/${workspaceId}/meals`;
}

function rangePath(workspaceId: string) {
  return `${mealListPath(workspaceId)}?from=${firstDate}&to=2026-02-07`;
}

async function expectResponse(page: Page, method: string, path: string, status: number, action: () => Promise<unknown>): Promise<Response> {
  const [response] = await Promise.all([
    page.waitForResponse(value => value.request().method() === method && new URL(value.url()).pathname === path),
    action(),
  ]);
  requireCondition(response.status() === status);
  return response;
}

async function readDetail(response: Response): Promise<MealDetail> {
  const { meal } = await response.json() as { meal: MealDetail };
  requireCondition(meal?.id && meal.dishes.length > 0);
  return meal;
}

async function readDish(page: Page, name: string) {
  await page.getByTestId("meal-detail").getByText(name, { exact: true }).waitFor();
}

async function chooseSlot(page: Page, date: string, type: MealType) {
  const dateButton = page.locator(
    `[data-testid="meal-week-date"][data-date="${date}"], [data-testid="meal-overview-date"][data-date="${date}"], [data-testid="meal-month-date"][data-date="${date}"]`,
  ).filter({ visible: true });
  await dateButton.click();
  const slot = page.locator(
    `[data-testid="meal-week-slot"][data-date="${date}"][data-meal-type="${type}"], [data-testid="meal-day-slot"][data-date="${date}"][data-meal-type="${type}"]`,
  ).filter({ visible: true });
  await slot.click();
}

async function chooseCopyDestination(page: Page, date: string, type: MealType) {
  const dialog = page.getByTestId("meal-copy-dialog");
  await dialog.getByTestId("meal-copy-date").fill(date);
  await dialog.getByTestId("meal-copy-type").selectOption(type);
  return dialog.getByTestId("meal-copy-continue");
}

async function switchWorkspace(page: Page, id: string) {
  const switcher = page.locator(`[data-testid="workspace-switch"][data-workspace-id="${id}"]`);
  if (!await switcher.isVisible()) {
    await page.getByRole("button", { name: "ワークスペースメニューを開く", exact: true }).click();
  }
  await switcher.click();
  await page.locator(`[data-testid="workspace-selected-name"][data-workspace-id="${id}"]`).waitFor();
}

export async function verifyMealReads(entry: MealCase, workspaceId: string, otherWorkspaceId: string) {
  const { page, checks } = entry;
  const own = await get<{ meals: MealSummary[] }>(page, rangePath(workspaceId));
  const other = await get<{ code: string }>(page, rangePath(otherWorkspaceId));
  const search = await get<{ code: string }>(page, `/api/workspaces/${otherWorkspaceId}/dish-search?q=QA`);
  requireCondition(own.status === 200 && Array.isArray(own.body.meals) && own.cacheControl?.includes("no-store")
    && other.status === 404 && other.body.code === "NOT_FOUND" && search.status === 404 && search.body.code === "NOT_FOUND");
  checks.push("meal-read-membership-isolation");

  const location = new URL("/", page.url());
  location.search = new URLSearchParams({ workspace: workspaceId, date: firstDate, view: "week", meal: "DINNER" }).toString();
  await page.goto(location.href, { waitUntil: "networkidle" });
  await page.locator(`[data-testid="workspace-selected-name"][data-workspace-id="${workspaceId}"]`).waitFor();
  await page.getByTestId("meal-app").waitFor();
  const [calendarRead] = await Promise.all([
    page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === "GET" && url.pathname === mealListPath(workspaceId)
        && url.searchParams.get("from") === "2026-02-01" && url.searchParams.get("to") === "2026-03-01";
    }),
    page.getByTestId("meal-view-month").click(),
  ]);
  requireCondition(calendarRead.status() === 200 && calendarRead.headers()["cache-control"]?.includes("no-store"));
  await page.getByTestId("meal-month-date").filter({ visible: true }).first().waitFor();
  await page.getByTestId("meal-view-week").click();
  const day = page.getByTestId("meal-overview-date").or(page.getByTestId("meal-week-date"));
  await day.filter({ visible: true }).first().waitFor();
  await page.getByTestId("meal-search-input").fill("QA");
  await expectResponse(page, "GET", `/api/workspaces/${workspaceId}/dish-search`, 200, () => page.getByTestId("meal-search-submit").click());
  checks.push("meal-calendar-week-month", "meal-search-read");
}

async function retryCommittedCreate(page: Page, path: string, malformedResponse: boolean) {
  type FirstWrite = { status: number; body: string | null; key: string | undefined; meal?: MealDetail };
  let first: FirstWrite | undefined;
  const intercept = (url: URL) => url.pathname === path;
  const interruptResponse = async (route: Route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    try {
      // Commit against a disposable local workspace before altering the browser's response.
      const upstream = await route.fetch({ maxRedirects: 0 });
      first = { status: upstream.status(), body: request.postData(), key: request.headers()["idempotency-key"] };
      if (upstream.status() === 201) first.meal = (await upstream.json() as { meal: MealDetail }).meal;
    } catch {
      // The case asserts the first server-side commit after the browser offers to retry.
    } finally {
      if (malformedResponse && first?.meal) {
        const { workspaceId, mealDate, mealType } = first.meal;
        await route.fulfill({ status: 201, json: { meal: { workspaceId, mealDate, mealType } } });
      } else {
        await route.abort("connectionreset");
      }
    }
  };
  await page.route(intercept, interruptResponse);
  const save = page.getByTestId("meal-editor-save");
  const retry = page.getByTestId("meal-retry-save");
  try {
    await save.click();
    await retry.waitFor();
    requireCondition(first?.status === 201 && first.key && first.body && first.meal?.id);
    requireCondition(await page.getByTestId("meal-editor-dish-name").inputValue() === originalDish);
  } finally {
    await page.unroute(intercept, interruptResponse);
  }
  const response = await expectResponse(page, "POST", path, 201, () => retry.click());
  const replayed = await readDetail(response);
  requireCondition(response.request().postData() === first.body && response.request().headers()["idempotency-key"] === first.key
    && replayed.id === first.meal.id && replayed.version === first.meal.version);
  await page.getByTestId("meal-editor").waitFor({ state: "hidden" });
  return replayed;
}

async function verifyMealHistory(page: Page) {
  await page.reload({ waitUntil: "networkidle" });
  await readDish(page, originalDish);
  requireCondition(new URL(page.url()).searchParams.get("date") === firstDate);
  await page.getByTestId("meal-view-month").click();
  await page.getByTestId("meal-month-date").filter({ visible: true }).first().waitFor();
  await page.getByRole("button", { name: "次の月", exact: true }).click();
  await page.waitForURL(url => url.searchParams.get("date")?.startsWith("2026-03-") === true);
  await page.getByTestId("meal-detail-add").waitFor();
  await page.getByTestId("meal-detail-add").click();
  await page.getByTestId("meal-editor").waitFor();
  await page.goBack();
  await page.getByTestId("meal-editor").waitFor({ state: "hidden" });
  await readDish(page, originalDish);
  requireCondition(new URL(page.url()).searchParams.get("date") === firstDate
    && new URL(page.url()).searchParams.get("view") === "month");
  await page.getByTestId("meal-view-week").click();
}

async function addRecipeAndIngredients(page: Page) {
  await page.getByTestId("meal-editor-add-ingredient").first().click();
  await page.getByTestId("meal-editor-ingredient-name").fill("玉ねぎ");
  await page.getByTestId("meal-editor-ingredient-amount").fill("1/2");
  await page.getByTestId("meal-editor-ingredient-unit").fill("個");
  await page.getByTestId("meal-editor-recipe-mode").first().selectOption("text");
  await page.getByTestId("meal-editor-recipe-text").fill("弱火で炒めてから煮る");
  await page.getByTestId("meal-editor-add-dish").click();
  await page.getByTestId("meal-editor-dish-name").nth(1).fill(secondDish);
  await page.getByTestId("meal-editor-dish-servings").nth(1).fill("3");
  await page.getByTestId("meal-editor-recipe-mode").nth(1).selectOption("url");
  await page.getByTestId("meal-editor-recipe-url").fill("https://example.com/recipe");
}

async function cancelDirtyEditor(page: Page) {
  const confirmation = page.waitForEvent("dialog");
  await Promise.all([
    confirmation.then(dialog => dialog.accept()),
    page.getByTestId("meal-editor-cancel").click(),
  ]);
  await page.getByTestId("meal-editor").waitFor({ state: "hidden" });
}

async function deleteSelectedMeal(page: Page, path: string) {
  await page.getByTestId("meal-detail-delete").click();
  await page.getByTestId("meal-delete-dialog").waitFor();
  await expectResponse(page, "DELETE", path, 204, () => page.getByTestId("meal-delete-confirm").click());
  await page.getByTestId("meal-detail-add").waitFor();
}

async function verifySearch(page: Page) {
  const input = page.getByTestId("meal-search-input");
  await input.fill(originalDish);
  await page.getByTestId("meal-search-submit").click();
  const results = page.getByTestId("meal-search-result");
  const source = results.and(page.locator(`[data-date="${firstDate}"]`));
  await source.waitFor();
  await results.and(page.locator(`[data-date="${secondDate}"]`)).waitFor();
  requireCondition(await results.count() === 2);
  await source.click();
  await readDish(page, originalDish);
  requireCondition(new URL(page.url()).searchParams.get("date") === firstDate);
}

async function verifyLateWorkspaceResponse(page: Page, workspaceId: string, personalId: string) {
  const oldPath = mealListPath(workspaceId);
  const matches = (url: URL) => url.pathname === oldPath;
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  let served = false;
  const hold = async (route: Route) => {
    try {
      const oldResponse = await route.fetch({ maxRedirects: 0 });
      requireCondition(oldResponse.status() === 200);
      const { meals } = await oldResponse.json() as { meals: MealSummary[] };
      requireCondition(meals.some(meal => meal.dishes.some(dish => dish.name === originalDish)));
      requested.resolve();
      await release.promise;
      try { await route.fulfill({ response: oldResponse }); } catch { /* Workspace switch may cancel this request. */ }
      served = true;
    } catch (error) {
      requested.reject(error);
    } finally {
      await route.abort().catch(() => undefined);
      finished.resolve();
    }
  };
  await page.route(matches, hold, { times: 1 });
  const requestDeadline = setTimeout(() => requested.reject(new Error("MEAL_REFRESH_NOT_REQUESTED")), 15_000);
  try {
    await Promise.all([requested.promise, page.getByTestId("workspace-refresh").click()]);
    await expectResponse(page, "GET", mealListPath(personalId), 200, () => switchWorkspace(page, personalId));
    release.resolve();
    await finished.promise;
    requireCondition(served);
    await page.getByTestId("meal-detail-add").waitFor();
    requireCondition(!await page.getByTestId("meal-app").getByText(originalDish, { exact: true }).isVisible());
  } finally {
    clearTimeout(requestDeadline);
    release.resolve();
    await page.unroute(matches, hold);
  }
  await switchWorkspace(page, workspaceId);
  await readDish(page, originalDish);
}

export async function verifySharedMeals({ owner, member, workspaceId, personalId, onStage }: SharedMealCases) {
  const path = mealListPath(workspaceId);
  const ownerPage = owner.page;
  const memberPage = member.page;

  onStage("meal-create-retry", "owner");
  await ownerPage.getByTestId("meal-register").click();
  await ownerPage.getByTestId("meal-editor-date").fill(firstDate);
  await ownerPage.getByTestId("meal-editor-type").selectOption("DINNER");
  await ownerPage.getByTestId("meal-editor-dish-name").fill(originalDish);
  const malformedResponse = await ownerPage.evaluate(() => matchMedia("(pointer: coarse)").matches);
  const initial = await retryCommittedCreate(ownerPage, path, malformedResponse);
  requireCondition(initial.mealDate === firstDate && initial.mealType === "DINNER"
    && initial.servings === null && initial.dishes.length === 1 && initial.dishes[0].ingredients.length === 0);
  const initialList = await get<{ meals: MealSummary[] }>(ownerPage, rangePath(workspaceId));
  requireCondition(initialList.status === 200 && initialList.body.meals.length === 1 && initialList.body.meals[0].id === initial.id);
  owner.checks.push("meal-minimal-create-ui", malformedResponse ? "meal-malformed-response-idempotent-retry" : "meal-lost-response-idempotent-retry");

  onStage("meal-reload-and-back", "owner");
  await verifyMealHistory(ownerPage);
  owner.checks.push("meal-selection-reload-and-history");

  onStage("meal-shared-detail", "member");
  await memberPage.goto(ownerPage.url(), { waitUntil: "networkidle" });
  await readDish(memberPage, originalDish);
  await memberPage.getByTestId("meal-detail-edit").click();
  await memberPage.getByTestId("meal-editor-dish-name").fill(unusedDraft);

  onStage("meal-edit", "owner");
  await ownerPage.getByTestId("meal-detail-edit").click();
  await addRecipeAndIngredients(ownerPage);
  const edit = await expectResponse(ownerPage, "PUT", `${path}/${initial.id}`, 200, () => ownerPage.getByTestId("meal-editor-save").click());
  const edited = await readDetail(edit);
  requireCondition(edited.version === initial.version + 1 && edited.dishes[0].id === initial.dishes[0].id
    && edited.dishes[0].ingredients[0].amountText === "1/2" && edited.dishes[0].ingredients[0].unit === "個"
    && edited.dishes[0].recipeText === "弱火で炒めてから煮る" && edited.dishes[0].recipeUrl === null
    && edited.dishes[1].servings === 3 && edited.dishes[1].recipeText === null && edited.dishes[1].recipeUrl === "https://example.com/recipe");
  owner.checks.push("meal-dishes-ingredients-recipe-edit-ui");

  onStage("meal-version-conflict", "member");
  const conflict = await expectResponse(memberPage, "PUT", `${path}/${initial.id}`, 409, () => memberPage.getByTestId("meal-editor-save").click());
  requireCondition((await conflict.json() as { code: string }).code === "VERSION_CONFLICT");
  await memberPage.getByTestId("meal-conflict").getByRole("heading", { name: secondDish, exact: true }).waitFor();
  requireCondition(await memberPage.getByTestId("meal-editor-dish-name").inputValue() === unusedDraft);
  await cancelDirtyEditor(memberPage);
  await memberPage.reload({ waitUntil: "networkidle" });
  await readDish(memberPage, secondDish);
  member.checks.push("meal-version-conflict-retains-input-and-shows-latest");

  onStage("meal-member-edit", "member");
  await memberPage.getByTestId("meal-detail-edit").click();
  await memberPage.getByTestId("meal-editor-dish-name").nth(1).fill(revisedDish);
  const memberEdit = await expectResponse(memberPage, "PUT", `${path}/${initial.id}`, 200, () => memberPage.getByTestId("meal-editor-save").click());
  const source = await readDetail(memberEdit);
  requireCondition(source.dishes[1].name === revisedDish && source.version === edited.version + 1);
  await ownerPage.reload({ waitUntil: "networkidle" });
  await readDish(ownerPage, revisedDish);
  member.checks.push("meal-shared-member-edit-ui");
  owner.checks.push("meal-shared-member-update-visible");

  onStage("meal-copy-whole", "owner");
  await ownerPage.getByTestId("meal-detail-copy").click();
  const copy = await chooseCopyDestination(ownerPage, secondDate, "LUNCH");
  const copyResponse = await expectResponse(ownerPage, "POST", `${path}/${source.id}/copies`, 201, () => copy.click());
  const copied = await readDetail(copyResponse);
  requireCondition(copied.id !== source.id && copied.mealDate === secondDate && copied.mealType === "LUNCH"
    && copied.dishes[0].name === originalDish && copied.dishes[0].id !== source.dishes[0].id
    && copied.dishes[0].ingredients[0].id !== source.dishes[0].ingredients[0].id
    && copied.dishes[0].ingredients[0].amountText === "1/2");
  owner.checks.push("meal-whole-copy-ui");

  onStage("meal-search-different-dates", "owner");
  await verifySearch(ownerPage);
  owner.checks.push("meal-search-results-distinct-dates");

  onStage("meal-copy-dish-to-existing", "owner");
  await ownerPage.locator(`[data-testid="meal-detail-copy-dish"][data-dish-id="${source.dishes[0].id}"]`).click();
  await (await chooseCopyDestination(ownerPage, secondDate, "LUNCH")).click();
  const appendedDish = ownerPage.getByTestId("meal-editor-dish-name").nth(2);
  await appendedDish.waitFor();
  requireCondition(await appendedDish.inputValue() === originalDish);
  await ownerPage.getByTestId("meal-editor-confirm-copy-servings").check();
  const append = await expectResponse(ownerPage, "PUT", `${path}/${copied.id}`, 200, () => ownerPage.getByTestId("meal-editor-save").click());
  const appended = await readDetail(append);
  requireCondition(appended.dishes.length === 3 && appended.dishes[0].id === copied.dishes[0].id
    && appended.dishes[1].id === copied.dishes[1].id && appended.dishes[2].name === originalDish
    && appended.dishes[2].id !== source.dishes[0].id && appended.dishes[2].ingredients[0].amountText === "1/2");
  owner.checks.push("meal-single-dish-copy-existing-slot-ui", "meal-copy-unknown-servings-confirmation");

  onStage("meal-copy-dish-to-empty", "owner");
  await chooseSlot(ownerPage, firstDate, "DINNER");
  await ownerPage.locator(`[data-testid="meal-detail-copy-dish"][data-dish-id="${source.dishes[1].id}"]`).click();
  await (await chooseCopyDestination(ownerPage, secondDate, "BREAKFAST")).click();
  const servingField = ownerPage.getByTestId("meal-editor-dish-servings");
  await servingField.waitFor();
  requireCondition(await servingField.inputValue() === "3");
  const single = await expectResponse(ownerPage, "POST", path, 201, () => ownerPage.getByTestId("meal-editor-save").click());
  const singleMeal = await readDetail(single);
  requireCondition(singleMeal.mealType === "BREAKFAST" && singleMeal.mealDate === secondDate
    && singleMeal.dishes.length === 1 && singleMeal.dishes[0].name === revisedDish && singleMeal.dishes[0].servings === 3);
  const unchanged = await get<{ meal: MealDetail }>(ownerPage, `${path}/${initial.id}`);
  requireCondition(unchanged.status === 200 && unchanged.body.meal.version === source.version
    && JSON.stringify(unchanged.body.meal.dishes) === JSON.stringify(source.dishes));
  owner.checks.push("meal-single-dish-copy-empty-slot-ui", "meal-copy-preserves-source");

  onStage("meal-edit-replaced-slot", "owner");
  await readDish(ownerPage, revisedDish);
  await ownerPage.getByTestId("meal-detail-edit").click();
  await ownerPage.getByTestId("meal-editor-dish-name").fill(unusedDraft);
  onStage("meal-replace-edited-slot", "member");
  await memberPage.reload({ waitUntil: "networkidle" });
  await chooseSlot(memberPage, secondDate, "BREAKFAST");
  await readDish(memberPage, revisedDish);
  await deleteSelectedMeal(memberPage, `${path}/${singleMeal.id}`);
  await memberPage.getByTestId("meal-detail-add").click();
  await memberPage.getByTestId("meal-editor-dish-name").fill(replacementDish);
  const replacementResponse = await expectResponse(memberPage, "POST", path, 201, () => memberPage.getByTestId("meal-editor-save").click());
  const replacement = await readDetail(replacementResponse);
  requireCondition(replacement.id !== singleMeal.id && replacement.mealDate === secondDate && replacement.mealType === "BREAKFAST");

  onStage("meal-replaced-slot-conflict", "owner");
  const removed = await expectResponse(ownerPage, "PUT", `${path}/${singleMeal.id}`, 404, () => ownerPage.getByTestId("meal-editor-save").click());
  requireCondition((await removed.json() as { code: string }).code === "NOT_FOUND");
  await ownerPage.getByTestId("meal-conflict").getByRole("heading", { name: replacementDish, exact: true }).waitFor();
  requireCondition(await ownerPage.getByTestId("meal-editor-dish-name").inputValue() === unusedDraft);
  await cancelDirtyEditor(ownerPage);
  owner.checks.push("meal-replaced-slot-retains-input-and-shows-latest");

  onStage("meal-shared-delete", "member");
  await memberPage.reload({ waitUntil: "networkidle" });
  await chooseSlot(memberPage, secondDate, "LUNCH");
  await deleteSelectedMeal(memberPage, `${path}/${copied.id}`);
  requireCondition((await get(memberPage, `${path}/${copied.id}`)).status === 404);
  member.checks.push("meal-shared-member-delete-ui");

  onStage("meal-late-workspace-response", "owner");
  await chooseSlot(ownerPage, firstDate, "DINNER");
  await readDish(ownerPage, originalDish);
  await verifyLateWorkspaceResponse(ownerPage, workspaceId, personalId);
  owner.checks.push("meal-switch-ignores-late-workspace-response");
}
