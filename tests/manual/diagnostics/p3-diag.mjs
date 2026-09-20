/**
 * P2-4 诊断：切换文档前后，到底谁先动手？
 *
 * 关心三件事：
 *   1) 旧画布有没有被「新文档的渲染」改过尺寸（MutationObserver 监听 width/height 属性，
 *      canvas.width = n 会反映到属性上）——这是根因的直接物证。
 *   2) IntersectionObserver 对新节点的首帧回调出现在什么时刻、当时判定是否可见。
 *   3) 新画布最终有没有内容。
 *
 * 用法：node p3-diag.mjs [from] [to] [pagesFrom] [pagesTo]
 *   默认 heavy-text-40p.pdf → book-100p.pdf
 */

import { chromium, launchOptions, APP, FIX } from "../../support/browser.mjs";
const FROM = process.argv[2] ?? "heavy-text-40p.pdf";
const TO = process.argv[3] ?? "book-100p.pdf";
const FROM_PAGES = Number(process.argv[4] ?? 40);
const TO_PAGES = Number(process.argv[5] ?? 100);

const browser = await chromium.launch(launchOptions({ headless: true }));
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

await context.addInitScript(() => {
  window.__ioEvents = [];
  const OriginalObserver = window.IntersectionObserver;
  window.IntersectionObserver = class extends OriginalObserver {
    constructor(callback, options) {
      super((entries, observer) => {
        const thumbs = entries.filter((entry) =>
          entry.target?.matches?.("[data-testid=thumb-item]"),
        );
        if (thumbs.length > 0) {
          window.__ioEvents.push({
            t: performance.now(),
            total: entries.length,
            thumbs: thumbs.length,
            visible: thumbs.filter((entry) => entry.isIntersecting).length,
            firstIndex: Number(thumbs[0].target.dataset.thumbIndex),
          });
        }
        callback(entries, observer);
      }, options);
    }
  };
  window.__canvasMutations = [];
});

const page = await context.newPage();
await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-testid=toolbar]");

async function open(name, expectedPages) {
  await page.locator("[data-testid=toolbar] input[type=file]").setInputFiles(`${FIX}/${name}`);
  await page.waitForTimeout(600);
  await page.waitForFunction(
    ({ fileName, pages }) => {
      const shown = document.querySelector("[data-testid=file-name]")?.textContent ?? "";
      const wrappers = document.querySelectorAll(".pdf-page").length;
      return shown.includes(fileName) && wrappers === pages;
    },
    { fileName: name, pages: expectedPages },
    { timeout: 60000 },
  );
}

await open(FROM, FROM_PAGES);
await page.waitForTimeout(1200);

// 记录切换前的旧画布，并监听它们的尺寸属性变化。
const before = await page.evaluate(() => {
  window.__ioEvents.length = 0;
  window.__canvasMutations.length = 0;
  const asides = [...document.querySelectorAll("aside")];
  const aside = asides.find((element) => element.querySelector("[data-testid=thumb-item]"));
  const items = [...aside.querySelectorAll("[data-testid=thumb-item]")];
  const canvases = items.map((item) => item.querySelector("canvas"));
  window.__oldCanvases = canvases;
  window.__switchAt = performance.now();
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const canvas = record.target;
      const index = window.__oldCanvases.indexOf(canvas);
      window.__canvasMutations.push({
        t: performance.now(),
        index,
        attr: record.attributeName,
        width: canvas.width,
        height: canvas.height,
        detached: !canvas.isConnected,
      });
    }
  });
  for (const canvas of canvases) {
    observer.observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });
  }
  return {
    switchAt: window.__switchAt,
    oldCanvasCount: canvases.length,
    drawnBefore: canvases.filter((canvas) => canvas.width > 1).length,
    sampleWidth: canvases[0].width,
    sampleHeight: canvases[0].height,
  };
});

await open(TO, TO_PAGES);
await page.waitForTimeout(1600);

const after = await page.evaluate(() => {
  const asides = [...document.querySelectorAll("aside")];
  const aside = asides.find((element) => element.querySelector("[data-testid=thumb-item]"));
  const asideRect = aside.getBoundingClientRect();
  const items = [...aside.querySelectorAll("[data-testid=thumb-item]")];
  const inView = items.filter((item) => {
    const rect = item.getBoundingClientRect();
    return rect.bottom > asideRect.top + 1 && rect.top < asideRect.bottom - 1;
  });
  const readAlpha = (canvas) => {
    if (canvas.width <= 1 || canvas.height <= 1) return 0;
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = 0;
    let total = 0;
    for (let y = 0; y < canvas.height; y += 2) {
      for (let x = 0; x < canvas.width; x += 2) {
        total += 1;
        if (data[(y * canvas.width + x) * 4 + 3] > 0) opaque += 1;
      }
    }
    return total ? opaque / total : 0;
  };
  return {
    now: performance.now(),
    switchAt: window.__switchAt,
    newThumbItems: items.length,
    inViewIndices: inView.map((item) => Number(item.dataset.thumbIndex)),
    inViewBlank: inView
      .filter((item) => readAlpha(item.querySelector("canvas")) <= 0.5)
      .map((item) => Number(item.dataset.thumbIndex)),
    newCanvasSize: (() => {
      const canvas = items[0]?.querySelector("canvas");
      return canvas ? `${canvas.width}x${canvas.height}` : "none";
    })(),
    canvasMutations: window.__canvasMutations,
    ioEvents: window.__ioEvents,
    oldCanvasSizesNow: window.__oldCanvases.map((canvas) => `${canvas.width}x${canvas.height}`),
  };
});

console.log("=== 切换前 ===");
console.log(before);
console.log("=== 切换后 ===");
console.log(
  `换文档耗时基准 switchAt=${after.switchAt.toFixed(0)}ms，now=${after.now.toFixed(0)}ms`,
);
console.log(`新缩略图项 ${after.newThumbItems} 个；可见 ${JSON.stringify(after.inViewIndices)}`);
console.log(`可见但空白：${JSON.stringify(after.inViewBlank)}`);
console.log(
  `新画布尺寸样例：${after.newCanvasSize}（切换前旧画布 ${before.sampleWidth}x${before.sampleHeight}）`,
);
console.log(`\n旧画布尺寸属性变更 ${after.canvasMutations.length} 次：`);
for (const record of after.canvasMutations.slice(0, 12)) {
  console.log(
    `  +${(record.t - after.switchAt).toFixed(1)}ms 旧画布#${record.index} ${record.attr}=${record.width ?? ""}${record.attr === "height" ? record.height : ""} detached=${record.detached}`,
  );
}
console.log(`\nIntersectionObserver 缩略图相关回调 ${after.ioEvents.length} 次：`);
for (const event of after.ioEvents.slice(0, 12)) {
  console.log(
    `  +${(event.t - after.switchAt).toFixed(1)}ms 条目 ${event.total}（缩略图 ${event.thumbs}）可见 ${event.visible} 起始页码 ${event.firstIndex}`,
  );
}
console.log(`\n旧画布现在的尺寸：${JSON.stringify(after.oldCanvasSizesNow.slice(0, 10))}`);

await browser.close();
