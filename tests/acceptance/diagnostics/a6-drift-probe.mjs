/**
 * A6-1 「135% 档漂移 36.5px」的归因探针。
 *
 * 主套件已经用自己打印的证据把范围收窄了：
 *   135% 档 · 实例数 1→1 · 拖动前放置模式武装 true · 实测位移 (70.0,-76.5) · 页面 Δ(0.0,-36.5)
 *   50%/400% · 拖动前武装 false                 · 实测位移 (70.0,-40.0) · 页面 Δ(0,0)
 * 结论：漂移来自**页面整体上移 36.5px**（X 与 scrollTop 都没变），不是变换算错。
 * 页面既然上移，滚动内容区里必然有某个元素在拖动过程中矮了 36.5px。
 *
 * 本探针逐字重放主套件 A6 的循环体，并在拖动前后对滚动内容区里**所有带 data-testid 的
 * 元素**做矩形快照、按键名求差——直接点名是哪个元素变了，而不是继续猜。
 *
 *   node tests/acceptance/diagnostics/a6-drift-probe.mjs
 */
import { chromium, launchOptions, APP, FIX } from "../harness.mjs";

const DELTA = { dx: 70, dy: -40 };
const ZOOMS = [
  { label: "适合宽度", steps: 0, zoomIn: false },
  { label: "缩小到 50%", steps: 5, zoomIn: false },
  { label: "放大到 250%", steps: 8, zoomIn: true },
];
const round = (value) => Number(value.toFixed(2));

async function openApp(page) {
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-testid=toolbar]");
}

async function openPdf(page, fileName, expectedPages) {
  await page.locator("[data-testid=toolbar] input[type=file]").setInputFiles(`${FIX}/${fileName}`);
  const discard = page.getByRole("button", { name: "放弃并打开" });
  await discard.click({ timeout: 900 }).catch(() => {});
  await page.waitForFunction(
    ({ name, pages }) => {
      const shown = document.querySelector("[data-testid=file-name]")?.textContent ?? "";
      const canvases = document.querySelectorAll(".pdf-page canvas");
      return shown.includes(name) && canvases.length === pages && canvases[0].width > 0;
    },
    { name: fileName, pages: expectedPages },
    { timeout: 60000 },
  );
}

async function itemBoxes(page) {
  return await page.$$eval("[data-testid=placement]", (elements) =>
    elements.map((element, index) => {
      const rect = element.getBoundingClientRect();
      return {
        index,
        centerX: rect.x + rect.width / 2,
        centerY: rect.y + rect.height / 2,
        width: rect.width,
      };
    }),
  );
}

/** 滚动内容区里所有带 data-testid 元素的矩形，用于按键名比对找出「矮掉 36.5px」的那个。 */
async function taggedRects(page) {
  return await page.evaluate(() => {
    const scroller = document.querySelector("[data-testid=pdf-scroller]");
    const output = {};
    if (!scroller) return output;
    for (const element of scroller.querySelectorAll("[data-testid]")) {
      const testid = element.dataset.testid;
      // 同名的取第一个即可：这里要找的是结构容器，不是逐个页面实例。
      if (output[testid]) continue;
      const box = element.getBoundingClientRect();
      output[testid] = {
        x: Math.round(box.x * 10) / 10,
        y: Math.round(box.y * 10) / 10,
        h: Math.round(box.height * 10) / 10,
      };
    }
    return output;
  });
}

async function scrollerMetrics(page) {
  return await page.evaluate(() => {
    const scroller = document.querySelector("[data-testid=pdf-scroller]");
    if (!scroller) return null;
    const box = scroller.getBoundingClientRect();
    return {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      y: Math.round(box.y * 10) / 10,
      tag: scroller.firstElementChild
        ? `${scroller.firstElementChild.tagName}.${scroller.firstElementChild.className}`
        : "none",
    };
  });
}

const GLYPHS = {
  R: [
    [
      [0.15, 0.85],
      [0.15, 0.15],
    ],
    [
      [0.15, 0.15],
      [0.5, 0.15],
      [0.66, 0.28],
      [0.52, 0.4],
      [0.15, 0.4],
    ],
    [
      [0.38, 0.4],
      [0.7, 0.85],
    ],
  ],
  T: [
    [
      [0.25, 0.3],
      [0.75, 0.3],
    ],
    [
      [0.5, 0.3],
      [0.5, 0.85],
    ],
  ],
};

async function drawGlyph(page, glyph) {
  const box = await page.locator("[data-testid=signature-pad-canvas]").boundingBox();
  for (const stroke of GLYPHS[glyph]) {
    const [first, ...rest] = stroke;
    await page.mouse.move(box.x + box.width * first[0], box.y + box.height * first[1]);
    await page.mouse.down();
    for (const point of rest) {
      await page.mouse.move(box.x + box.width * point[0], box.y + box.height * point[1], {
        steps: 8,
      });
    }
    await page.mouse.up();
  }
}

async function createSignature(page, glyph) {
  await page
    .locator("[data-testid=signature-library]")
    .getByRole("button", { name: "新建签名" })
    .first()
    .click();
  await page.waitForSelector("[data-testid=signature-pad-canvas]");
  await page.waitForTimeout(250);
  await drawGlyph(page, glyph);
  await page
    .locator("[data-testid=signature-pad-dialog]")
    .getByRole("button", { name: /保存到签名库|保存中/ })
    .click();
}

async function armed(page) {
  return await page
    .locator("[data-testid=library-item]")
    .nth(0)
    .evaluate((element) => element.dataset.active);
}

async function pickTemplate(page, index) {
  if ((await armed(page)) !== "true") {
    await page.locator("[data-testid=library-item-pick]").nth(index).click();
  }
  await page.waitForTimeout(150);
}

async function placeOnPage(page, pageIndex, fx, fy) {
  await pickTemplate(page, 0);
  const box = await page.locator(`.pdf-page[data-page-index="${pageIndex}"]`).boundingBox();
  const viewport = page.viewportSize();
  const top = Math.max(box.y, 90);
  const bottom = Math.min(box.y + box.height, viewport.height - 10);
  const left = Math.max(box.x, 10);
  const right = Math.min(box.x + box.width, viewport.width - 10);
  const point = { x: left + (right - left) * fx, y: top + (bottom - top) * fy };
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(200);
  return point;
}

async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(200);
}

const browser = await chromium.launch(launchOptions({ headless: true }));

try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 820 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await openApp(page);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.deleteDatabase("pdf-ink");
        request.onsuccess = resolve;
        request.onerror = resolve;
        request.onblocked = resolve;
      }),
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-testid=toolbar]");
  await openPdf(page, "plain.pdf", 2);
  await createSignature(page, "R");
  await page.waitForFunction(
    () => document.querySelectorAll("[data-testid=library-item]").length === 1,
  );
  await createSignature(page, "T");
  await page.waitForFunction(
    () => document.querySelectorAll("[data-testid=library-item]").length === 2,
  );

  await pickTemplate(page, 0);
  await placeOnPage(page, 0, 0.5, 0.5);

  for (const scenario of ZOOMS) {
    const fitButton = page.locator("button", { hasText: "适合宽度" });
    const fitToggled = await fitButton.evaluate((element) =>
      element.classList.contains("button--toggled"),
    );
    if (!fitToggled) {
      await fitButton.click();
      await page.waitForTimeout(500);
    }
    for (let step = 0; step < scenario.steps; step += 1) {
      await page.locator(scenario.zoomIn ? 'button[title="放大"]' : 'button[title="缩小"]').click();
    }
    await page.waitForTimeout(700);

    const placed = await placeOnPage(page, 0, 0.5, 0.5);
    await page.waitForTimeout(300);

    const scaleText = (await page.locator("[data-testid=zoom-level]").innerText()).trim();
    const items = await itemBoxes(page);
    const target = items.at(-1);
    const armedBefore = await armed(page);
    const rectsBefore = await taggedRects(page);
    const metricsBefore = await scrollerMetrics(page);
    const pageBoxBefore = await page.locator('.pdf-page[data-page-index="0"]').boundingBox();

    await drag(
      page,
      { x: target.centerX, y: target.centerY },
      { x: target.centerX + DELTA.dx, y: target.centerY + DELTA.dy },
    );

    const itemsAfter = await itemBoxes(page);
    const after = itemsAfter.at(-1);
    const armedAfter = await armed(page);
    const rectsAfter = await taggedRects(page);
    const metricsAfter = await scrollerMetrics(page);
    const pageBoxAfter = await page.locator('.pdf-page[data-page-index="0"]').boundingBox();

    const movedX = after.centerX - target.centerX;
    const movedY = after.centerY - target.centerY;

    console.log(`\n===== ${scenario.label} / zoom=${scaleText} =====`);
    console.log(
      `  clickPoint=(${round(placed.x)},${round(placed.y)}) 实例数 ${items.length}→${itemsAfter.length} 武装 ${armedBefore}→${armedAfter}`,
    );
    console.log(
      `  位移 (${round(movedX)},${round(movedY)}) 期望 (${DELTA.dx},${DELTA.dy}) → 漂移 ${Math.hypot(movedX - DELTA.dx, movedY - DELTA.dy).toFixed(2)}px`,
    );
    console.log(
      `  页面 y ${round(pageBoxBefore.y)} → ${round(pageBoxAfter.y)}（Δ ${round(pageBoxAfter.y - pageBoxBefore.y)}）`,
    );
    console.log(`  滚动容器 前 ${JSON.stringify(metricsBefore)}`);
    console.log(`            后 ${JSON.stringify(metricsAfter)}`);

    const changed = [];
    for (const testid of new Set([...Object.keys(rectsBefore), ...Object.keys(rectsAfter)])) {
      const before = rectsBefore[testid];
      const afterRect = rectsAfter[testid];
      if (!before || !afterRect) {
        changed.push({ testid, 前: before ?? "不存在", 后: afterRect ?? "不存在" });
        continue;
      }
      if (Math.abs(before.y - afterRect.y) > 0.05 || Math.abs(before.h - afterRect.h) > 0.05) {
        changed.push({
          testid,
          前: `y=${before.y} h=${before.h}`,
          后: `y=${afterRect.y} h=${afterRect.h}`,
          Δy: round(afterRect.y - before.y),
          Δh: round(afterRect.h - before.h),
        });
      }
    }
    console.log(
      `  拖动前后几何发生变化的钩子 ${changed.length} 个：${changed.length ? JSON.stringify(changed) : "无"}`,
    );
  }
} finally {
  await browser.close();
}
