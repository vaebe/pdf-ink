/**
 * 视觉冒烟：签名库 / 编辑层 / 确认弹窗（浅色 + 深色）的计算样式与截图。
 * 断言值取迁移前 style.css 的原始声明。
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

const GLYPHS = {
  R: [
    [
      [0.15, 0.85],
      [0.15, 0.15],
      [0.85, 0.5],
    ],
  ],
  C: [
    [
      [0.8, 0.25],
      [0.35, 0.2],
      [0.2, 0.6],
      [0.6, 0.8],
      [0.82, 0.62],
    ],
  ],
};

const browser = await chromium.launch(launchOptions({}));

async function drawGlyph(page, glyph) {
  const box = await page.locator('[data-testid="signature-pad-canvas"]').boundingBox();
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
    .locator('[data-testid="signature-library"]')
    .getByRole("button", { name: "新建签名" })
    .first()
    .click();
  await page.waitForSelector('[data-testid="signature-pad-canvas"]');
  // 弹窗有 0.18s 入场动画，等它结束后再取坐标，避免量到缩放中的包围盒。
  await page.waitForTimeout(320);
  await drawGlyph(page, glyph);
  await page
    .locator('[data-testid="signature-pad-dialog"]')
    .getByRole("button", { name: /保存到签名库|保存中/ })
    .click();
  await page.waitForSelector('[data-testid="signature-pad-dialog"]', { state: "hidden" });
}

for (const scheme of ["light", "dark"]) {
  console.log(`\n===== ${scheme} =====`);
  const page = await browser.newPage({
    viewport: { width: 1180, height: 780 },
    colorScheme: scheme,
  });
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="toolbar"]');

  if (scheme === "dark") {
    const rootVars = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return {
        surface: s.getPropertyValue("--surface").trim(),
        accent: s.getPropertyValue("--accent").trim(),
        colorScheme: s.colorScheme,
      };
    });
    eq("深色 surface 令牌", rootVars.surface, "#1c1f26");
    eq("深色 accent 令牌", rootVars.accent, "#6d9bff");
    eq("深色 color-scheme", rootVars.colorScheme, "dark");
  }

  // ---------- 打开文档（此时无未导出编辑，不会弹确认框） ----------
  await page.locator('[data-testid="toolbar"] input[type=file]').setInputFiles(`${FIX}/plain.pdf`);
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector(".pdf-page canvas");
      return canvas && canvas.width > 0;
    },
    null,
    { timeout: 60000 },
  );
  await page.waitForTimeout(500);

  await createSignature(page, "R");
  await createSignature(page, "C");
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="library-item"]').length === 2,
  );

  const libraryItem = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="library-item"]');
    const s = getComputedStyle(el);
    const preview = document.querySelector('[data-testid="library-item-preview"]');
    const ps = getComputedStyle(preview);
    return {
      item: {
        padding: s.padding,
        gap: s.gap,
        borderRadius: s.borderRadius,
        background: s.backgroundColor,
        border: `${s.borderTopWidth} ${s.borderTopColor}`,
      },
      preview: {
        maxHeight: ps.maxHeight,
        borderRadius: ps.borderRadius,
        objectFit: ps.objectFit,
        background: ps.backgroundColor,
      },
    };
  });
  eq("签名卡 padding", libraryItem.item.padding, "8px");
  eq("签名卡 gap", libraryItem.item.gap, "6px");
  eq("签名卡 圆角", libraryItem.item.borderRadius, "8px");
  eq("预览图 max-height", libraryItem.preview.maxHeight, "62px");
  eq("预览图 圆角", libraryItem.preview.borderRadius, "4px");
  eq("预览图 object-fit", libraryItem.preview.objectFit, "contain");
  // 「签名名 字号」一项已随名称输入一并移除（产品不再渲染 library-item-name），
  // 留着会因 querySelector 返回 null 让整个探针在 getComputedStyle 处抛错。

  // 选中模板后卡片应高亮
  await page.locator('[data-testid="library-item-pick"]').first().click();
  await page.waitForTimeout(200);
  const activeItem = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="library-item"]');
    const s = getComputedStyle(el);
    return {
      dataActive: el.dataset.active,
      border: s.borderTopColor,
      background: s.backgroundColor,
    };
  });
  eq("激活卡片 data-active", activeItem.dataActive, "true");
  console.log(`INFO  激活卡片 边框=${activeItem.border} 背景=${activeItem.background}`);
  if (scheme === "light") {
    eq("激活卡片 边框色", activeItem.border, "rgb(47, 111, 237)");
  }

  await page.screenshot({ path: `${OUT}/library-${scheme}.png` });

  // ---------- 放置签名（点一次即进入放置模式，重复点击会退出） ----------
  const pageBox = await page.locator('.pdf-page[data-page-index="0"]').boundingBox();
  await page.mouse.click(pageBox.x + pageBox.width * 0.35, pageBox.y + pageBox.height * 0.3);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="placement"]').length === 1,
  );

  const overlay = await page.evaluate(() => {
    const item = document.querySelector('[data-testid="placement"]');
    const s = getComputedStyle(item);
    const handle = document.querySelector('[data-testid="placement-handle"]');
    const hs = getComputedStyle(handle);
    const del = document.querySelector('[data-testid="placement-delete"]');
    const ds = getComputedStyle(del);
    const frame = document.querySelector('[data-testid="placement-frame"]');
    const fs = getComputedStyle(frame);
    return {
      item: {
        position: s.position,
        cursor: s.cursor,
        transformOrigin: s.transformOrigin,
        touchAction: s.touchAction,
        pointerEvents: s.pointerEvents,
      },
      handle: {
        width: hs.width,
        height: hs.height,
        marginTop: hs.marginTop,
        marginLeft: hs.marginLeft,
        borderRadius: hs.borderRadius,
        border: `${hs.borderTopWidth} ${hs.borderTopColor}`,
        background: hs.backgroundColor,
      },
      del: {
        padding: ds.padding,
        borderRadius: ds.borderRadius,
        fontSize: ds.fontSize,
        color: ds.color,
        background: ds.backgroundColor,
      },
      frame: { borderStyle: fs.borderTopStyle, borderColor: fs.borderTopColor },
    };
  });
  eq("实例 position", overlay.item.position, "absolute");
  eq("实例 cursor", overlay.item.cursor, "move");
  eq("实例 transform-origin", overlay.item.transformOrigin, "0px 0px");
  eq("实例 touch-action", overlay.item.touchAction, "none");
  eq("实例 pointer-events", overlay.item.pointerEvents, "auto");
  eq("手柄 尺寸", `${overlay.handle.width} x ${overlay.handle.height}`, "11px x 11px");
  eq(
    "手柄 左上外边距",
    `${overlay.handle.marginTop} / ${overlay.handle.marginLeft}`,
    "-6px / -6px",
  );
  eq("手柄 圆角", overlay.handle.borderRadius, "2px");
  eq("删除按钮 padding", overlay.del.padding, "3px 8px");
  eq("删除按钮 圆角", overlay.del.borderRadius, "4px");
  eq("删除按钮 字号", overlay.del.fontSize, "12px");
  eq("选中框 虚线", overlay.frame.borderStyle, "dashed");

  await page.screenshot({ path: `${OUT}/placed-${scheme}.png` });

  // ---------- 确认弹窗（放弃未导出编辑） ----------
  await page
    .locator('[data-testid="toolbar"] input[type=file]')
    .setInputFiles(`${FIX}/text-links.pdf`);
  await page.waitForSelector('[data-testid="confirm-dialog"]');
  await page.waitForTimeout(400);

  const dialog = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="confirm-dialog"] > div');
    const s = getComputedStyle(panel);
    const icon = panel.querySelector("span");
    const is = getComputedStyle(icon);
    const title = panel.querySelector("h2");
    const details = panel.querySelector("ul");
    const ds = details ? getComputedStyle(details) : null;
    const actions = panel.lastElementChild;
    const as = getComputedStyle(actions);
    return {
      panel: {
        maxWidth: s.maxWidth,
        padding: s.padding,
        gap: s.gap,
        borderRadius: s.borderRadius,
        background: s.backgroundColor,
      },
      icon: {
        width: is.width,
        height: is.height,
        borderRadius: is.borderRadius,
        display: is.display,
        color: is.color,
        background: is.backgroundColor,
      },
      titleFontSize: getComputedStyle(title).fontSize,
      details: ds
        ? {
            listStyleType: ds.listStyleType,
            padding: ds.padding,
            gap: ds.gap,
            borderRadius: ds.borderRadius,
            fontSize: ds.fontSize,
            background: ds.backgroundColor,
          }
        : null,
      actions: { justifyContent: as.justifyContent, gap: as.gap },
      focusedText: document.activeElement?.textContent?.trim() ?? "",
    };
  });
  eq("确认框 max-width", dialog.panel.maxWidth, "440px");
  eq("确认框 padding", dialog.panel.padding, "20px");
  eq("确认框 gap", dialog.panel.gap, "16px");
  eq("确认框 圆角", dialog.panel.borderRadius, "12px");
  eq("确认框 图标尺寸", `${dialog.icon.width} x ${dialog.icon.height}`, "34px x 34px");
  // Tailwind v4 的 rounded-full 是 calc(infinity * 1px)，在 34px 方框上按规范被夹到 17px，
  // 与原实现的 border-radius: 50% 渲染结果一致。
  eq("确认框 图标圆角", ["50%", "3.35544e+07px"].includes(dialog.icon.borderRadius), true);
  eq("确认框 图标布局", dialog.icon.display, "grid");
  eq("确认框 标题字号", dialog.titleFontSize, "15px");
  eq("明细 项目符号", dialog.details?.listStyleType, "disc");
  eq("明细 padding", dialog.details?.padding, "10px 12px 10px 28px");
  eq("明细 gap", dialog.details?.gap, "4px");
  eq("明细 圆角", dialog.details?.borderRadius, "8px");
  eq("明细 字号", dialog.details?.fontSize, "13px");
  eq("按钮组 右对齐", dialog.actions.justifyContent, "flex-end");
  eq("按钮组 gap", dialog.actions.gap, "8px");
  eq("初始焦点", dialog.focusedText, "取消");

  await page.screenshot({ path: `${OUT}/dialog-warning-${scheme}.png` });
  await page
    .locator('[data-testid="confirm-dialog"]')
    .getByRole("button", { name: "取消" })
    .click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/after-cancel-${scheme}.png` });

  await page.close();
}

console.log(`\n合计失败：${failures}`);
await browser.close();
process.exit(failures > 0 ? 1 : 0);
