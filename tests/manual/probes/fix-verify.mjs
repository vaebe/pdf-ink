import { chromium, launchOptions, APP, FIX } from "../../support/browser.mjs";
/*
 * 修复验证探针：独立于验收脚本，逐条确认三处修复改变了真实行为。
 *
 * 1. I-1 画布后备尺寸 = offsetWidth × DPR（入场动画进行中取样），
 *    并对照 getBoundingClientRect() 折算值证明两者确实不同 —— 也就是断言有区分力。
 * 2. I-2 链接区域多点命中链接本身，且真实点击会打开指向目标的标签页（导航走本地 stub）。
 * 3. I-3 切换态按钮 hover 时保持 accent 配色，与普通 ghost 按钮的 hover 表现不同。
 */

const LINK_URL = "https://example.com/pdfink-a9";
const browser = await chromium.launch(launchOptions({ headless: true }));
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
let failures = 0;
const report = (label, ok, detail) => {
  failures += ok ? 0 : 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n      ${detail}`);
};

await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-testid=toolbar]");

// ---------- 1. 画布尺寸 ----------
await page
  .locator("[data-testid=signature-library]")
  .getByRole("button", { name: "新建签名" })
  .first()
  .click();
await page.waitForSelector("[data-testid=signature-pad-canvas]");
const canvas = await page.evaluate(() => {
  const element = document.querySelector("[data-testid=signature-pad-canvas]");
  const panel = element.parentElement.parentElement;
  return {
    backing: element.width,
    layout: Math.round(element.offsetWidth * devicePixelRatio),
    frame: Math.round(element.getBoundingClientRect().width * devicePixelRatio),
    animation: getComputedStyle(panel).animationName,
  };
});
report(
  "I-1 画布后备尺寸在入场动画进行中即为布局尺寸×DPR",
  canvas.backing === canvas.layout,
  `backing=${canvas.backing} 布局折算=${canvas.layout} getBoundingClientRect 折算=${canvas.frame} 面板动画=${canvas.animation}`,
);
report(
  "I-1 断言有区分力（两种测法在动画中确实给出不同值）",
  canvas.frame !== canvas.layout,
  `getBoundingClientRect 折算=${canvas.frame} ≠ 布局折算=${canvas.layout}，若退回旧写法该断言会失败`,
);
await page.keyboard.press("Escape");
await page.waitForTimeout(350);

// ---------- 2. 链接可点 ----------
await page.locator("[data-testid=toolbar] input[type=file]").setInputFiles(`${FIX}/text-links.pdf`);
await page.waitForSelector("[data-testid=pdf-scroller] a[href]");
await page.waitForTimeout(600);
const hit = await page.evaluate(async () => {
  const anchor = document.querySelector("[data-testid=pdf-scroller] a[href]");
  anchor.scrollIntoView({ block: "center" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const rect = anchor.getBoundingClientRect();
  const layer = document.querySelector(".pdf-text-layer");
  return {
    box: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
    zIndex: getComputedStyle(layer).zIndex,
    hits: [
      [0.5, 0.5],
      [0.25, 0.5],
      [0.75, 0.5],
      [0.5, 0.25],
      [0.5, 0.75],
    ].map(([fx, fy]) => {
      const element = document.elementFromPoint(
        rect.left + rect.width * fx,
        rect.top + rect.height * fy,
      );
      return `${fx},${fy}→${element?.tagName ?? "none"}${element?.closest("a") ? "(命中链接)" : ""}`;
    }),
  };
});
report(
  "I-2 链接区域各采样点都命中链接本身",
  hit.hits.every((item) => item.includes("命中链接")),
  `链接尺寸=${hit.box} 文本层 z-index=${hit.zIndex} 采样=${hit.hits.join(" ")}`,
);

const stubbed = [];
await context.route(LINK_URL, async (route) => {
  stubbed.push(route.request().url());
  await route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<html><body>stub</body></html>",
  });
});
const popupPromise = context.waitForEvent("page", { timeout: 6000 }).catch(() => null);
const clicked = await page
  .locator(`[data-testid=pdf-scroller] a[href="${LINK_URL}"]`)
  .click({ timeout: 4000 })
  .then(() => true)
  .catch(() => false);
const popup = await popupPromise;
let popupUrl = null;
if (popup) {
  await popup.waitForLoadState("domcontentloaded").catch(() => {});
  popupUrl = popup.url();
  await popup.close().catch(() => {});
}
await context.unroute(LINK_URL);
report(
  "I-2 真实点击会打开指向目标的标签页",
  clicked && popupUrl !== null && popupUrl.startsWith(LINK_URL),
  `点击成功=${clicked} 新标签页=${popupUrl} 本地 stub 接管=${JSON.stringify(stubbed)}`,
);

// ---------- 3. 切换态 hover ----------
const fitButton = page.locator("[data-testid=fit-width]");
if (!(await fitButton.evaluate((element) => element.classList.contains("button--toggled")))) {
  await fitButton.click();
  await page.waitForTimeout(600);
}
const readStyle = (locator) =>
  locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return `${style.borderTopColor} / ${style.backgroundColor}`;
  });
const fitResting = await readStyle(fitButton);
await fitButton.hover();
await page.waitForTimeout(220);
const fitHovered = await readStyle(fitButton);

const ghost = page.locator('[data-testid=toolbar] button[title="缩小"]');
const ghostResting = await readStyle(ghost);
await ghost.hover();
await page.waitForTimeout(220);
const ghostHovered = await readStyle(ghost);

report(
  "I-3 切换态按钮 hover 不改变激活配色",
  fitHovered === fitResting,
  `静止=${fitResting}；hover=${fitHovered}`,
);
report(
  "I-3 对照：普通 ghost 按钮 hover 仍会变色（规则未被整体压掉）",
  ghostHovered !== ghostResting,
  `静止=${ghostResting}；hover=${ghostHovered}`,
);

await browser.close();
console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
process.exitCode = failures === 0 ? 0 : 1;
