/**
 * 复现 B2「已含数字签名」确认框的深色主题截图（验收脚本本身只跑浅色）。
 */

import { chromium, launchOptions, APP, FIX, OUT_ROOT } from "../../support/browser.mjs";
const OUT = OUT_ROOT;
const browser = await chromium.launch(launchOptions({ headless: true }));
const context = await browser.newContext({
  viewport: { width: 1600, height: 950 },
  colorScheme: "dark",
});
const page = await context.newPage();
await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-testid=toolbar]");

await page.locator("[data-testid=toolbar] input[type=file]").setInputFiles(`${FIX}/plain.pdf`);
await page.waitForFunction(() => {
  const canvas = document.querySelector(".pdf-page canvas");
  return canvas && canvas.width > 0;
});
await page.waitForTimeout(600);

await page
  .locator("[data-testid=toolbar] input[type=file]")
  .setInputFiles(`${FIX}/sig-field-signed.pdf`);
await page.waitForSelector("[data-testid=confirm-dialog]");
await page.waitForTimeout(400);

await page.screenshot({ path: `${OUT}/B2-dialog-signed-pdf-dark.png` });

console.log(
  JSON.stringify(
    await page.evaluate(() => ({
      title: document.querySelector("[data-testid=confirm-title]")?.textContent?.trim(),
      buttons: [...document.querySelectorAll("[data-testid=confirm-actions] .button")].map((b) =>
        b.textContent.trim(),
      ),
      focused: document.activeElement?.textContent?.trim(),
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      panelBackground: getComputedStyle(
        document.querySelector("[data-testid=confirm-dialog] > div"),
      ).backgroundColor,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
    })),
    null,
    2,
  ),
);

await browser.close();
