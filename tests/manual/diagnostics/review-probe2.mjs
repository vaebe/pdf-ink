// 审查探针 2：验证两处疑似缺陷的根因与修法（只在页面里注入临时样式/触发 resize，不改项目文件）。

import { chromium, launchOptions, APP, FIX } from "../../support/browser.mjs";
const browser = await chromium.launch(launchOptions({ headless: true }));
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.goto(APP, { waitUntil: "domcontentloaded" });

// ---------- A. 画布尺寸：动画中测量 vs 触发一次 resize 后重测 ----------
await page.locator("text=新建签名").first().click();
await page.waitForTimeout(500); // 等入场动画结束
const before = await page.evaluate(() => {
  const canvas = document.querySelector("[data-testid=signature-pad-canvas]");
  return { backing: canvas.width, offsetWidth: canvas.offsetWidth, dpr: devicePixelRatio };
});
// 触发 window resize -> resizeKeepingInk() -> syncCanvasResolution()
await page.setViewportSize({ width: 1440, height: 899 });
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(250);
const after = await page.evaluate(() => {
  const canvas = document.querySelector("[data-testid=signature-pad-canvas]");
  return { backing: canvas.width, offsetWidth: canvas.offsetWidth, dpr: devicePixelRatio };
});
console.log("A. 画布尺寸");
console.log("   打开时（动画中测得）:", JSON.stringify(before));
console.log("   触发 resize 后重测  :", JSON.stringify(after));
console.log(
  `   -> 差值 ${after.backing - before.backing} 设备像素；恢复率 = ${(after.backing / (after.offsetWidth * after.dpr)).toFixed(4)}`,
);
// 再画到最右侧，确认修好后右侧能出墨
const box = await page.locator("[data-testid=signature-pad-canvas]").boundingBox();
await page.mouse.move(box.x + 10, box.y + 100);
await page.mouse.down();
await page.mouse.move(box.x + box.width - 4, box.y + 100, { steps: 24 });
await page.mouse.up();
const edgeAfter = await page.evaluate(() => {
  const canvas = document.querySelector("[data-testid=signature-pad-canvas]");
  const data = canvas.getContext("2d").getImageData(canvas.width - 3, 0, 3, canvas.height).data;
  let ink = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) ink += 1;
  return { ink, backing: canvas.width };
});
console.log(`   重测后最右 3 列墨迹像素 = ${edgeAfter.ink}（backing=${edgeAfter.backing}）`);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// ---------- B. 链接命中顺序：注入 z-index: 0 前后对比 ----------
await page.locator("[data-testid=toolbar] input[type=file]").setInputFiles(`${FIX}/text-links.pdf`);
await page.waitForSelector("[data-testid=pdf-scroller] canvas", { timeout: 20000 });
await page.waitForTimeout(1200);

async function hitTest(label) {
  const probe = await page.evaluate(() => {
    const linkSpan = document.querySelector("[data-testid=pdf-scroller] a")?.parentElement;
    const rect = linkSpan.getBoundingClientRect();
    const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return {
      topmostTag: top?.tagName?.toLowerCase(),
      isAnchorOrChild: Boolean(top?.closest("a")),
      textLayerZ: getComputedStyle(document.querySelector(".pdf-text-layer")).zIndex,
    };
  });
  console.log(`   ${label}: ${JSON.stringify(probe)}`);
  return probe;
}

console.log("B. 链接命中顺序");
const baseline = await hitTest("修复前");
await page.addStyleTag({ content: ".pdf-text-layer { z-index: 0 !important; }" });
const patched = await hitTest("注入 z-index: 0 后");

let popup = false;
context.on("page", () => {
  popup = true;
});
const rect = await page.evaluate(() => {
  const linkSpan = document.querySelector("[data-testid=pdf-scroller] a")?.parentElement;
  const box = linkSpan.getBoundingClientRect();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
});
await page.mouse.click(rect.x, rect.y);
await page.waitForTimeout(800);
console.log(`   注入修复后真点击 -> 触发跳转/新标签页: ${popup}`);

await browser.close();
console.log(
  `\n结论：文字层 z-index ${baseline.textLayerZ} -> ${patched.textLayerZ}；` +
    `命中元素 ${baseline.topmostTag} -> ${patched.topmostTag}；可点 ${baseline.isAnchorOrChild} -> ${patched.isAnchorOrChild}`,
);
