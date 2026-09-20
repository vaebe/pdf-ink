// 审查探针 8：先打开 PDF 让工具栏按钮可用，再对比 toggled 与普通 ghost 按钮的 hover 表现。

import { chromium, launchOptions, APP, FIX } from "../../support/browser.mjs";
const browser = await chromium.launch(launchOptions({ headless: true }));
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.goto(APP, { waitUntil: "domcontentloaded" });

await page.locator("[data-testid=toolbar] input[type=file]").setInputFiles(`${FIX}/plain.pdf`);
await page.waitForSelector("[data-testid=pdf-scroller] canvas", { timeout: 20000 });
await page.waitForTimeout(600);

const styleOf = (text) =>
  page.evaluate((label) => {
    const button = [...document.querySelectorAll("[data-testid=toolbar] button")].find(
      (item) => item.textContent?.trim() === label,
    );
    const s = getComputedStyle(button);
    return { classes: button.className, border: s.borderColor, bg: s.backgroundColor };
  }, text);

console.log("自适应宽度 静止:", JSON.stringify(await styleOf("自适应宽度")));
await page.locator("[data-testid=toolbar] button", { hasText: "自适应宽度" }).hover();
await page.waitForTimeout(200);
console.log("自适应宽度 hover:", JSON.stringify(await styleOf("自适应宽度")));

await page.locator("[data-testid=toolbar] button", { hasText: "自适应宽度" }).click();
await page.mouse.move(700, 800);
await page.waitForTimeout(200);
console.log("关闭 toggled 后 静止:", JSON.stringify(await styleOf("自适应宽度")));
await page.locator("[data-testid=toolbar] button", { hasText: "自适应宽度" }).hover();
await page.waitForTimeout(200);
console.log("关闭 toggled 后 hover:", JSON.stringify(await styleOf("自适应宽度")));

// 再切回 toggled，观察 hover 是否覆盖激活态
await page.locator("[data-testid=toolbar] button", { hasText: "自适应宽度" }).click();
await page.mouse.move(700, 800);
await page.waitForTimeout(200);
console.log("恢复 toggled 后 hover:", JSON.stringify(await styleOf("自适应宽度")));
await browser.close();
