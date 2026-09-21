// 审查探针 3：用「同一笔画的最右墨迹列」量化画布偏小造成的可写区域损失。

import { chromium, launchOptions, APP } from "../../support/browser.mjs";
const browser = await chromium.launch(launchOptions({ headless: true }));
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.goto(APP, { waitUntil: "domcontentloaded" });

async function strokeAndMeasure(label) {
  const box = await page.locator("[data-testid=signature-pad-canvas]").boundingBox();
  const y = box.y + 100;
  await page.mouse.move(box.x + 8, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, y, { steps: 30 });
  await page.mouse.up();
  await page.waitForTimeout(80);
  const data = await page.evaluate(() => {
    const canvas = document.querySelector("[data-testid=signature-pad-canvas]");
    const ctx = canvas.getContext("2d");
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let rightmost = -1;
    let bottomMost = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if (pixels[(y * canvas.width + x) * 4 + 3] > 0) {
          if (x > rightmost) rightmost = x;
          if (y > bottomMost) bottomMost = y;
        }
      }
    }
    return {
      rightmost,
      bottomMost,
      backing: canvas.width,
      height: canvas.height,
      cssWidth: canvas.clientWidth,
    };
  });
  console.log(
    `${label}: 后备 ${data.backing}×${data.height}（CSS 内宽 ${data.cssWidth}）最右墨迹列=${data.rightmost}，最下墨迹行=${data.bottomMost}`,
  );
  return data;
}

// 1) 正常打开：画布在入场动画中被测量
await page.locator("text=新建签名").first().click();
await page.waitForTimeout(500);
const fresh = await strokeAndMeasure("动画中测量（当前实现）");

// 清空后触发一次 resize 重新同步分辨率，再画同一笔画
await page.locator("[data-testid=signature-pad-canvas]").click({ position: { x: 5, y: 5 } });
await page.evaluate(() => {
  const canvas = document.querySelector("[data-testid=signature-pad-canvas]");
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
});
await page.setViewportSize({ width: 1440, height: 899 });
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(300);
const resized = await strokeAndMeasure("resize 后重新同步（修好后）");

console.log(
  `\n同一笔画可写宽度差：${resized.rightmost - fresh.rightmost} 设备像素（CSS 宽 ${fresh.cssWidth} 下约 ${(((resized.rightmost - fresh.rightmost) / fresh.cssWidth) * 100).toFixed(2)}% 的可写区域丢失）`,
);

await browser.close();
