import { chromium, launchOptions, APP } from "../harness.mjs";
const browser = await chromium.launch(launchOptions({}));
const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
page.on("console", (m) => console.log("  [console]", m.type(), m.text()));
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="toolbar"]');
console.log(
  "placeholder library count:",
  await page.locator('[data-testid="signature-library"]').count(),
);

await page
  .locator('[data-testid="signature-library"]')
  .getByRole("button", { name: "新建签名" })
  .first()
  .click();
await page.waitForSelector('[data-testid="signature-pad-canvas"]');
console.log("pad open");

const box = await page.locator('[data-testid="signature-pad-canvas"]').boundingBox();
console.log("canvas box:", JSON.stringify(box));
await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.8);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2, { steps: 8 });
await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.5, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);

const state = await page.evaluate(() => ({
  saveDisabled: document.querySelector('[data-testid="signature-pad-dialog"] button:last-child')
    ?.disabled,
  error: document.querySelector('[data-testid="pad-error"]')?.textContent?.trim() ?? null,
}));
console.log("before save:", JSON.stringify(state));

await page
  .locator('[data-testid="signature-pad-dialog"]')
  .getByRole("button", { name: /保存到签名库|保存中/ })
  .click();
await page.waitForTimeout(1500);

console.log(
  "after save:",
  JSON.stringify(
    await page.evaluate(() => ({
      padOpen: Boolean(document.querySelector('[data-testid="signature-pad-dialog"]')),
      padError: document.querySelector('[data-testid="pad-error"]')?.textContent?.trim() ?? null,
      items: document.querySelectorAll('[data-testid="library-item"]').length,
      previews: document.querySelectorAll('[data-testid="library-item-preview"]').length,
      banner: document.querySelector('[data-testid="banner"]')?.textContent?.trim() ?? null,
    })),
  ),
);

await browser.close();
