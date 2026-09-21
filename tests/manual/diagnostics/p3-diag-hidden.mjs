/**
 * P2-4 诊断（后台标签页切换）：把「观察器首帧回调」推迟到 stale 渲染之后。
 *
 * 前台切换时，观察器的首帧回调总在同一个染步里到来（实测只比 stale 渲染晚 2—5ms），
 * 于是旧的 stale 任务被它取消，症状被兜住。若切换发生在标签页不可见时，
 * 渲染步被挂起、回调要等回到前台才投递，stale 渲染就会先跑完并占住缓存——
 * 新画布从此永久跳过渲染。这正是审查描述的「部分缩略图持续空白」。
 *
 * 用法：node p3-diag-hidden.mjs
 */
import { readFile } from "node:fs/promises";
import { chromium, launchOptions, APP, FIX } from "../../support/browser.mjs";

const browser = await chromium.launch(launchOptions({ headless: true }));
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

const page = await context.newPage();
await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-testid=toolbar]");

await page
  .locator("[data-testid=toolbar] input[type=file]")
  .setInputFiles(`${FIX}/heavy-text-40p.pdf`);
await page.waitForFunction(() => document.querySelectorAll(".pdf-page").length === 40, null, {
  polling: 200,
  timeout: 60000,
});
await page.waitForTimeout(1500);
console.log(`可见性=${await page.evaluate(() => document.visibilityState)}`);

await page.evaluate(() => {
  window.__canvasMutations = [];
  const aside = [...document.querySelectorAll("aside")].find((element) =>
    element.querySelector("[data-testid=thumb-item]"),
  );
  const canvases = [...aside.querySelectorAll("[data-testid=thumb-item]")].map((item) =>
    item.querySelector("canvas"),
  );
  window.__oldCanvases = canvases;
  window.__switchAt = performance.now();
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      window.__canvasMutations.push({
        t: performance.now(),
        index: window.__oldCanvases.indexOf(record.target),
        attr: record.attributeName,
        detached: !record.target.isConnected,
      });
    }
  });
  for (const canvas of canvases) {
    observer.observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });
  }
});
const before = await page.evaluate(() => ({
  oldCanvases: window.__oldCanvases.length,
  painted: window.__oldCanvases.filter((canvas) => canvas.width > 1).length,
}));
console.log(`切换前：旧画布 ${before.oldCanvases} 个，已设尺寸 ${before.painted} 个`);

// 打开第二个标签页 → 第一个标签页转为不可见（渲染步被挂起）。
const other = await context.newPage();
await other.goto("about:blank");
await other.bringToFront();
await page.waitForTimeout(400);
const hiddenState = await page.evaluate(() => document.visibilityState);
console.log(`切换瞬间的可见性=${hiddenState}`);

const base64 = (await readFile(`${FIX}/dot-40p.pdf`)).toString("base64");
await page.evaluate(async (payload) => {
  const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
  const file = new File([bytes], "dot-40p.pdf", { type: "application/pdf" });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  const input = document.querySelector("[data-testid=toolbar] input[type=file]");
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}, base64);

const switched = await page
  .waitForFunction(
    () => {
      const shown = document.querySelector("[data-testid=file-name]")?.textContent ?? "";
      return shown.includes("dot-40p.pdf") && document.querySelectorAll(".pdf-page").length === 40;
    },
    null,
    { polling: 200, timeout: 30000 },
  )
  .then(() => true)
  .catch(() => false);
await page.waitForTimeout(2000);

const whileHidden = await page.evaluate(() => ({
  switchElapsed: performance.now() - window.__switchAt,
  mutations: window.__canvasMutations.length,
  detachedWrites: window.__canvasMutations.filter((record) => record.detached).length,
  firstWriteAt: window.__canvasMutations[0]
    ? window.__canvasMutations[0].t - window.__switchAt
    : null,
}));
console.log(`\n切换完成=${switched}；DOM 切换后等待 2s（仍不可见）`);
console.log(
  `旧画布被改写：${whileHidden.mutations} 次属性变更，其中 detached=${whileHidden.detachedWrites}，首次在 +${whileHidden.firstWriteAt?.toFixed(1)}ms`,
);

// 回到前台：渲染步恢复，观察器补投首帧回调。
await page.bringToFront();
await page.waitForTimeout(1500);
const after = await page.evaluate(() => {
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
    visibility: document.visibilityState,
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
console.log(`\n回到前台后：可见性=${after.visibility}`);
console.log(`可见缩略图 ${JSON.stringify(after.inView)}（尺寸 ${JSON.stringify(after.sizes)}）`);
console.log(`其中空白（alpha≈0）的：${JSON.stringify(after.blankInView)}`);

await page.screenshot({ path: `${FIX}/out/P2-4-hidden-switch.png` });
await browser.close();
