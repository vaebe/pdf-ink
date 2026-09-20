// 审查探针 5：确认「入场动画」是画布尺寸偏差的根因 —— 开启 prefers-reduced-motion 后偏差应消失。

import { chromium, launchOptions, APP } from "../harness.mjs";
const browser = await chromium.launch(launchOptions({ headless: true }));

for (const motion of ["no-preference", "reduce"]) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: motion,
  });
  const page = await context.newPage();
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.locator("text=新建签名").first().click();
  await page.waitForTimeout(500);
  const data = await page.evaluate(() => {
    const canvas = document.querySelector("[data-testid=signature-pad-canvas]");
    const panel = canvas.parentElement.parentElement;
    return {
      backing: canvas.width,
      expect: Math.round(canvas.offsetWidth * devicePixelRatio),
      animation: getComputedStyle(
        document.querySelector("[data-testid=signature-pad-dialog]").children[0],
      ).animationName,
      panelAnimation: getComputedStyle(panel).animationName,
    };
  });
  console.log(
    `reduced-motion=${motion}: backing=${data.backing}, 应为 ${data.expect}, 面板动画=${data.panelAnimation}`,
  );
  await context.close();
}
await browser.close();
