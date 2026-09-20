import { chromium, launchOptions, APP } from "../harness.mjs";
const browser = await chromium.launch(launchOptions({ headless: true }));
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.on("console", (m) => console.log("  控制台:", m.type(), m.text().slice(0, 160)));
page.on("pageerror", (e) => console.log("  页面错误:", String(e).slice(0, 200)));
await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-testid=toolbar]");
console.log("库面板存在:", await page.locator("[data-testid=signature-library]").count());
console.log("新建签名按钮:", await page.getByRole("button", { name: "新建签名" }).count());
await page
  .locator("[data-testid=signature-library]")
  .getByRole("button", { name: "新建签名" })
  .first()
  .click();
await page.waitForSelector("[data-testid=signature-pad-canvas]");
await page.waitForTimeout(300);
const box = await page.locator("[data-testid=signature-pad-canvas]").boundingBox();
console.log("画布包围盒:", JSON.stringify(box));
await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.62);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.24, { steps: 10 });
await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.7, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(200);
const save = page
  .locator("[data-testid=signature-pad-dialog]")
  .getByRole("button", { name: /保存到签名库|保存中/ });
console.log("保存按钮可见:", await save.isVisible(), "可用:", await save.isEnabled());
await save.click();
await page.waitForTimeout(1200);
console.log(
  "错误提示:",
  JSON.stringify(await page.locator("[data-testid=pad-error]").allInnerTexts()),
);
console.log("库内条目:", await page.locator("[data-testid=library-item]").count());
console.log("弹窗仍开:", await page.locator("[data-testid=signature-pad-dialog]").count());
await browser.close();
