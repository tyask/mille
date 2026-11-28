import assert from "node:assert/strict";
import jsQR from "jsqr";
import type { Page } from "playwright";

export async function verifyMobileAccessQr(page: Page, origin: string, mobile: boolean) {
  const panel = page.getByTestId("mobile-access-qr");
  if (mobile) {
    await panel.waitFor({ state: "attached" });
    assert(await panel.evaluate(element => getComputedStyle(element).display === "none"), "The mobile menu must hide the login QR.");
    return;
  }

  await panel.waitFor({ state: "visible" });
  const loginUrl = new URL("/", origin).href;
  const link = panel.getByRole("link", { name: "milleのログインページを開く" });
  assert(await link.getAttribute("href") === loginUrl, "The mobile login link must point to this environment's home.");

  const screenshot = await panel.getByTestId("mobile-access-qr-code").screenshot({ scale: "css" });
  const pixels = await page.evaluate(async (png) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(png)], { type: "image/png" }));
    const { width, height } = bitmap;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Cannot read QR screenshot pixels.");
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return { width, height, data: Array.from(context.getImageData(0, 0, width, height).data) };
  }, [...screenshot]);

  const code = jsQR(Uint8ClampedArray.from(pixels.data), pixels.width, pixels.height, { inversionAttempts: "dontInvert" });
  assert(code?.data === loginUrl, "The displayed QR must decode to this environment's home.");
  return code.data;
}
