// 审查探针 6：切换态按钮在 hover 时样式是否被 .button--ghost 的 hover 规则盖掉（特异性 3 > 1）。

import { chromium, launchOptions, APP } from "../harness.mjs";
const browser = await chromium.launch(launchOptions({ headless: true }));
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.goto(APP, { waitUntil: "domcontentloaded" });

const read = () =>
  page.evaluate(() => {
    const button = [...document.querySelectorAll("[data-testid=toolbar] button")].find(
      (item) => item.textContent?.trim() === "自适应宽度",
    );
    const style = getComputedStyle(button);
    return {
      classes: button.className,
      border: style.borderColor,
      bg: style.backgroundColor,
      color: style.color,
    };
  });

console.log("静止（toggled）:", JSON.stringify(await read()));
await page.locator("[data-testid=toolbar] button", { hasText: "自适应宽度" }).hover();
await page.waitForTimeout(120);
console.log("hover（toggled）:", JSON.stringify(await read()));
await browser.close();
