/**
 * 确认弹窗外观与交互探测：截图两处弹窗，并验证 Esc / 背景点击 / Tab 焦点陷阱。
 */

import { chromium, launchOptions, APP, FIX, OUT_ROOT } from "../../support/browser.mjs";
const OUT = OUT_ROOT + "/";
const browser = await chromium.launch(launchOptions({ headless: true }));
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
page.on("dialog", () => console.log("!! 出现原生弹窗"));

await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".toolbar");

// ---- 1) 已签名文档弹窗 ----
await page.locator(".toolbar input[type=file]").setInputFiles(`${FIX}/sig-field-signed.pdf`);
const dialog = page.locator(".modal--dialog");
await dialog.waitFor({ state: "visible", timeout: 8000 });
await page.waitForTimeout(320);
console.log("标题:", await dialog.locator(".confirm__title").innerText());
console.log("正文:", await dialog.locator(".confirm__message").innerText());
console.log("补充:", await dialog.locator(".confirm__details li").allInnerTexts());
console.log("按钮:", await dialog.locator(".confirm__actions .button").allInnerTexts());
console.log("初始焦点:", await page.evaluate(() => document.activeElement?.textContent?.trim()));
console.log("背景遮罩层级 z-index:", await dialog.evaluate((el) => getComputedStyle(el).zIndex));
await page.screenshot({ path: `${OUT}/dialog-signed-light.png` });

// Esc 取消
await page.keyboard.press("Escape");
await dialog.waitFor({ state: "hidden", timeout: 5000 });
console.log(
  "Esc 取消后弹窗存在:",
  await dialog.count(),
  "会话:",
  await page.locator(".toolbar__filename").innerText(),
);

// 再开一次，点背景取消
await page.locator(".toolbar input[type=file]").setInputFiles(`${FIX}/sig-field-signed.pdf`);
await dialog.waitFor({ state: "visible", timeout: 8000 });
await page.mouse.click(40, 60);
await dialog.waitFor({ state: "hidden", timeout: 5000 });
console.log("背景点击取消后会话:", (await page.locator(".toolbar__filename").innerText()).trim());

// 再开一次，Tab 焦点陷阱 + 确认
await page.locator(".toolbar input[type=file]").setInputFiles(`${FIX}/sig-field-signed.pdf`);
await dialog.waitFor({ state: "visible", timeout: 8000 });
const focusTrail = [];
for (let index = 0; index < 4; index += 1) {
  focusTrail.push(await page.evaluate(() => document.activeElement?.textContent?.trim() ?? ""));
  await page.keyboard.press("Tab");
  await page.waitForTimeout(60);
}
console.log("Tab 焦点序列:", focusTrail);
await dialog.getByRole("button", { name: "仍然编辑" }).click();
await dialog.waitFor({ state: "hidden", timeout: 5000 });
await page.waitForFunction(() => document.querySelectorAll(".pdf-page").length === 1, null, {
  timeout: 25000,
});
console.log("确认后会话:", (await page.locator(".toolbar__filename").innerText()).trim());

// ---- 2) 放弃编辑弹窗 ----
await page.locator(".panel--library").getByRole("button", { name: "新建签名" }).first().click();
await page.waitForSelector(".modal .pad__canvas");
await page.locator(".modal .field__input").fill("探测甲");
const pad = await page.locator(".pad__canvas").boundingBox();
await page.mouse.move(pad.x + pad.width * 0.2, pad.y + pad.height * 0.75);
await page.mouse.down();
await page.mouse.move(pad.x + pad.width * 0.75, pad.y + pad.height * 0.3, { steps: 10 });
await page.mouse.up();
await page
  .locator(".modal")
  .getByRole("button", { name: /保存到签名库|保存中/ })
  .click();
await page.waitForFunction(() => document.querySelectorAll(".library-item").length === 1, null, {
  timeout: 15000,
});
await page.waitForTimeout(400);
await page.locator(".library-item__pick").nth(0).click();
await page.waitForTimeout(200);
await page.mouse.click(700, 400);
await page.waitForTimeout(300);
console.log("页面上签名数:", await page.locator(".signature-item").count());
await page.locator(".toolbar input[type=file]").setInputFiles(`${FIX}/plain.pdf`);
await dialog.waitFor({ state: "visible", timeout: 8000 });
await page.waitForTimeout(320);
console.log("标题:", await dialog.locator(".confirm__title").innerText());
console.log("正文:", await dialog.locator(".confirm__message").innerText());
console.log("补充:", await dialog.locator(".confirm__details li").allInnerTexts());
console.log("按钮:", await dialog.locator(".confirm__actions .button").allInnerTexts());
await page.screenshot({ path: `${OUT}/dialog-discard-light.png` });
await dialog.getByRole("button", { name: "取消" }).click();
await dialog.waitFor({ state: "hidden", timeout: 5000 });
console.log(
  "取消后 会话:",
  (await page.locator(".toolbar__filename").innerText()).trim(),
  "签名数:",
  await page.locator(".signature-item").count(),
);

// ---- 3) 深色主题外观 ----
await context.close();
const darkContext = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  colorScheme: "dark",
});
const darkPage = await darkContext.newPage();
await darkPage.goto(APP, { waitUntil: "domcontentloaded" });
await darkPage.waitForSelector(".toolbar");
await darkPage.locator(".toolbar input[type=file]").setInputFiles(`${FIX}/sig-field-signed.pdf`);
await darkPage.locator(".modal--dialog").waitFor({ state: "visible", timeout: 8000 });
await darkPage.waitForTimeout(320);
await darkPage.screenshot({ path: `${OUT}/dialog-signed-dark.png` });

await browser.close();
console.log("完成");
