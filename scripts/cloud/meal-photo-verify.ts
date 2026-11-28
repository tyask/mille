import type { Page } from "playwright";
import sharp from "sharp";
import type { MealDetail } from "../../lib/shared/meal-types";

type PhotoCase = { page: Page; checks: string[] };

function requirePhoto(condition: unknown): asserts condition {
  if (!condition) throw new Error("MEAL_PHOTO_BROWSER_CHECK_FAILED");
}

async function photoResponse(page: Page, path: string) {
  return page.evaluate(async url => {
    const response = await fetch(url, { cache: "no-store" });
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      cache: response.headers.get("cache-control"),
      bytes: (await response.arrayBuffer()).byteLength,
    };
  }, path);
}

async function uploadPhoto(page: Page, photos: string, image: Buffer) {
  const [complete] = await Promise.all([
    page.waitForResponse(response => {
      const { pathname } = new URL(response.url());
      return response.request().method() === "POST" && pathname.startsWith(`${photos}/`) && pathname.endsWith("/complete");
    }, { timeout: 15_000 }),
    page.getByTestId("meal-photo-file").setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: image }),
  ]);
  requirePhoto(complete.status() === 200);
  return new URL(complete.url()).pathname.slice(0, -"/complete".length);
}

export async function verifyMealPhotoFlow(
  owner: PhotoCase, member: PhotoCase, workspaceId: string, personalId: string,
  onStage: (stage: string, actor: "owner" | "member") => void,
) {
  const page = owner.page;
  const workspaceApi = `/api/workspaces/${encodeURIComponent(workspaceId)}`;
  const meals = `${workspaceApi}/meals`;
  const photos = `${workspaceApi}/meal-photos`;
  const image = await sharp({
    create: { width: 80, height: 60, channels: 3, background: "#dfad67" },
  }).png().toBuffer();
  const name = "手入力の鮭料理";

  onStage("meal-photo-upload", "owner");
  await page.getByTestId("meal-register").click();
  await page.getByTestId("meal-editor-date").fill("2026-02-14");
  await page.getByTestId("meal-editor-type").selectOption("LUNCH");
  await page.getByTestId("meal-editor-dish-name").fill(name);
  const photoUrl = await uploadPhoto(page, photos, image);
  const photoId = photoUrl.split("/").at(-1);
  const preview = page.getByTestId("meal-photo-preview");
  await preview.waitFor();
  const previewSrc = await preview.getAttribute("src");
  requirePhoto(previewSrc === photoUrl);
  await preview.scrollIntoViewIfNeeded();
  await preview.evaluate(element => (element as HTMLImageElement).decode());
  onStage("meal-photo-draft-isolation", "member");
  requirePhoto(await photoResponse(member.page, photoUrl).then(response => response.status) === 404);
  requirePhoto(await photoResponse(member.page, `/api/workspaces/${encodeURIComponent(personalId)}/meal-photos/${photoId}`)
    .then(response => response.status) === 404);

  onStage("meal-photo-analysis-failure", "owner");
  await page.route(`**${photoUrl}/analysis`, route => route.fulfill({
    status: 502, json: { error: "写真を解析できませんでした。" },
  }), { times: 1 });
  const analyze = page.getByTestId("meal-photo-analyze");
  await analyze.click();
  await page.getByText(/写真を添付したまま手入力で記録できます/u).waitFor();
  requirePhoto(await page.getByTestId("meal-editor-dish-name").inputValue() === name && await preview.isVisible()
    && await page.getByTestId("meal-editor-save").isEnabled());

  onStage("meal-photo-analysis-review", "owner");
  await analyze.click();
  await page.getByTestId("meal-photo-analysis-dish").selectOption("1");
  requirePhoto(await page.getByTestId("meal-photo-analysis-name").inputValue() === "玉ねぎのみそ汁");
  await page.getByTestId("meal-photo-analysis-amount").first().fill("");
  await page.getByTestId("meal-photo-analysis-unit").first().fill("");
  await page.getByTestId("meal-photo-analysis-apply").click();
  requirePhoto(await page.getByTestId("meal-editor-dish-name").inputValue() === name);
  onStage("meal-photo-save", "owner");
  const [created] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === meals, { timeout: 15_000 }),
    page.getByTestId("meal-editor-save").click(),
  ]);
  requirePhoto(created.status() === 201);
  const { meal } = await created.json() as { meal: MealDetail };
  requirePhoto(meal.dishes[0].photoId === photoId && meal.dishes[0].name === name
    && meal.dishes[0].ingredients.some(ingredient => ingredient.name === "玉ねぎ" && ingredient.amountText === null));
  await page.getByTestId("meal-detail-photo").waitFor();
  onStage("meal-photo-shared-read", "member");
  const shared = await photoResponse(member.page, photoUrl);
  requirePhoto(shared.status === 200 && shared.contentType === "image/webp" && shared.cache?.includes("no-store")
    && shared.bytes > 0);
  owner.checks.push("meal-photo-manual-fallback-and-review", "meal-photo-confirmed-save");
  member.checks.push("meal-photo-draft-denial-and-shared-read");

  onStage("meal-photo-missing-attachment", "owner");
  await page.getByTestId("meal-detail-edit").click();
  const firstDraft = await uploadPhoto(page, photos, image);
  await page.locator(`[data-testid="meal-photo-preview"][src="${firstDraft}"]`).waitFor();
  const [discarded, replacement] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "DELETE" && new URL(response.url()).pathname === firstDraft,
      { timeout: 15_000 }),
    uploadPhoto(page, photos, image),
  ]);
  requirePhoto(discarded.status() === 204 && await photoResponse(page, firstDraft).then(response => response.status) === 404);
  await page.locator(`[data-testid="meal-photo-preview"][src="${replacement}"]`).waitFor();
  requirePhoto(await page.evaluate(async path => (await fetch(path, { method: "DELETE" })).status, replacement) === 204);
  const revisedName = "手入力を保持した鮭料理";
  await page.getByTestId("meal-editor-dish-name").fill(revisedName);
  const editPath = `${meals}/${meal.id}`;
  const saved = () => page.waitForResponse(response =>
    response.request().method() === "PUT" && new URL(response.url()).pathname === editPath, { timeout: 15_000 });
  const save = page.getByTestId("meal-editor-save");
  const [missing] = await Promise.all([saved(), save.click()]);
  requirePhoto(missing.status() === 400);
  await page.getByText("添付する写真が見つかりません。写真を選び直してください。").waitFor();
  requirePhoto(await page.getByTestId("meal-editor-dish-name").inputValue() === revisedName && await save.isEnabled());
  owner.checks.push("meal-photo-expired-attachment-retains-edits");

  onStage("meal-photo-detach", "owner");
  await page.getByTestId("meal-photo-remove").click();
  const [detached] = await Promise.all([saved(), save.click()]);
  requirePhoto(detached.status() === 200 && await photoResponse(member.page, photoUrl)
    .then(response => response.status) === 404);
  owner.checks.push("meal-photo-detach-and-reclaim");
}
