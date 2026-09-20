// 审查探针 4：让笔画真正落到最右侧（末尾在同一点多停几次，绕开 16ms 节流），
// 对比「动画中测量」与「resize 后重新同步」两种状态的可写边界。

import { chromium, launchOptions, APP } from "../../support/browser.mjs";
const browser = await chromium.launch(launchOptions({ headless: true }));
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.goto(APP, { waitUntil: "domcontentloaded" });

async function edgeStroke(label) {
  const box = await page.locator("[data-testid=signature-pad-canvas]").boundingBox();
  const y = box.y + 100;
  const edgeX = box.x + box.width - 2;
  await page.mouse.move(box.x + 8, y);
  await page.mouse.down();
  await page.mouse.move(edgeX, y, { steps: 30 });
  // 在同一点多停几次，确保节流窗口内最后一次移动被真正渲染
  for (let i = 0; i < 4; i += 1) {
    await page.mouse.move(edgeX + (i % 2), y);
    await page.waitForTimeout(60);
  }
  await page.mouse.up();
  await page.waitForTimeout(120);
  const data = await page.evaluate(() => {
    const canvas = document.querySelector("[data-testid=signature-pad-canvas]");
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let rightmost = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = canvas.width - 1; x > rightmost; x -= 1) {
        if (pixels[(y * canvas.width + x) * 4 + 3] > 0) {
          rightmost = x;
          break;
        }
      }
    }
    return {
      rightmost,
      backing: canvas.width,
      cssWidth: canvas.clientWidth,
      rect: canvas.getBoundingClientRect().width,
    };
  });
  console.log(
    `${label}: 后备宽=${data.backing}，元素边框盒宽=${data.rect}，内容宽=${data.cssWidth} → 最右墨迹列=${data.rightmost}`,
  );
  return data;
}

await page.locator("text=新建签名").first().click();
await page.waitForTimeout(500);
const fresh = await edgeStroke("动画中测量（当前实现）");

await page.evaluate(() => {
  const canvas = document.querySelector("[data-testid=signature-pad-canvas]");
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
});
await page.setViewportSize({ width: 1440, height: 899 });
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(300);
const resized = await edgeStroke("resize 后重新同步（修好后）");

console.log(
  `\n结论：当前实现下笔画被截断于第 ${fresh.rightmost} 列，正确尺寸下可达第 ${resized.rightmost} 列；` +
    `右侧约 ${resized.rightmost - fresh.rightmost} 个设备像素（≈${(((resized.rightmost - fresh.rightmost) / fresh.cssWidth) * 100).toFixed(2)}% 宽度）写不进去。`,
);

await browser.close();
