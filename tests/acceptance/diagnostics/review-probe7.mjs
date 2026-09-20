// 审查探针 7：区分「hover 规则未生效」与「特异性/顺序」——对比 toggled 与普通 ghost 按钮的 hover 表现。

import { chromium, launchOptions, APP } from "../harness.mjs";
const browser = await chromium.launch(launchOptions({ headless: true }));
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.goto(APP, { waitUntil: "domcontentloaded" });

console.log(
  "hover 媒体查询匹配:",
  JSON.stringify(
    await page.evaluate(() => ({
      hover: matchMedia("(hover: hover)").matches,
      pointer: matchMedia("(pointer: fine)").matches,
    })),
  ),
);

const styleOf = (text) =>
  page.evaluate((label) => {
    const button = [...document.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === label,
    );
    const s = getComputedStyle(button);
    return { classes: button.className, border: s.borderColor, bg: s.backgroundColor };
  }, text);

// A. 普通 ghost 按钮（空状态侧栏底部的「新建签名」）
console.log("A 普通 ghost 静止:", JSON.stringify(await styleOf("新建签名")));
await page.locator("button", { hasText: "新建签名" }).last().hover();
await page.waitForTimeout(150);
console.log("A 普通 ghost hover:", JSON.stringify(await styleOf("新建签名")));
await page.mouse.move(700, 800);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// B. toggled 按钮「自适应宽度」
console.log("B toggled 静止:", JSON.stringify(await styleOf("自适应宽度")));
await page.locator("[data-testid=toolbar] button", { hasText: "自适应宽度" }).hover();
await page.waitForTimeout(150);
console.log("B toggled hover:", JSON.stringify(await styleOf("自适应宽度")));

// C. 关掉 toggled 后再 hover（此时只有 ghost 类）
await page.locator("[data-testid=toolbar] button", { hasText: "自适应宽度" }).click();
await page.mouse.move(700, 800);
await page.waitForTimeout(200);
console.log("C 关闭后静止:", JSON.stringify(await styleOf("自适应宽度")));
await page.locator("[data-testid=toolbar] button", { hasText: "自适应宽度" }).hover();
await page.waitForTimeout(150);
console.log("C 关闭后 hover:", JSON.stringify(await styleOf("自适应宽度")));
await browser.close();
