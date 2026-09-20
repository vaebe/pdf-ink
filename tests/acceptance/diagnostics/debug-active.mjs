import { chromium, launchOptions, APP, FIX } from "../harness.mjs";
const browser = await chromium.launch(launchOptions({}));
const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="toolbar"]');

await page.locator('[data-testid="toolbar"] input[type=file]').setInputFiles(`${FIX}/plain.pdf`);
await page.waitForFunction(() => {
  const c = document.querySelector(".pdf-page canvas");
  return c && c.width > 0;
});
await page.waitForTimeout(500);

// 直接造一个签名，跳过手写
await page
  .locator('[data-testid="signature-library"]')
  .getByRole("button", { name: "新建签名" })
  .first()
  .click();
await page.waitForTimeout(350);
const box = await page.locator('[data-testid="signature-pad-canvas"]').boundingBox();
await page.mouse.move(box.x + 40, box.y + 150);
await page.mouse.down();
await page.mouse.move(box.x + 200, box.y + 60, { steps: 10 });
await page.mouse.move(box.x + 400, box.y + 140, { steps: 10 });
await page.mouse.up();
await page
  .locator('[data-testid="signature-pad-dialog"]')
  .getByRole("button", { name: /保存到签名库|保存中/ })
  .click();
await page.waitForSelector('[data-testid="signature-pad-dialog"]', { state: "hidden" });
console.log("签名已创建");

const snapshot = () =>
  page.evaluate(() => {
    const item = document.querySelector('[data-testid="library-item"]');
    const s = item ? getComputedStyle(item) : null;
    return {
      items: document.querySelectorAll('[data-testid="library-item"]').length,
      itemClass: item?.className ?? null,
      borderColor: s?.borderTopColor ?? null,
      background: s?.backgroundColor ?? null,
      placingHint: Boolean(
        [...document.querySelectorAll("p")].find((p) => p.textContent.includes("放置模式已开启")),
      ),
      overlayPointer: getComputedStyle(document.querySelector(".pdf-page > div:last-of-type"))
        .pointerEvents,
    };
  });

console.log("点击前:", JSON.stringify(await snapshot()));
await page.locator('[data-testid="library-item-pick"]').first().click();
for (const delay of [50, 150, 300, 600, 1000]) {
  await page.waitForTimeout(delay === 50 ? 50 : delay - (delay === 150 ? 50 : 0));
  console.log(`点击后 ~${delay}ms:`, JSON.stringify(await snapshot()));
}

const pageBox = await page.locator('.pdf-page[data-page-index="0"]').boundingBox();
await page.mouse.click(pageBox.x + pageBox.width * 0.35, pageBox.y + pageBox.height * 0.3);
await page.waitForTimeout(500);
console.log(
  "放置后:",
  JSON.stringify(
    await page.evaluate(() => ({
      placements: document.querySelectorAll('[data-testid="placement"]').length,
    })),
  ),
);

await browser.close();
