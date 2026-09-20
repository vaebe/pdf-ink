// 审查探针（只读，不改动项目文件）：
// 1) 手写弹窗画布的分辨率是否按「入场动画中的缩放盒子」计算（疑似缺陷）
// 2) 链接层与文字层的命中顺序（链接是否真的可点）
// 3) 同属性双工具类：自适应宽度按钮的 toggled 态是否生效
// 4) 深色模式主按钮的文字对比度

import { chromium, launchOptions, APP, FIX } from "../harness.mjs";
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  :: ${detail}` : ""}`);
}

const browser = await chromium.launch(launchOptions({}));
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

let popupOpened = false;
context.on("page", () => {
  popupOpened = true;
});
const externalRequests = [];
page.on("request", (request) => {
  if (request.url().includes("example.com")) externalRequests.push(request.url());
});

await page.goto(APP, { waitUntil: "domcontentloaded" });

// ---------- 1) 手写弹窗画布分辨率 ----------
await page.locator("text=新建签名").first().click();
// 打开后立刻测量（动画仍在进行中）
const immediate = await page.evaluate(() => {
  const canvas = document.querySelector("[data-testid=signature-pad-canvas]");
  const panel = canvas?.closest("div");
  const rect = canvas.getBoundingClientRect();
  return {
    backing: canvas?.width ?? -1,
    offsetWidth: canvas?.offsetWidth ?? -1,
    rectWidth: rect.width,
    dpr: window.devicePixelRatio,
    panelTransform: panel ? getComputedStyle(panel).transform : null,
    animationName: panel ? getComputedStyle(panel).animationName : null,
  };
});
// 等动画结束（0.18s）后再测一次
await page.waitForTimeout(500);
const settled = await page.evaluate(() => {
  const canvas = document.querySelector("[data-testid=signature-pad-canvas]");
  return { backing: canvas.width, offsetWidth: canvas.offsetWidth };
});

const expected = Math.round(settled.offsetWidth * immediate.dpr);
check(
  "手写弹窗：画布后备分辨率 = 布局宽 × DPR",
  settled.backing === expected,
  `backing=${settled.backing}, offsetWidth×dpr=${expected}, 打开瞬间 rect.width=${immediate.rectWidth.toFixed(1)}, 动画=${immediate.animationName}, transform=${immediate.panelTransform}`,
);

// 画到最右侧，检查最右 1 列是否真的有墨迹（若画布偏小，右侧会被裁掉）
await page.evaluate(() => {
  window.__rightEdgeInk = 0;
});
await page.mouse.move(
  (await page.locator("[data-testid=signature-pad-canvas]").boundingBox()).x + 20,
  (await page.locator("[data-testid=signature-pad-canvas]").boundingBox()).y + 100,
);
const canvasBox = await page.locator("[data-testid=signature-pad-canvas]").boundingBox();
await page.mouse.move(canvasBox.x + 10, canvasBox.y + 100);
await page.mouse.down();
await page.mouse.move(canvasBox.x + canvasBox.width - 4, canvasBox.y + 100, { steps: 24 });
await page.mouse.up();
const edgeInk = await page.evaluate(() => {
  const canvas = document.querySelector("[data-testid=signature-pad-canvas]");
  const ctx = canvas.getContext("2d");
  const rows = ctx.getImageData(Math.max(canvas.width - 3, 0), 0, 3, canvas.height).data;
  let ink = 0;
  for (let i = 3; i < rows.length; i += 4) if (rows[i] > 0) ink += 1;
  return { ink, backing: canvas.width, cssWidth: canvas.clientWidth, dpr: window.devicePixelRatio };
});
check(
  "手写弹窗：最右侧 3 列能画出笔迹（画布未被裁）",
  edgeInk.ink > 0,
  `右侧墨迹像素=${edgeInk.ink}, backing=${edgeInk.backing}, clientWidth=${edgeInk.cssWidth}, dpr=${edgeInk.dpr}`,
);

await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// ---------- 2) 链接层命中顺序 ----------
await page.locator("[data-testid=toolbar] input[type=file]").setInputFiles(`${FIX}/text-links.pdf`);
await page.waitForSelector("[data-testid=pdf-scroller] canvas", { timeout: 20000 });
await page.waitForTimeout(1200);

const hit = await page.evaluate(() => {
  const linkSpan = document.querySelector("[data-testid=pdf-scroller] a")?.parentElement;
  const textLayer = document.querySelector(".pdf-text-layer");
  if (!linkSpan) return { error: "未找到链接层" };
  const rect = linkSpan.getBoundingClientRect();
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const top = document.elementFromPoint(cx, cy);
  const chain = [];
  let node = top;
  while (node && node !== document.body) {
    chain.push(
      `${node.tagName.toLowerCase()}${node.dataset?.testid ? `[${node.dataset.testid}]` : ""}.${(node.className || "").toString().split(" ").slice(0, 2).join(".")}`,
    );
    node = node.parentElement;
  }
  return {
    linkRect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    topmost: chain[0],
    chain: chain.slice(0, 4),
    isAnchorOrChild: Boolean(top?.closest("a")),
    textLayerZ: textLayer ? getComputedStyle(textLayer).zIndex : null,
    firstTextSpanZ: textLayer?.firstElementChild
      ? getComputedStyle(textLayer.firstElementChild).zIndex
      : null,
    linkLayerZ: getComputedStyle(linkSpan.parentElement).zIndex,
  };
});
console.log("  链接命中链:", JSON.stringify(hit, null, 2));

// 真点击，看是否触发新标签页
if (hit.linkRect) {
  const cx = hit.linkRect.x + hit.linkRect.w / 2;
  const cy = hit.linkRect.y + hit.linkRect.h / 2;
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(600);
}
check(
  "点击 PDF 链接能触发跳转",
  popupOpened || externalRequests.length > 0,
  `popup=${popupOpened}, 外发请求=${JSON.stringify(externalRequests)}`,
);

// ---------- 3) 自适应宽度按钮的 toggled 态 ----------
const toggleProbe = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll("[data-testid=toolbar] button")];
  const target = buttons.find((button) => button.textContent?.trim() === "自适应宽度");
  if (!target) return { error: "未找到按钮" };
  const style = getComputedStyle(target);
  return {
    classes: target.className,
    borderColor: style.borderColor,
    background: style.backgroundColor,
    color: style.color,
  };
});
console.log("  自适应宽度按钮:", JSON.stringify(toggleProbe));
check(
  "自适应宽度按钮处于 toggled 态（accent 描边而非灰色）",
  toggleProbe.classes?.includes("button--toggled") &&
    !toggleProbe.borderColor.includes("220, 223, 230") &&
    !toggleProbe.borderColor.includes("rgb(220, 223, 230)"),
  `classes=${toggleProbe.classes}, border=${toggleProbe.borderColor}, bg=${toggleProbe.background}`,
);

// ---------- 4) 深色模式主按钮对比度 ----------
const darkContext = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: "dark",
});
const darkPage = await darkContext.newPage();
await darkPage.goto(APP, { waitUntil: "domcontentloaded" });
const contrast = await darkPage.evaluate(() => {
  const button = [...document.querySelectorAll("button")].find((item) =>
    item.textContent?.includes("选择本地 PDF"),
  );
  const style = getComputedStyle(button);
  const parse = (value) =>
    value
      .match(/[\d.]+/g)
      .slice(0, 3)
      .map(Number);
  const luminance = ([r, g, b]) => {
    const channel = (raw) => {
      const c = raw / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const fg = luminance(parse(style.color));
  const bg = luminance(parse(style.backgroundColor));
  const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  return { color: style.color, background: style.backgroundColor, ratio };
});
console.log("  深色主按钮:", JSON.stringify(contrast));
check(
  "深色模式主按钮文字对比度 ≥ 4.5:1",
  contrast.ratio >= 4.5,
  `ratio=${contrast.ratio.toFixed(2)}, color=${contrast.color}, bg=${contrast.background}`,
);

await browser.close();

const failed = results.filter((item) => !item.ok);
console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项。`);
process.exit(failed.length > 0 ? 1 : 0);
