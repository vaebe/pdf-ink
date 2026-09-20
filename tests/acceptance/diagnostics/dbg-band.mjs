import { chromium, launchOptions, APP, FIX } from "../harness.mjs";
const browser = await chromium.launch(launchOptions({ headless: true }));
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();
await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-testid=toolbar]");
await page
  .locator("[data-testid=toolbar] input[type=file]")
  .setInputFiles(`${FIX}/heavy-text-40p.pdf`);
await page.waitForFunction(() => document.querySelectorAll(".pdf-page").length === 40, null, {
  timeout: 60000,
});
await page.waitForTimeout(1200);

async function dump(label) {
  const state = await page.evaluate(() => {
    const scroller = document.querySelector("[data-testid=pdf-scroller]");
    const sr = scroller.getBoundingClientRect();
    const rows = [...document.querySelectorAll(".pdf-page")]
      .map((wrapper) => {
        const canvas = wrapper.querySelector("canvas");
        const rect = wrapper.getBoundingClientRect();
        const inBand = rect.bottom > sr.top - 900 && rect.top < sr.bottom + 900;
        return {
          index: Number(wrapper.dataset.pageIndex) + 1,
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          inBand,
          canvasWidth: canvas ? canvas.width : -1,
          spans: wrapper.querySelectorAll(".pdf-text-layer span").length,
          everRendered: Boolean(canvas?.style.width),
        };
      })
      .filter((row) => row.inBand || row.canvasWidth > 1);
    return {
      scroller: {
        top: Math.round(sr.top),
        bottom: Math.round(sr.bottom),
        scrollTop: Math.round(scroller.scrollTop),
      },
      rows,
    };
  });
  console.log(`\n--- ${label}  scroller=${JSON.stringify(state.scroller)}`);
  for (const row of state.rows) {
    console.log(
      `  第 ${row.index} 页 top=${row.top} bottom=${row.bottom} 带内=${row.inBand} canvas宽=${row.canvasWidth} 文本节点=${row.spans} 渲染过=${row.everRendered}`,
    );
  }
}

await dump("打开后（第 1 页）");
const input = page.locator("[data-testid=page-input]");
await input.fill("13");
await input.press("Enter");
await page.waitForTimeout(1500);
await dump("跳到第 13 页 +1.5s");
await page.waitForTimeout(2500);
await dump("第 13 页再等 2.5s");
await browser.close();
