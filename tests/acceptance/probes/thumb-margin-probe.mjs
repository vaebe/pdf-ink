import { chromium, launchOptions, APP, FIX } from "../harness.mjs";
const BASE = APP;

const browser = await chromium.launch(launchOptions({}));
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
await page.goto(BASE, { waitUntil: "domcontentloaded" });

// 打开 40 页文档
await page
  .locator("[data-testid=toolbar] input[type=file]")
  .setInputFiles(`${FIX}/heavy-text-40p.pdf`);
await page.waitForSelector("[data-testid=thumb-item]", { timeout: 20000 });
await page.waitForTimeout(1600);

const read = () =>
  page.evaluate(() => {
    const items = [...document.querySelectorAll("[data-testid=thumb-item]")];
    const aside = items[0].closest("aside");
    const asideRect = aside.getBoundingClientRect();
    const list = items.map((item) => {
      const canvas = item.querySelector("canvas");
      const rect = item.getBoundingClientRect();
      return {
        index: Number(item.dataset.thumbIndex ?? "-1"),
        drawn: Boolean(canvas.style.width) && !(canvas.width === 300 && canvas.height === 150),
        inAside: rect.bottom > asideRect.top && rect.top < asideRect.bottom,
        belowAside: rect.top >= asideRect.bottom,
        top: Math.round(rect.top - asideRect.top),
      };
    });
    return {
      scrollTop: aside.scrollTop,
      asideHeight: Math.round(asideRect.height),
      drawnTotal: list.filter((entry) => entry.drawn).length,
      inAside: list.filter((entry) => entry.inAside).length,
      drawnInAside: list.filter((entry) => entry.inAside && entry.drawn).length,
      // 底部可视边界之外、落在 240px 余量内的项
      within240: list
        .filter((entry) => entry.belowAside && entry.top < asideRect.height + 240)
        .map((e) => e.index),
      drawnWithin240: list
        .filter((entry) => entry.belowAside && entry.top < asideRect.height + 240 && entry.drawn)
        .map((e) => e.index),
    };
  });

const initial = await read();
console.log("初次加载（aside 未滚动）：");
console.log(
  `  aside 高 ${initial.asideHeight}px，scrollTop=${initial.scrollTop}；面板内 ${initial.inAside} 项全部已绘制=${initial.drawnInAside}`,
);
console.log(
  `  全量已绘制 ${initial.drawnTotal}/${initial.inAside + initial.within240.length + 0} 相关项`,
);
console.log(`  底部 240px 余量内的项：${JSON.stringify(initial.within240)}`);
console.log(`  其中已绘制的：${JSON.stringify(initial.drawnWithin240)}`);
console.log(
  initial.drawnWithin240.length > 0
    ? "→ rootMargin 生效：底部余量内的缩略图已提前渲染"
    : "→ rootMargin 未生效（被 aside 滚动容器裁剪）：余量内的缩略图一个都没渲染",
);

await context.close();
await browser.close();
