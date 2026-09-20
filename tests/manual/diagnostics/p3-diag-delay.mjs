/**
 * P2-4 诊断（推迟观察器回调）：让 stale 渲染抢在观察器首帧回调之前完成。
 *
 * 为什么需要扰动：前台切换时，观察器的首帧回调总在同一染步里紧随 DOM 补丁到来
 * （实测只比 stale 渲染晚 2—5ms），它会取消尚未完成的 stale 任务，把症状兜住。
 * 只有在「回调被推迟到 stale 渲染完成之后」的条件下——后台标签页、长卡帧、
 * 重型主视图抢占主线程——stale 渲染才会先写下缓存，新画布从此永久跳过渲染。
 *
 * 扰动方式：把 IntersectionObserver 的回调投递整体延后 N 毫秒，等价于把染步推后。
 * 这是测试侧的时序扰动，不改动应用逻辑，只为把「已经存在的缓存污染」暴露出来。
 *
 * 用法：node p3-diag-delay.mjs [delayMs] [from] [to] [fromPages] [toPages]
 */

import { chromium, launchOptions, APP, FIX } from "../../support/browser.mjs";
const DELAY_MS = Number(process.argv[2] ?? 400);
const FROM = process.argv[3] ?? "heavy-text-40p.pdf";
const TO = process.argv[4] ?? "dot-40p.pdf";
const FROM_PAGES = Number(process.argv[5] ?? 40);
const TO_PAGES = Number(process.argv[6] ?? 40);

const browser = await chromium.launch(launchOptions({ headless: true }));
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

await context.addInitScript(() => {
  window.__ioDelay = 0;
  window.__ioDeliveries = [];
  const Original = window.IntersectionObserver;
  window.IntersectionObserver = class extends Original {
    constructor(callback, options) {
      super((entries, observer) => {
        const thumbs = entries.filter((entry) =>
          entry.target?.matches?.("[data-testid=thumb-item]"),
        );
        if (thumbs.length > 0) {
          window.__ioDeliveries.push({
            t: performance.now(),
            thumbs: thumbs.length,
            visible: thumbs.filter((entry) => entry.isIntersecting).length,
            delay: window.__ioDelay,
          });
        }
        const delay = window.__ioDelay;
        if (delay > 0) {
          window.setTimeout(() => callback(entries, observer), delay);
        } else {
          callback(entries, observer);
        }
      }, options);
    }
  };
});

const page = await context.newPage();
await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-testid=toolbar]");

async function open(name, pages) {
  await page.locator("[data-testid=toolbar] input[type=file]").setInputFiles(`${FIX}/${name}`);
  await page.waitForFunction(
    (count) => document.querySelectorAll(".pdf-page").length === count,
    pages,
    { polling: 150, timeout: 60000 },
  );
  await page.waitForTimeout(1200);
}

await open(FROM, FROM_PAGES);
await page.evaluate((delay) => {
  window.__ioDelay = delay;
  window.__ioDeliveries.length = 0;
  window.__switchAt = performance.now();
  const aside = [...document.querySelectorAll("aside")].find((element) =>
    element.querySelector("[data-testid=thumb-item]"),
  );
  window.__oldCanvases = [...aside.querySelectorAll("[data-testid=thumb-item]")].map((item) =>
    item.querySelector("canvas"),
  );
  window.__canvasMutations = [];
  const watcher = new MutationObserver((records) => {
    for (const record of records) {
      window.__canvasMutations.push({
        t: performance.now(),
        index: window.__oldCanvases.indexOf(record.target),
        attr: record.attributeName,
        detached: !record.target.isConnected,
      });
    }
  });
  for (const canvas of window.__oldCanvases) {
    watcher.observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });
  }
}, DELAY_MS);

const before = await page.evaluate(() => ({
  count: window.__oldCanvases.length,
  painted: window.__oldCanvases.filter((canvas) => canvas.width > 1).length,
}));

await open(TO, TO_PAGES);
// 等到扰动后的回调真正投递并完成渲染。
await page.waitForTimeout(DELAY_MS + 1200);

const state = await page.evaluate(() => {
  const aside = [...document.querySelectorAll("aside")].find((element) =>
    element.querySelector("[data-testid=thumb-item]"),
  );
  const asideRect = aside.getBoundingClientRect();
  const items = [...aside.querySelectorAll("[data-testid=thumb-item]")];
  const inView = items.filter((item) => {
    const rect = item.getBoundingClientRect();
    return rect.bottom > asideRect.top + 1 && rect.top < asideRect.bottom - 1;
  });
  const alpha = (canvas) => {
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
    switchAt: window.__switchAt,
    deliveries: window.__ioDeliveries,
    mutationCount: window.__canvasMutations.length,
    detachedWrites: window.__canvasMutations.filter((record) => record.detached).length,
    firstWrite: window.__canvasMutations[0]
      ? window.__canvasMutations[0].t - window.__switchAt
      : null,
    inView: inView.map((item) => Number(item.dataset.thumbIndex)),
    blankInView: inView
      .filter((item) => alpha(item.querySelector("canvas")) <= 0.5)
      .map((item) => Number(item.dataset.thumbIndex)),
    sizes: inView.map((item) => {
      const canvas = item.querySelector("canvas");
      return `${canvas.width}x${canvas.height}`;
    }),
  };
});

console.log(
  `切换前旧画布 ${before.count} 个，其中已设尺寸 ${before.painted} 个；回调投递延后 ${DELAY_MS}ms`,
);
console.log(
  `旧画布被改写 ${state.mutationCount} 次（detached=${state.detachedWrites}），首次在 +${state.firstWrite?.toFixed(1)}ms`,
);
for (const delivery of state.deliveries.slice(0, 6)) {
  console.log(
    `  观察器缩略图回调：+${(delivery.t - state.switchAt).toFixed(1)}ms 条目 ${delivery.thumbs} 可见 ${delivery.visible}（投递延后 ${delivery.delay}ms）`,
  );
}
console.log(`可见缩略图 ${JSON.stringify(state.inView)}（尺寸 ${JSON.stringify(state.sizes)}）`);
console.log(`其中空白：${JSON.stringify(state.blankInView)}`);

await page.screenshot({ path: `${FIX}/out/P2-4-delayed-frame.png` });
await browser.close();
