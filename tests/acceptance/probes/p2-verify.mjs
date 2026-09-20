/**
 * 第二轮审查（3 项 P2）的独立验证探针。
 *
 * 与 acceptance.mjs 分开，是因为这三条都属于「构建、类型、既有断言全绿也照样坏」的类别：
 * 只有真实浏览器里的布局几何、命中矩形与画布后备尺寸能看见它们。
 * 每条断言都附一条「区分力对照」，用来证明它能区分新旧实现，而不是恰好通过。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, launchOptions, APP, FIX, OUT_ROOT, PY, PY_DIR } from "../harness.mjs";

const execFileAsync = promisify(execFile);

const OUT = OUT_ROOT;

let passed = 0;
let failed = 0;
function check(id, ok, detail) {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail ? `\n        ${detail}` : ""}`);
}

async function probePdf(path) {
  const { stdout } = await execFileAsync(PY, [`${PY_DIR}/pdf_probe.py`, path]);
  return JSON.parse(stdout);
}

async function openApp(page) {
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-testid=toolbar]");
}

async function handleConfirmDialog(page, action, timeout = 1500) {
  const button = page
    .locator("[data-testid=confirm-dialog]")
    .getByRole("button", { name: action })
    .first();
  try {
    await button.click({ timeout });
    await page.waitForTimeout(200);
    return true;
  } catch {
    return false;
  }
}

async function openPdf(page, fileName, expectedPages) {
  await page.locator("[data-testid=toolbar] input[type=file]").setInputFiles(`${FIX}/${fileName}`);
  await handleConfirmDialog(page, "放弃并打开", 900);
  await page.waitForFunction(
    ({ name, pages }) => {
      const shown = document.querySelector("[data-testid=file-name]")?.textContent ?? "";
      const wrappers = document.querySelectorAll(".pdf-page").length;
      const canvas = document.querySelector(".pdf-page canvas");
      return shown.includes(name) && wrappers === pages && canvas && canvas.width > 0;
    },
    { name: fileName, pages: expectedPages },
    { timeout: 60000 },
  );
}

async function drawSimpleGlyph(page) {
  const box = await page.locator("[data-testid=signature-pad-canvas]").boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.62);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.24, { steps: 10 });
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.7, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

async function createSignature(page) {
  await page
    .locator("[data-testid=signature-library]")
    .getByRole("button", { name: "新建签名" })
    .first()
    .click();
  await page.waitForSelector("[data-testid=signature-pad-canvas]");
  await page.waitForTimeout(250);
  await drawSimpleGlyph(page);
  await page
    .locator("[data-testid=signature-pad-dialog]")
    .getByRole("button", { name: /保存到签名库|保存中/ })
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll("[data-testid=library-item]").length > 0,
    null,
    { timeout: 15000 },
  );
}

async function pickTemplate(page, index) {
  const active = await page
    .locator("[data-testid=library-item]")
    .nth(index)
    .evaluate((element) => element.dataset.active === "true");
  if (!active) {
    await page.locator("[data-testid=library-item-pick]").nth(index).click();
  }
  await page.waitForTimeout(150);
}

const browser = await chromium.launch(launchOptions({ headless: true }));

try {
  // ================================================================
  // P2-1 放大后页面左边缘是否还能滚动到达
  // ================================================================
  console.log("\n=== P2-1 放大后页面左侧可达性 ===");
  const geometryContext = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const geometryPage = await geometryContext.newPage();
  await openApp(geometryPage);
  await openPdf(geometryPage, "plain.pdf", 2);

  // 确保「自适应宽度」是关的（产品默认已关闭，这里仍按状态判断，不假设默认值），
  // 再放大到页面明显宽于容器。
  const fitButton = geometryPage.locator("[data-testid=fit-width]");
  const fitOn = await fitButton.evaluate((element) =>
    element.classList.contains("button--toggled"),
  );
  if (fitOn) {
    await fitButton.click();
  }
  for (let step = 0; step < 5; step += 1) {
    await geometryPage.locator('button[title="放大"]').click();
  }
  await geometryPage.waitForTimeout(800);

  const readGeometry = () =>
    geometryPage.evaluate(() => {
      const scroller = document.querySelector("[data-testid=pdf-scroller]");
      scroller.scrollLeft = 0;
      const content = scroller.firstElementChild;
      const pageElement = scroller.querySelector(".pdf-page");
      const scrollerRect = scroller.getBoundingClientRect();
      const pageRect = pageElement.getBoundingClientRect();
      return {
        clientWidth: scroller.clientWidth,
        scrollWidth: scroller.scrollWidth,
        contentWidth: Math.round(content.getBoundingClientRect().width),
        contentMinWidth: getComputedStyle(content).minWidth,
        // 以「滚动原点」为参照：scrollLeft = 0 时容器的左边界就是用户能滚到的最左位置。
        pageLeftFromOrigin: Math.round(pageRect.left - scrollerRect.left),
        zoom: document.querySelector("[data-testid=zoom-level]").textContent.trim(),
      };
    });

  const atOrigin = await readGeometry();
  check(
    "P2-1a 前置条件：确实放大到出现横向溢出",
    atOrigin.scrollWidth > atOrigin.clientWidth + 40,
    `缩放 ${atOrigin.zoom}，滚动内容宽 ${atOrigin.scrollWidth} > 可视宽 ${atOrigin.clientWidth}`,
  );
  check(
    "P2-1b scrollLeft=0 时页面左边缘在滚动原点右侧（可达）",
    atOrigin.pageLeftFromOrigin >= -1,
    `页面左边缘相对滚动原点 ${atOrigin.pageLeftFromOrigin}px（负值即落在无法滚动到达的区域）；内容层 min-width=${atOrigin.contentMinWidth}，宽 ${atOrigin.contentWidth}px`,
  );

  const rightEdge = await geometryPage.evaluate(() => {
    const scroller = document.querySelector("[data-testid=pdf-scroller]");
    scroller.scrollLeft = scroller.scrollWidth;
    const scrollerRect = scroller.getBoundingClientRect();
    const pageRect = scroller.querySelector(".pdf-page").getBoundingClientRect();
    return {
      pageRightFromOrigin: Math.round(pageRect.right - scrollerRect.left),
      clientWidth: scroller.clientWidth,
      scrollLeft: scroller.scrollLeft,
    };
  });
  check(
    "P2-1c 滚到最右时页面右边缘也可见（两侧都能滚到）",
    rightEdge.pageRightFromOrigin <= rightEdge.clientWidth + 1,
    `scrollLeft=${rightEdge.scrollLeft} 时页面右边缘相对视口左侧 ${rightEdge.pageRightFromOrigin}px，可视宽 ${rightEdge.clientWidth}px`,
  );

  // 区分力对照：把内容层的 min-width 压回 0，复现修复前的行为。
  await geometryPage.addStyleTag({
    content: "[data-testid=pdf-scroller] > div { min-width: 0 !important; }",
  });
  const withoutFix = await readGeometry();
  check(
    "P2-1d 区分力对照：去掉 min-w-max 后左边缘落入不可达区域",
    withoutFix.pageLeftFromOrigin < -40,
    `压回 min-width:0 后页面左边缘 ${withoutFix.pageLeftFromOrigin}px —— 说明 P2-1b 能真正区分新旧实现，不是恒真断言`,
  );
  await geometryContext.close();

  // ================================================================
  // P2-2 贴边放置是否被约束在页面内（预览与导出一致）
  // ================================================================
  console.log("\n=== P2-2 贴边放置的边界约束 ===");
  const edgeContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const edgePage = await edgeContext.newPage();
  await openApp(edgePage);
  // 签名库的模板列表只在打开文档后渲染（App.vue: SignatureLibrary v-if="session"），
  // 因此必须先开文档、再建签名。
  await openPdf(edgePage, "plain.pdf", 2);
  await createSignature(edgePage);
  await pickTemplate(edgePage, 0);
  await edgePage.waitForTimeout(200);

  const readEdgeGeometry = () =>
    edgePage.evaluate(() => {
      const pageElement = document.querySelector('.pdf-page[data-page-index="0"]');
      const items = [...document.querySelectorAll("[data-testid=placement]")];
      const pageRect = pageElement.getBoundingClientRect();
      const itemRect = items.at(-1).getBoundingClientRect();
      return {
        page: {
          left: pageRect.left,
          right: pageRect.right,
          top: pageRect.top,
          bottom: pageRect.bottom,
        },
        item: {
          left: itemRect.left,
          right: itemRect.right,
          top: itemRect.top,
          bottom: itemRect.bottom,
          width: itemRect.width,
          height: itemRect.height,
        },
        count: items.length,
      };
    });

  // 用例一：贴着左边缘点。默认缩放下页面比滚动容器高，下边界点不到，留到用例二。
  const scrollerBox = await edgePage.locator("[data-testid=pdf-scroller]").boundingBox();
  const pageBox = await edgePage.locator('.pdf-page[data-page-index="0"]').boundingBox();
  const leftClick = {
    x: pageBox.x + 6,
    y: Math.min(pageBox.y + pageBox.height - 6, scrollerBox.y + scrollerBox.height - 8),
  };
  await edgePage.mouse.click(leftClick.x, leftClick.y);
  await edgePage.waitForTimeout(300);
  const leftGeometry = await readEdgeGeometry();
  const leftClickFromEdge = leftClick.x - leftGeometry.page.left;
  const leftUnclamped = leftClickFromEdge - leftGeometry.item.width / 2;

  check(
    "P2-2a 前置条件：点击点确实贴着页面左边缘",
    leftClickFromEdge < 12,
    `点击点距页面左边缘 ${leftClickFromEdge.toFixed(1)}px，实例宽 ${leftGeometry.item.width.toFixed(1)}px`,
  );
  check(
    "P2-2b 左边界：实例完整落在页面内，且左边缘被收进页面",
    leftGeometry.item.left >= leftGeometry.page.left - 0.5 &&
      leftGeometry.item.top >= leftGeometry.page.top - 0.5 &&
      leftGeometry.item.right <= leftGeometry.page.right + 0.5 &&
      leftGeometry.item.bottom <= leftGeometry.page.bottom + 0.5 &&
      leftGeometry.item.left - leftGeometry.page.left < 2 &&
      leftUnclamped < -10,
    `实例左边缘距页面左边缘 ${(leftGeometry.item.left - leftGeometry.page.left).toFixed(2)}px；若按点击中心直接摆放则应为 ${leftUnclamped.toFixed(1)}px —— 后者越界，说明这条断言能区分新旧实现`,
  );

  // 用例二：缩小到整页可见，再贴下边缘点，覆盖 y 轴。
  for (let step = 0; step < 2; step += 1) {
    await edgePage.locator('button[title="缩小"]').click();
  }
  await edgePage.waitForTimeout(900);
  const zoomOutScroller = await edgePage.locator("[data-testid=pdf-scroller]").boundingBox();
  const zoomOutPage = await edgePage.locator('.pdf-page[data-page-index="0"]').boundingBox();
  const bottomVisible =
    zoomOutPage.y + zoomOutPage.height <= zoomOutScroller.y + zoomOutScroller.height;
  const bottomClick = {
    x: zoomOutPage.x + zoomOutPage.width / 2,
    y: zoomOutPage.y + zoomOutPage.height - 6,
  };
  // 产品在成功放置一次后会退出放置模式；本段两次贴边点击都是直接点页面（不走
  // placeOnPage），所以第二次点击前必须重新选中模板。少了这一步本次点击不会放下
  // 任何东西，实例数停在 1，P2-2c / P2-2d / P2-2e 会一起变红（P2-2e 少一张图）。
  await pickTemplate(edgePage, 0);
  await edgePage.mouse.click(bottomClick.x, bottomClick.y);
  await edgePage.waitForTimeout(300);
  const bottomGeometry = await readEdgeGeometry();
  const bottomClickFromEdge = bottomGeometry.page.bottom - bottomClick.y;
  const bottomUnclamped = bottomClickFromEdge - bottomGeometry.item.height / 2;

  check(
    "P2-2c 前置条件：整页可见且点击点贴着页面下边缘",
    bottomVisible && bottomClickFromEdge < 12 && bottomGeometry.count === 2,
    `整页可见=${bottomVisible}，点击点距页面下边缘 ${bottomClickFromEdge.toFixed(1)}px，实例高 ${bottomGeometry.item.height.toFixed(1)}px，页面实例数 ${bottomGeometry.count}`,
  );
  check(
    "P2-2d 下边界：实例完整落在页面内，且下边缘被收进页面",
    bottomGeometry.item.top >= bottomGeometry.page.top - 0.5 &&
      bottomGeometry.item.bottom <= bottomGeometry.page.bottom + 0.5 &&
      Math.abs(bottomGeometry.page.bottom - bottomGeometry.item.bottom) < 2 &&
      bottomUnclamped < -10,
    `实例下边缘距页面下边缘 ${(bottomGeometry.page.bottom - bottomGeometry.item.bottom).toFixed(2)}px；若按点击中心直接摆放则应为 ${bottomUnclamped.toFixed(1)}px（越界）`,
  );

  const [download] = await Promise.all([
    edgePage.waitForEvent("download"),
    edgePage.getByRole("button", { name: /下载签名后的 PDF|正在导出/ }).click(),
  ]);
  const exportTarget = `${OUT}/P2-edge-placement.pdf`;
  await download.saveAs(exportTarget);
  const probe = await probePdf(exportTarget);
  const cropbox = probe.pages[0].boxes.cropbox;
  // 页面上正好两个贴边实例，导出里应正好两个图片对象；逐个比对包围盒与页面可见区域。
  const placedImages = probe.pages[0].images;
  const margins = placedImages.map((image) =>
    Math.min(
      image.minCorner[0] - cropbox[0],
      cropbox[2] - image.maxCorner[0],
      image.minCorner[1] - cropbox[1],
      cropbox[3] - image.maxCorner[1],
    ),
  );
  check(
    "P2-2e 导出后两个贴边实例都完整位于页面可见区域内（无裁剪）",
    placedImages.length === 2 && margins.every((value) => value >= -0.5),
    `导出图片 ${placedImages.length} 个，各自到最近页面边界的最小余量 ${margins.map((value) => value.toFixed(1)).join(" / ")}（负数即被裁剪）；页面可见区域 ${JSON.stringify(cropbox)}`,
  );
  await edgeContext.close();

  // ================================================================
  // P2-3 逐页浏览长文档后的离屏资源占用
  // ================================================================
  console.log("\n=== P2-3 离屏页面的渲染资源 ===");
  // 用文字密集夹具 + DPR 2：book-100p.pdf 每页只有 53 个字符，文本层泄漏只剩个位数节点，
  // 看不出实现差异；这份夹具每页约 3300 字符，泄漏量才是真实量级。
  const longContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
  });
  const longPage = await longContext.newPage();
  await openApp(longPage);
  await openPdf(longPage, "heavy-text-40p.pdf", 40);
  await createSignature(longPage);
  await pickTemplate(longPage, 0);

  // 在第 1 页放一个实例，后面用来验证「离屏释放不会丢签名数据」。
  const firstPageBox = await longPage.locator('.pdf-page[data-page-index="0"]').boundingBox();
  await longPage.mouse.click(firstPageBox.x + firstPageBox.width / 2, firstPageBox.y + 120);
  await longPage.waitForTimeout(400);

  const readMemory = () =>
    longPage.evaluate(() => {
      const scroller = document.querySelector("[data-testid=pdf-scroller]");
      const scrollerRect = scroller.getBoundingClientRect();
      const band = 900;
      const ratio = window.devicePixelRatio || 1;
      let liveBuffers = 0;
      let liveOutsideBand = 0;
      let everRendered = 0;
      let liveBytes = 0;
      let counterfactualBytes = 0;
      let spansOutsideBand = 0;
      let spansOnCurrentPage = 0;
      let preRenderedBelowFold = 0;
      for (const wrapper of document.querySelectorAll(".pdf-page")) {
        const canvas = wrapper.querySelector("canvas");
        const rect = wrapper.getBoundingClientRect();
        const inBand =
          rect.bottom > scrollerRect.top - band && rect.top < scrollerRect.bottom + band;
        const cssWidth = Number.parseFloat(canvas?.style.width ?? "") || 0;
        const cssHeight = Number.parseFloat(canvas?.style.height ?? "") || 0;
        // canvas.style.width 由渲染流程写入且从不回退，因此它标记「这一页渲染过」。
        if (cssWidth > 0) {
          everRendered += 1;
          // 旧实现的占用：这些页面渲染过就一直留着缓冲。
          counterfactualBytes += cssWidth * ratio * cssHeight * ratio * 4;
        }
        if (canvas && canvas.width > 1) {
          liveBuffers += 1;
          liveBytes += canvas.width * canvas.height * 4;
          if (!inBand) liveOutsideBand += 1;
          // 完全在折叠线以下、但仍在 900px 预渲染余量内：这些页面应当已经渲染好，
          // 否则滚动时用户会看到白页——这正是「释放」必须配一个生效的余量带的原因。
          if (rect.top >= scrollerRect.bottom && rect.top - scrollerRect.bottom < band) {
            preRenderedBelowFold += 1;
          }
        }
        const spans = wrapper.querySelectorAll(".pdf-text-layer span").length;
        if (!inBand) spansOutsideBand += spans;
        if (inBand) spansOnCurrentPage += spans;
      }
      return {
        liveBuffers,
        liveOutsideBand,
        everRendered,
        liveMb: Number((liveBytes / 1048576).toFixed(2)),
        counterfactualMb: Number((counterfactualBytes / 1048576).toFixed(2)),
        spansOutsideBand,
        spansInBand: spansOnCurrentPage,
        preRenderedBelowFold,
        placements: document.querySelectorAll("[data-testid=placement]").length,
      };
    });

  async function browse(page, from, to) {
    const input = page.locator("[data-testid=page-input]");
    for (let number = from; number <= to; number += 1) {
      await input.fill(String(number));
      await input.press("Enter");
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(600);
  }

  await browse(longPage, 2, 13);
  const afterFirstSweep = await readMemory();
  await browse(longPage, 14, 25);
  const afterSecondSweep = await readMemory();

  check(
    "P2-3a 逐页浏览 24 页后，离屏页面不再保留画面缓冲",
    afterSecondSweep.liveOutsideBand === 0 && afterSecondSweep.liveBuffers <= 5,
    `浏览 24 页后：渲染过的页面 ${afterSecondSweep.everRendered} 个，仍持有缓冲 ${afterSecondSweep.liveBuffers} 个（其中离屏 ${afterSecondSweep.liveOutsideBand} 个）`,
  );
  check(
    "P2-3b 占用不随已浏览页数增长",
    afterSecondSweep.everRendered >= 20 &&
      afterSecondSweep.counterfactualMb > afterSecondSweep.liveMb * 3,
    `第 12 页处：已渲染 ${afterFirstSweep.everRendered} / 持有 ${afterFirstSweep.liveBuffers} 个 ${afterFirstSweep.liveMb}MB；第 24 页处：已渲染 ${afterSecondSweep.everRendered} / 持有 ${afterSecondSweep.liveBuffers} 个 ${afterSecondSweep.liveMb}MB。同样这批页面在旧实现下会一直占住约 ${afterSecondSweep.counterfactualMb}MB`,
  );
  check(
    "P2-3c 离屏页面的文本层一并释放",
    afterSecondSweep.spansOutsideBand === 0 && afterSecondSweep.spansInBand >= 40,
    `离屏文本节点 ${afterSecondSweep.spansOutsideBand} 个；当前页持有 ${afterSecondSweep.spansInBand} 个（说明文本层确实在渲染，不是靠「根本没生成」蒙混过关）`,
  );
  check(
    "P2-3d 预渲染余量生效：折叠线以下的相邻页已提前渲染（释放不会变成白页）",
    afterSecondSweep.preRenderedBelowFold >= 1,
    `折叠线以下、900px 余量内已渲染的页面 ${afterSecondSweep.preRenderedBelowFold} 个。若余量带不生效（root 用视口时它会被滚动容器的可视区裁掉），这个数会是 0，滚回去就只能看到白页`,
  );

  // 高缩放：页面宽于容器时逐页浏览，离屏占用同样应归零。
  const fitButtonLong = longPage.locator("[data-testid=fit-width]");
  const fitOnLong = await fitButtonLong.evaluate((element) =>
    element.classList.contains("button--toggled"),
  );
  if (fitOnLong) {
    await fitButtonLong.click();
  }
  for (let step = 0; step < 3; step += 1) {
    await longPage.locator('button[title="放大"]').click();
  }
  await longPage.waitForTimeout(1200);
  await browse(longPage, 26, 33);
  const afterZoomSweep = await readMemory();
  check(
    "P2-3e 高缩放（200%）下逐页浏览，离屏占用同样归零",
    afterZoomSweep.liveOutsideBand === 0 &&
      afterZoomSweep.counterfactualMb > afterZoomSweep.liveMb * 3,
    `缩放后浏览 8 页：渲染过 ${afterZoomSweep.everRendered} 个，持有缓冲 ${afterZoomSweep.liveBuffers} 个 ${afterZoomSweep.liveMb}MB，离屏 ${afterZoomSweep.liveOutsideBand} 个（旧实现下约 ${afterZoomSweep.counterfactualMb}MB）`,
  );

  // 回到第 1 页：签名与完整渲染都要恢复。
  await longPage.locator("[data-testid=page-input]").fill("1");
  await longPage.locator("[data-testid=page-input]").press("Enter");
  // 文本层在画布之后渲染，所以要同时等两者就绪，否则取样会早于文本层完成。
  await longPage.waitForFunction(
    () => {
      const wrapper = document.querySelector('.pdf-page[data-page-index="0"]');
      if (!wrapper) return false;
      const canvas = wrapper.querySelector("canvas");
      const cssWidth = Number.parseFloat(wrapper.style.width || "0") || 0;
      const ratio = window.devicePixelRatio || 1;
      const canvasReady =
        canvas && canvas.width > 1 && Math.abs(canvas.width - cssWidth * ratio) <= 2;
      const textReady = wrapper.querySelectorAll(".pdf-text-layer span").length > 0;
      return Boolean(canvasReady && textReady);
    },
    null,
    { timeout: 30000 },
  );
  const afterReturn = await readMemory();
  check(
    "P2-3f 回到已看过的页面：页面重新渲染且签名仍在",
    afterReturn.placements === 1 && afterReturn.liveBuffers >= 1 && afterReturn.spansInBand >= 40,
    `返回第 1 页后：签名实例 DOM ${afterReturn.placements} 个（离屏释放保留了 viewport 与实例数据），文本层 ${afterReturn.spansInBand} 个节点重建`,
  );
  await longPage.screenshot({ path: `${OUT}/P2-longdoc-return.png` });
  await longContext.close();
} finally {
  await browser.close();
}

console.log(`\n汇总：${passed} 项通过 / ${failed} 项失败`);
if (failed > 0) {
  process.exitCode = 1;
}
