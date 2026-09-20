/**
 * Tailwind 迁移后的计算样式核对：把关键元素的实际样式与原 BEM 实现逐项比对。
 * 断言值来自迁移前的 style.css（硬编码，不由当前实现推导）。
 */

import { mkdir } from "node:fs/promises";
import { chromium, launchOptions, APP, FIX, OUT_TW } from "../harness.mjs";

const OUT = OUT_TW;
await mkdir(OUT, { recursive: true });

let failures = 0;
function eq(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n        期望 ${expected}  实际 ${actual}`);
}

const browser = await chromium.launch(launchOptions({}));
const page = await browser.newPage({
  viewport: { width: 1080, height: 680 },
  deviceScaleFactor: 1,
});
await page.goto(APP, { waitUntil: "domcontentloaded" });

// ---------- 空状态 ----------
await page.waitForSelector('[data-testid="toolbar"]');
await page.screenshot({ path: `${OUT}/empty-state.png` });

const emptyState = await page.evaluate(() => {
  const box = document.querySelector("main > section > div");
  const s = getComputedStyle(box);
  return {
    maxWidth: s.maxWidth,
    padding: s.padding,
    gap: s.gap,
    alignItems: s.alignItems,
    borderRadius: s.borderRadius,
    background: s.backgroundColor,
    border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
    textAlign: s.textAlign,
  };
});
eq("空状态 max-width", emptyState.maxWidth, "460px");
eq("空状态 padding", emptyState.padding, "32px");
eq("空状态 gap", emptyState.gap, "12px");
eq("空状态 圆角", emptyState.borderRadius, "12px");
eq("空状态 背景", emptyState.background, "rgb(255, 255, 255)");
eq("空状态 描边", emptyState.border, "1px solid rgb(220, 223, 230)");

const emptyBodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const emptyBodyFont = await page.evaluate(
  () =>
    `${getComputedStyle(document.body).fontSize} / ${getComputedStyle(document.body).lineHeight}`,
);
eq("body 背景（深色跟随前的浅色）", emptyBodyBg, "rgb(238, 240, 244)");
eq("body 字号/行高", emptyBodyFont, "14px / 21px");
const bodyFontFamily = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
console.log(`INFO  body 字体族: ${bodyFontFamily}`);

// ---------- 打开文档 ----------
await page.locator('[data-testid="toolbar"] input[type=file]').setInputFiles(`${FIX}/plain.pdf`);
await page.waitForFunction(
  () => {
    const wrapper = document.querySelector(".pdf-page");
    const canvas = wrapper?.querySelector("canvas");
    return wrapper && canvas && canvas.width > 0;
  },
  null,
  { timeout: 60000 },
);
await page.waitForTimeout(600);

const toolbar = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="toolbar"]');
  const s = getComputedStyle(el);
  return {
    padding: s.padding,
    gap: s.gap,
    background: s.backgroundColor,
    borderBottom: `${s.borderBottomWidth} ${s.borderBottomStyle} ${s.borderBottomColor}`,
    flexWrap: s.flexWrap,
  };
});
eq("工具栏 padding", toolbar.padding, "10px 16px");
eq("工具栏 gap", toolbar.gap, "18px");
eq("工具栏 背景", toolbar.background, "rgb(255, 255, 255)");
eq("工具栏 下边框", toolbar.borderBottom, "1px solid rgb(220, 223, 230)");

const primary = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="toolbar"] .button--primary');
  const s = getComputedStyle(el);
  return {
    fontSize: s.fontSize,
    padding: s.padding,
    borderRadius: s.borderRadius,
    background: s.backgroundColor,
    color: s.color,
    border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
    lineHeight: s.lineHeight,
    display: s.display,
    gap: s.gap,
  };
});
eq("主按钮 字号", primary.fontSize, "14px");
eq("主按钮 padding", primary.padding, "7px 12px");
eq("主按钮 圆角", primary.borderRadius, "6px");
eq("主按钮 背景", primary.background, "rgb(47, 111, 237)");
eq("主按钮 文字色", primary.color, "rgb(255, 255, 255)");
eq("主按钮 行高", primary.lineHeight, "16.8px");
// 按钮是 flex 容器（工具栏）的子元素，inline-flex 会被块化为 flex——迁移前后一致。
eq("主按钮 display", primary.display, "flex");
eq("主按钮 gap", primary.gap, "6px");

const ghost = await page.evaluate(() => {
  const el = [...document.querySelectorAll('[data-testid="toolbar"] .button--ghost')].find(
    (item) => item.textContent.trim() === "撤销",
  );
  const s = getComputedStyle(el);
  return {
    background: s.backgroundColor,
    border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
    color: s.color,
  };
});
eq("次要按钮 背景", ghost.background, "rgb(255, 255, 255)");
eq("次要按钮 描边", ghost.border, "1px solid rgb(220, 223, 230)");

const smallButton = await page.evaluate(() => {
  const s = getComputedStyle(
    document.querySelector('[data-testid="signature-library"] .button--small'),
  );
  return { padding: s.padding, fontSize: s.fontSize };
});
eq("小按钮 padding", smallButton.padding, "4px 9px");
eq("小按钮 字号", smallButton.fontSize, "13px");

const pageInput = await page.evaluate(() => {
  const s = getComputedStyle(document.querySelector('[data-testid="page-input"]'));
  return {
    width: s.width,
    padding: s.padding,
    textAlign: s.textAlign,
    fontSize: s.fontSize,
    borderRadius: s.borderRadius,
  };
});
eq("页码输入 宽度", pageInput.width, "56px");
eq("页码输入 padding", pageInput.padding, "5px 6px");
eq("页码输入 对齐", pageInput.textAlign, "center");

const zoom = await page.evaluate(() => {
  const s = getComputedStyle(document.querySelector('[data-testid="zoom-level"]'));
  return {
    minWidth: s.minWidth,
    fontSize: s.fontSize,
    color: s.color,
    fontVariantNumeric: s.fontVariantNumeric,
    textAlign: s.textAlign,
  };
});
eq("缩放显示 min-width", zoom.minWidth, "52px");
eq("缩放显示 字号", zoom.fontSize, "13px");
eq("缩放显示 颜色", zoom.color, "rgb(107, 114, 128)");
eq("缩放显示 数字对齐", zoom.fontVariantNumeric, "tabular-nums");

const fileName = await page.evaluate(() => {
  const s = getComputedStyle(document.querySelector('[data-testid="file-name"]'));
  return { maxWidth: s.maxWidth, fontSize: s.fontSize, color: s.color, overflow: s.overflow };
});
eq("文件名 max-width", fileName.maxWidth, "260px");
eq("文件名 字号", fileName.fontSize, "13px");
eq("文件名 溢出", fileName.overflow, "hidden");

const thumbsPanel = await page.evaluate(() => {
  const el = document.querySelector("main > aside");
  const s = getComputedStyle(el);
  return {
    width: s.width,
    padding: s.padding,
    gap: s.gap,
    borderRight: `${s.borderRightWidth} ${s.borderRightColor}`,
  };
});
eq("缩略图栏 宽度", thumbsPanel.width, "172px");
eq("缩略图栏 padding", thumbsPanel.padding, "12px");
eq("缩略图栏 gap", thumbsPanel.gap, "10px");
eq("缩略图栏 右边框", thumbsPanel.borderRight, "1px rgb(220, 223, 230)");

const thumbButton = await page.evaluate(() => {
  const el = document.querySelector("main > aside ol li button");
  const s = getComputedStyle(el);
  return {
    padding: s.padding,
    gap: s.gap,
    borderRadius: s.borderRadius,
    background: s.backgroundColor,
    border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
  };
});
eq("缩略图按钮 padding", thumbButton.padding, "6px");
eq("缩略图按钮 gap", thumbButton.gap, "4px");
eq("缩略图按钮 圆角", thumbButton.borderRadius, "6px");
eq("缩略图按钮 背景", thumbButton.background, "rgb(247, 248, 250)");

const viewer = await page.evaluate(() => {
  const s = getComputedStyle(document.querySelector('[data-testid="pdf-scroller"]'));
  return { position: s.position, overflow: s.overflow, overscrollBehavior: s.overscrollBehavior };
});
eq("阅读区 position", viewer.position, "relative");
eq("阅读区 overflow", viewer.overflow, "auto");
eq("阅读区 overscroll", viewer.overscrollBehavior, "contain");

const pagesBox = await page.evaluate(() => {
  const s = getComputedStyle(document.querySelector('[data-testid="pdf-scroller"] > div'));
  return { gap: s.gap, padding: s.padding };
});
eq("页面容器 gap", pagesBox.gap, "16px");
eq("页面容器 padding", pagesBox.padding, "16px");

const pdfPage = await page.evaluate(() => {
  const el = document.querySelector(".pdf-page");
  const s = getComputedStyle(el);
  return {
    background: s.backgroundColor,
    boxShadow: s.boxShadow,
    position: s.position,
    scaleFactor: s.getPropertyValue("--scale-factor").trim(),
    userUnit: s.getPropertyValue("--user-unit").trim(),
  };
});
eq("页面 背景", pdfPage.background, "rgb(255, 255, 255)");
eq("页面 position", pdfPage.position, "relative");
console.log(`INFO  页面 box-shadow: ${pdfPage.boxShadow}`);
console.log(`INFO  --scale-factor=${pdfPage.scaleFactor} --user-unit=${pdfPage.userUnit}`);

const textLayer = await page.evaluate(() => {
  const el = document.querySelector(".pdf-text-layer");
  const s = getComputedStyle(el);
  const span = el.querySelector("span");
  const spanStyle = span ? getComputedStyle(span) : null;
  return {
    position: s.position,
    overflow: s.overflow,
    lineHeight: s.lineHeight,
    totalScale: s.getPropertyValue("--total-scale-factor").trim(),
    spanCount: el.querySelectorAll("span").length,
    spanPosition: spanStyle?.position ?? "none",
    spanColor: spanStyle?.color ?? "none",
  };
});
eq("文本层 position", textLayer.position, "absolute");
eq("文本层 overflow", textLayer.overflow, "clip");
// line-height: 1 是相对字号的无单位值，计算后按当前 14px 字号折算成 14px。
eq("文本层 line-height", textLayer.lineHeight, "14px");
eq("文本层 span position", textLayer.spanPosition, "absolute");
eq("文本层 span 颜色", textLayer.spanColor, "rgba(0, 0, 0, 0)");
console.log(
  `INFO  文本层 span 数量=${textLayer.spanCount} --total-scale-factor=${textLayer.totalScale}`,
);

const libraryPanel = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="signature-library"]');
  const s = getComputedStyle(el);
  return {
    width: s.width,
    padding: s.padding,
    gap: s.gap,
    borderLeft: `${s.borderLeftWidth} ${s.borderLeftColor}`,
    overflow: s.overflow,
  };
});
eq("签名库 宽度", libraryPanel.width, "248px");
eq("签名库 padding", libraryPanel.padding, "12px");
eq("签名库 gap", libraryPanel.gap, "10px");
eq("签名库 左边框", libraryPanel.borderLeft, "1px rgb(220, 223, 230)");

await page.screenshot({ path: `${OUT}/doc-open.png` });

// ---------- 手写弹窗 ----------
await page
  .locator('[data-testid="signature-library"]')
  .getByRole("button", { name: "新建签名" })
  .first()
  .click();
await page.waitForSelector('[data-testid="signature-pad-canvas"]');
await page.waitForTimeout(300);

const padCanvas = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="signature-pad-canvas"]');
  const s = getComputedStyle(el);
  return {
    height: s.height,
    borderRadius: s.borderRadius,
    borderStyle: s.borderTopStyle,
    borderColor: s.borderTopColor,
    backgroundImage: s.backgroundImage.slice(0, 48),
    touchAction: s.touchAction,
    cursor: s.cursor,
  };
});
eq("手写区 高度", padCanvas.height, "200px");
eq("手写区 圆角", padCanvas.borderRadius, "8px");
eq("手写区 边框", padCanvas.borderStyle, "dashed");
eq("手写区 边框色", padCanvas.borderColor, "rgb(195, 200, 210)");
eq("手写区 touch-action", padCanvas.touchAction, "none");
eq("手写区 cursor", padCanvas.cursor, "crosshair");
console.log(`INFO  手写区底纹: ${padCanvas.backgroundImage}`);

const padPanel = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="signature-pad-dialog"] > div');
  const s = getComputedStyle(el);
  return {
    padding: s.padding,
    gap: s.gap,
    borderRadius: s.borderRadius,
    maxWidth: s.maxWidth,
    background: s.backgroundColor,
  };
});
eq("手写弹窗 padding", padPanel.padding, "18px");
eq("手写弹窗 gap", padPanel.gap, "14px");
eq("手写弹窗 圆角", padPanel.borderRadius, "10px");
eq("手写弹窗 max-width", padPanel.maxWidth, "560px");

const scrim = await page.evaluate(() => {
  const s = getComputedStyle(document.querySelector('[data-testid="signature-pad-dialog"]'));
  return {
    position: s.position,
    zIndex: s.zIndex,
    padding: s.padding,
    background: s.backgroundColor,
  };
});
eq("遮罩 position", scrim.position, "fixed");
eq("遮罩 z-index", scrim.zIndex, "20");
eq("遮罩 padding", scrim.padding, "20px");
eq("遮罩 背景", scrim.background, "rgba(15, 23, 42, 0.45)");

await page.screenshot({ path: `${OUT}/pad-dialog.png` });
await page
  .locator('[data-testid="signature-pad-dialog"]')
  .getByRole("button", { name: "取消" })
  .click();
await page.waitForTimeout(300);

console.log(`\n合计失败：${failures}`);
await browser.close();
process.exit(failures > 0 ? 1 : 0);
