/**
 * PDFInk A1—A16 浏览器验收脚本。
 * 使用 Playwright 驱动 Chromium 真实操作界面，使用 PDF.js / pdf-lib 读回导出结果并生成 PNG。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { chromium, launchOptions, APP, APP_HOST, FIX, OUT_ROOT } from "../support/browser.mjs";

import { probePdf, renderPdf } from "../support/pdf.ts";

const execFileAsync = promisify(execFile);

/** text-links.pdf 里那条链接注解的目标；A9-5 会用本地 stub 接管它的点击导航。 */
const LINK_URL = "https://example.com/pdfink-a9";

const OUT = OUT_ROOT;

/** A14-3/4：把观察器回调投递推迟这么多毫秒，模拟染步被拖后，让 P2-4 的竞态确定性复现。 */
const IO_DELAY_MS = 400;
/** A14-5/6：把 toBlob 回调延后这么多毫秒，制造一个确定可点的「保存中」窗口。 */
const TO_BLOB_DELAY_MS = 600;

/**
 * 执行完整连续验收；每次调用独立收集状态和产物。
 * onCheck 接收 { id, ok, detail }，由调用方将逐项结果接入测试框架。
 * 操作异常直接抛出，浏览器仍由 finally 关闭。
 */
export async function runAcceptance(onCheck) {
  await mkdir(OUT, { recursive: true });

  const results = [];
  const notes = [];
  /** 收集所有页面发出的请求 URL，供 A12 审计。 */
  const allRequestUrls = [];
  function check(id, ok, detail = "") {
    const result = { id, ok: Boolean(ok), detail };
    results.push(result);
    onCheck(result);
    console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${detail}`);
  }
  function note(message) {
    notes.push(message);
    console.log(`      · ${message}`);
  }

  /** 与 id 对应的验收项说明（用于报告）。 */
  const A = {
    A1: "创建两个签名，刷新后仍可辨认、可选用",
    A2: "空白画布不保存；存储失败不丢笔迹、不误报成功",
    A3: "同页两个实例 + 跨页放置，位置独立",
    A4: "删除模板后实例、撤销重做与导出仍可用",
    A5: "0/90/180/270 度、非零 CropBox、混合尺寸下输出无镜像",
    A6: "多缩放比例与 DPR 2 下编辑不漂移",
    A7: "一次手势一条撤销记录，新建实例清空重做分支",
    A8: "连续两次导出结果一致，源文件未变",
    A9: "输出保留可选文字与链接，签名不是整页截图",
    A10: "加载期间快速换文件、连续缩放只显示最新会话",
    A11: "100 页文档按需渲染，能跳页并放置签名",
    A12: "全流程无 PDF/签名外发，资源来自预期位置",
    A13: "放大后左边缘可达、贴边放置不越界、长文档离屏释放渲染资源",
    A14: "切换文档后缩略图不空白、保存签名不重复写入",
    A15: "加密文档（所有者密码 + 空用户口令）能打开但导出被拒绝，且不产生下载",
    A16: "确认弹窗点击正文后焦点不落到 body、Esc 仍可关闭、Tab 循环不越出弹窗",
  };

  // ---------- 通用辅助 ----------

  const GLYPHS = {
    // 归一化坐标，x 向右、y 向下
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
        [0.6, 0.3],
      ],
      [
        [0.425, 0.3],
        [0.425, 0.7],
      ],
    ],
    L: [
      [
        [0.25, 0.2],
        [0.25, 0.85],
      ],
      [
        [0.25, 0.85],
        [0.7, 0.85],
      ],
    ],
    Z: [
      [
        [0.2, 0.2],
        [0.7, 0.2],
        [0.2, 0.85],
        [0.7, 0.85],
      ],
    ],
  };

  function attachDiagnostics(page) {
    const diagnostics = {
      consoleErrors: [],
      pageErrors: [],
      requests: [],
      /** 原生 alert/confirm 记录：应用应当完全使用自绘弹窗，出现即为缺陷证据。 */
      nativeDialogs: [],
      /**
       * 整页重载次数。`vp dev` 对项目根目录下任何文件的写入都会触发整页重载
       * （含 docs/*.md 这类不在模块图里的文件），因此**验收运行期间不要改动项目目录**。
       * 计数用于把「被重载打断」变成一条可诊断的失败，而不是 30 秒点击超时。
       */
      reloads: 0,
    };
    page.on("console", (message) => {
      if (message.type() === "error") {
        diagnostics.consoleErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => diagnostics.pageErrors.push(String(error)));
    page.on("request", (request) => {
      diagnostics.requests.push({ url: request.url(), type: request.resourceType() });
      allRequestUrls.push(request.url());
    });
    page.on("load", () => {
      diagnostics.reloads += 1;
    });
    page.on("dialog", async (dialog) => {
      diagnostics.nativeDialogs.push({ type: dialog.type(), message: dialog.message() });
      await dialog.dismiss().catch(() => {});
    });
    return diagnostics;
  }

  /**
   * 与应用自绘的确认弹窗交互。
   * `action` 为要点击的按钮文案；返回 null 表示在超时时间内没有出现弹窗。
   */
  async function handleConfirmDialog(page, action, timeout = 1500, beforeClick) {
    const dialog = page.locator("[data-testid=confirm-dialog]");
    const appeared = await dialog
      .waitFor({ state: "visible", timeout })
      .then(() => true)
      .catch(() => false);
    if (!appeared) {
      return null;
    }
    await page.waitForTimeout(180);
    const captured = {
      title: (await dialog.locator("[data-testid=confirm-title]").innerText()).trim(),
      message: (await dialog.locator("[data-testid=confirm-message]").innerText()).trim(),
      details: await dialog.locator("[data-testid=confirm-details] li").allInnerTexts(),
      buttons: await dialog.locator("[data-testid=confirm-actions] .button").allInnerTexts(),
      /** 弹窗打开时的初始焦点文案，用于确认默认落在「取消」上。 */
      focusedLabel: await page.evaluate(() => document.activeElement?.textContent?.trim() ?? ""),
      /** 弹窗打开期间工具栏是否有加载态。 */
      toolbarLabel: (
        await page.locator("[data-testid=toolbar] .button--primary").first().innerText()
      ).trim(),
    };
    if (beforeClick) {
      await beforeClick(captured, dialog);
    }
    if (action === "Escape") {
      await page.keyboard.press("Escape");
    } else {
      await dialog.getByRole("button", { name: action, exact: true }).click();
    }
    await dialog.waitFor({ state: "hidden", timeout: 6000 }).catch(() => {});
    return captured;
  }

  async function openApp(page) {
    await page.goto(APP, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-testid=toolbar]");
  }

  async function openPdf(page, fileName, expectedPages) {
    await page
      .locator("[data-testid=toolbar] input[type=file]")
      .setInputFiles(`${FIX}/${fileName}`);
    // 当前文档还有未导出的签名时，应用会先弹「放弃当前编辑？」确认框。
    await handleConfirmDialog(page, "放弃并打开", 900);
    // 必须等到「新文档」接管：文件名、页数与首页渲染同时满足，避免旧会话被误判为加载完成。
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

  /**
   * 选中签名模板。
   * 再次点击同一个模板会切换掉放置模式，因此先确认该项是否已经是激活状态。
   */
  let armedTemplate = null;

  async function pickTemplate(page, index) {
    armedTemplate = index;
    const active = await page
      .locator("[data-testid=library-item]")
      .nth(index)
      .evaluate((element) => element.dataset.active === "true");
    if (!active) {
      await page.locator("[data-testid=library-item-pick]").nth(index).click();
    }
    await page.waitForTimeout(150);
  }

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

  async function createSignature(page, glyph, { draw = true } = {}) {
    await page
      .locator("[data-testid=signature-library]")
      .getByRole("button", { name: "新建签名" })
      .first()
      .click();
    await page.waitForSelector("[data-testid=signature-pad-canvas]");
    // 画布后备尺寸必须在入场动画进行中就已经正确：面板带 panel-in(scale 0.98)，
    // 若测量用了 getBoundingClientRect()，此刻量到的是缩小 2% 的盒子。
    // 因此这里在 waitForTimeout 之前立刻取样，并记录面板动画名作为证据。
    const canvasAtOpen = await page.evaluate(() => {
      const canvas = document.querySelector("[data-testid=signature-pad-canvas]");
      const panel = canvas.parentElement?.parentElement ?? null;
      return {
        backingWidth: canvas.width,
        backingHeight: canvas.height,
        expectedWidth: Math.round(canvas.offsetWidth * devicePixelRatio),
        expectedHeight: Math.round(canvas.offsetHeight * devicePixelRatio),
        frameWidth: Math.round(canvas.getBoundingClientRect().width * devicePixelRatio),
        panelAnimation: panel ? getComputedStyle(panel).animationName : "none",
        dpr: devicePixelRatio,
      };
    });
    // 弹窗有 0.18s 入场动画，等它结束再量画布包围盒，避免取到缩放中的尺寸。
    await page.waitForTimeout(250);
    if (draw) {
      await drawGlyph(page, glyph);
    }
    await page
      .locator("[data-testid=signature-pad-dialog]")
      .getByRole("button", { name: /保存到签名库|保存中/ })
      .click();
    return canvasAtOpen;
  }

  /**
   * 库内条目数。
   * 产品已移除签名名称输入，`library-item-name` 节点随之消失，条目身份只能靠
   * 「数量 + 预览笔迹图像」判断——不要再按名称断言。
   */
  async function libraryItemCount(page) {
    return await page.locator("[data-testid=library-item]").count();
  }

  /** 库内各条预览图的 src（blob:）；两条模板应是两个互相独立的对象 URL。 */
  async function libraryPreviewSources(page) {
    return await page
      .locator("[data-testid=library-item-preview]")
      .evaluateAll((images) => images.map((image) => image.getAttribute("src")));
  }

  /**
   * 等瞬时提示条收掉，再测屏幕几何。
   *
   * 应用把「签名已保存到本地签名库」「已导出 xxx」这类提示渲染成**参与布局**的横幅
   * （`data-testid=banner`，`px-4 py-2 text-meta`，约 36.5px 高，3.2s 后自动消失）。
   * 它一消失，下面的整个预览区连同页面就整体上移 36.5px。若拖动过程恰好跨过这个时刻，
   * 被测实例的屏幕位移会凭空多出 36.5px，看起来像「拖动漂移」——A6-1 曾因此稳定误报
   * （实测位移 (70,-76.5)，页面 Δy=-36.5，而变换本身完全正确）。
   * 因此凡是「断言屏幕几何」的用例，都要先等提示条收干净再取基准。
   */
  async function waitForBannersToClear(page, timeout = 6000) {
    await page
      .waitForFunction(() => document.querySelectorAll("[data-testid=banner]").length === 0, null, {
        timeout,
      })
      .catch(() => {});
  }

  /** 读取每个签名预览图的实际笔迹像素，判断是否可辨认。 */
  async function previewStats(page) {
    return await page.evaluate(async () => {
      const images = [...document.querySelectorAll("[data-testid=library-item-preview]")];
      const output = [];
      for (const image of images) {
        await image.decode().catch(() => {});
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let opaque = 0;
        for (let index = 3; index < data.length; index += 4) {
          if (data[index] > 0) opaque += 1;
        }
        output.push({
          width: image.naturalWidth,
          height: image.naturalHeight,
          opaque,
          total: canvas.width * canvas.height,
        });
      }
      return output;
    });
  }

  async function readIndexedDb(page) {
    const records = await page.evaluate(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("pdf-ink");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction("signatures", "readonly");
        const request = transaction.objectStore("signatures").getAll();
        request.onsuccess = () =>
          resolve(
            request.result.map((record) => ({
              id: record.id,
              name: record.name,
              pixelWidth: record.pixelWidth,
              pixelHeight: record.pixelHeight,
              createdAt: record.createdAt,
              bytes: record.blob?.size ?? 0,
            })),
          );
        request.onerror = () => reject(request.error);
      });
    });
    // 与应用 listSignatureTemplates 一致：按创建时间升序，避免 getAll 的键序随机性。
    return records.sort((left, right) => left.createdAt - right.createdAt);
  }

  async function gotoPage(page, humanPage) {
    const input = page.locator("[data-testid=page-input]");
    await input.fill(String(humanPage));
    await input.press("Enter");
    await page.waitForTimeout(500);
  }

  /** 页面在视口内的可见交集，避免点到视口外。 */
  async function visiblePoint(page, pageIndex, fx, fy) {
    const box = await page.locator(`.pdf-page[data-page-index="${pageIndex}"]`).boundingBox();
    if (!box) return null;
    const viewport = page.viewportSize();
    const top = Math.max(box.y, 90);
    const bottom = Math.min(box.y + box.height, viewport.height - 10);
    const left = Math.max(box.x, 10);
    const right = Math.min(box.x + box.width, viewport.width - 10);
    if (!(bottom > top + 20) || !(right > left + 20)) return null;
    return {
      x: left + (right - left) * fx,
      y: top + (bottom - top) * fy,
      visibleHeight: bottom - top,
    };
  }

  async function ensureVisible(page, pageIndex) {
    await page.locator(`.pdf-page[data-page-index="${pageIndex}"]`).scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
  }

  async function placeOnPage(page, pageIndex, fx = 0.5, fy = 0.55) {
    // 放置一次后放置模式会自动退出（产品行为），连续放置前需要重新选中模板。
    if (armedTemplate !== null) {
      await pickTemplate(page, armedTemplate);
    }
    await ensureVisible(page, pageIndex);
    const point = await visiblePoint(page, pageIndex, fx, fy);
    if (!point) return null;
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(200);
    return point;
  }

  /**
   * 统计真正完成渲染的页面数。
   * 未渲染的 canvas 保持浏览器默认 300x150，离开视野的页面会被重置为 1x1，
   * 因此只有「画布像素尺寸等于页面 CSS 尺寸 × DPR」的页面才算已渲染。
   */
  async function countRenderedPages(page) {
    return await page.evaluate(() => {
      const ratio = window.devicePixelRatio || 1;
      let count = 0;
      for (const wrapper of document.querySelectorAll(".pdf-page")) {
        const canvas = wrapper.querySelector("canvas");
        if (!canvas || !canvas.style.width) continue;
        const cssWidth = Number.parseFloat(wrapper.style.width) || 0;
        const expected = cssWidth * ratio;
        if (canvas.width > 1 && expected > 0 && Math.abs(canvas.width - expected) <= 2) {
          count += 1;
        }
      }
      return count;
    });
  }

  async function itemBoxes(page) {
    return await page.evaluate(() =>
      [...document.querySelectorAll("[data-testid=placement]")].map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          centerX: rect.x + rect.width / 2,
          centerY: rect.y + rect.height / 2,
          transform: style.transform,
          pageIndex: Number(element.closest(".pdf-page").dataset.pageIndex),
        };
      }),
    );
  }

  async function drag(page, from, to) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(200);
  }

  async function exportPdf(page, targetName) {
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: /下载签名后的 PDF|正在导出/ }).click(),
    ]);
    const target = `${OUT}/${targetName}`;
    await download.saveAs(target);
    return { target, suggested: download.suggestedFilename() };
  }

  async function sha256(path) {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  }

  const browser = await chromium.launch(launchOptions({ headless: true }));

  try {
    // ===================================================================
    // A1 / A2 / A3 / A4 —— 签名库与编辑
    // ===================================================================
    const context = await browser.newContext({ viewport: { width: 1600, height: 950 } });
    const page = await context.newPage();
    const diagnostics = attachDiagnostics(page);
    await openApp(page);
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase("pdf-ink");
        request.onsuccess = resolve;
        request.onerror = resolve;
        request.onblocked = resolve;
      });
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-testid=toolbar]");

    note(`Chromium(Playwright) ${browser.version()} / 视口 1600x950 / DPR 1`);

    await openPdf(page, "plain.pdf", 2);
    note(`plain.pdf 打开成功，页数 ${await page.locator(".pdf-page").count()}`);

    // ---- A1 ----
    const padAtOpen = await createSignature(page, "R");
    await page.waitForFunction(
      () => document.querySelectorAll("[data-testid=library-item]").length === 1,
    );
    await createSignature(page, "T");
    await page.waitForFunction(
      () => document.querySelectorAll("[data-testid=library-item]").length === 2,
    );

    const countBefore = await libraryItemCount(page);
    const previewsBefore = await libraryPreviewSources(page);
    const statsBefore = await previewStats(page);
    const dbBefore = await readIndexedDb(page);
    check(
      "A1-1 新建两个签名后库中有两项且互不相同",
      countBefore === 2 &&
        previewsBefore.length === 2 &&
        previewsBefore.every((src) => src?.startsWith("blob:")) &&
        new Set(previewsBefore).size === 2,
      `库内 ${countBefore} 项、预览图 ${previewsBefore.length} 张，src 去重后 ${new Set(previewsBefore).size} 个（应等于 2：两份笔迹各自一个 blob）`,
    );
    check(
      "A1-2 两份笔迹都非空且裁剪尺寸不同",
      statsBefore.length === 2 &&
        statsBefore.every((item) => item.opaque > 0) &&
        (statsBefore[0].width !== statsBefore[1].width ||
          statsBefore[0].height !== statsBefore[1].height),
      statsBefore
        .map((item) => `${item.width}x${item.height} 不透明像素=${item.opaque}`)
        .join(" | "),
    );
    check(
      "A1-3 IndexedDB 已落库且尺寸随裁剪变化",
      dbBefore.length === 2 && dbBefore.every((record) => record.bytes > 0),
      dbBefore
        .map(
          (record) => `${record.name} ${record.pixelWidth}x${record.pixelHeight} ${record.bytes}B`,
        )
        .join(" | "),
    );

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-testid=toolbar]");
    const countAfterReloadEmptyState = await libraryItemCount(page);
    await openPdf(page, "plain.pdf", 2);
    // 库由 loadLibrary 异步填充，openPdf 只保证文档接管，不保证库已就绪；等预览图到位再断言身份。
    await page
      .waitForFunction(
        () => document.querySelectorAll("[data-testid=library-item-preview]").length === 2,
        null,
        { timeout: 5000 },
      )
      .catch(() => {});
    const countAfter = await libraryItemCount(page);
    const previewsAfter = await libraryPreviewSources(page);
    const statsAfter = await previewStats(page);
    check(
      "A1-4 刷新后库内两项仍可辨认（未打开文档时不加载）",
      countAfterReloadEmptyState === 0 && countAfter === 2 && new Set(previewsAfter).size === 2,
      `未打开文档时 ${countAfterReloadEmptyState} 项、打开文档后 ${countAfter} 项，预览图 src 去重后 ${new Set(previewsAfter).size} 个（名称已随名称输入一并移除，身份改由笔迹预览区分）`,
    );
    check(
      "A1-5 刷新后笔迹图像仍可辨认",
      statsAfter.length === 2 &&
        statsAfter.every((item) => item.opaque > 0) &&
        statsAfter[0].opaque === statsBefore[0].opaque &&
        statsAfter[1].opaque === statsBefore[1].opaque,
      statsAfter
        .map((item) => `${item.width}x${item.height} 不透明像素=${item.opaque}`)
        .join(" | "),
    );
    // 画布尺寸回归（入场动画进行中取样）。若测量退回 getBoundingClientRect()，
    // 面板的 panel-in(scale 0.98) 会让 backing 比 offsetWidth×DPR 小约 2%，
    // 手写区最右/最下一小条落在画布之外。
    check(
      "A1-6 画布后备尺寸等于布局尺寸×DPR（入场动画进行中）",
      padAtOpen.backingWidth === padAtOpen.expectedWidth &&
        padAtOpen.backingHeight === padAtOpen.expectedHeight,
      `backing=${padAtOpen.backingWidth}x${padAtOpen.backingHeight}，预期=${padAtOpen.expectedWidth}x${padAtOpen.expectedHeight}，getBoundingClientRect 折算=${padAtOpen.frameWidth}，dpr=${padAtOpen.dpr}，面板动画=${padAtOpen.panelAnimation}`,
    );

    // ---- A2 ----
    // 整页重载会冲掉下面给 IDBObjectStore.prototype.put 打的补丁，
    // 因此记录基线，把「被重载打断」显式判定为失败。
    const reloadsBeforeA2 = diagnostics.reloads;
    await createSignature(page, "R", { draw: false });
    await page.waitForTimeout(600);
    const blankError = await page
      .locator("[data-testid=pad-error]")
      .innerText()
      .catch(() => "");
    const modalStillOpen = await page.locator("[data-testid=signature-pad-dialog]").isVisible();
    const countAfterBlank = (await readIndexedDb(page)).length;
    check(
      "A2-1 空白画布不保存并给出提示",
      blankError.includes("空白") && modalStillOpen && countAfterBlank === 2,
      `提示="${blankError.trim()}" 窗口仍开启=${modalStillOpen} 库内数量=${countAfterBlank}`,
    );

    // 画上笔迹后模拟存储失败
    await drawGlyph(page, "Z");
    await page.waitForFunction(() => {
      const button = [
        ...document.querySelectorAll("[data-testid=signature-pad-dialog] button"),
      ].find((item) => item.textContent.includes("清空重写"));
      return button && !button.disabled;
    });
    await page.evaluate(() => {
      // 拦截原型方法：把原实现挂到 window 上留待稍后还原。
      // 这里正是「故意引用未绑定方法」，规则看不穿「只是存起来、不在此处调用」，故就地关闭。
      // eslint-disable-next-line typescript/unbound-method
      window.__originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function blocked() {
        throw new DOMException("模拟写入失败", "UnknownError");
      };
    });
    await page
      .locator("[data-testid=signature-pad-dialog]")
      .getByRole("button", { name: /保存到签名库|保存中/ })
      .click();
    await page.waitForTimeout(800);
    const failureError = await page
      .locator("[data-testid=pad-error]")
      .innerText()
      .catch(() => "");
    const inkKept = await page.evaluate(() => {
      const button = [
        ...document.querySelectorAll("[data-testid=signature-pad-dialog] button"),
      ].find((item) => item.textContent.includes("清空重写"));
      return Boolean(button) && !button.disabled;
    });
    const countAfterFailure = (await readIndexedDb(page)).length;
    const successBannerVisible = await page
      .locator("[data-testid=banner][data-tone=success]", { hasText: "签名已保存" })
      .isVisible()
      .catch(() => false);
    check(
      "A2-2 存储失败时保留笔迹、不显示成功、库未变化",
      failureError.trim().length > 0 &&
        inkKept &&
        countAfterFailure === 2 &&
        !successBannerVisible &&
        diagnostics.reloads === reloadsBeforeA2,
      `提示="${failureError.trim()}" 笔迹保留=${inkKept} 库内数量=${countAfterFailure} 误报成功=${successBannerVisible}；用例期间整页重载 ${diagnostics.reloads - reloadsBeforeA2} 次（应为 0，非 0 说明调试期写入了项目目录，重载会冲掉 put 补丁）`,
    );

    await page.evaluate(() => {
      IDBObjectStore.prototype.put = window.__originalPut;
    });
    await page
      .locator("[data-testid=signature-pad-dialog]")
      .getByRole("button", { name: /保存到签名库|保存中/ })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll("[data-testid=library-item]").length === 3,
      null,
      {
        timeout: 10000,
      },
    );
    await page
      .locator("[data-testid=signature-pad-dialog]")
      .waitFor({ state: "hidden", timeout: 10000 });
    await page.waitForTimeout(300);
    note("A2-3 恢复存储后同一笔迹可正常保存并自动关闭弹窗（库内 3 项）");

    // 删除恢复用的第三个签名，保持 A3 只用两份
    await page
      .locator("[data-testid=library-item]")
      .nth(2)
      .getByRole("button", { name: "删除" })
      .click();
    await handleConfirmDialog(page, "删除", 8000);
    await page.waitForFunction(
      () => document.querySelectorAll("[data-testid=library-item]").length === 2,
    );

    // ---- A3 ----
    await pickTemplate(page, 0);
    const place1 = await placeOnPage(page, 0, 0.35, 0.4);
    const place2 = await placeOnPage(page, 0, 0.65, 0.6);
    await gotoPage(page, 2);
    const place3 = await placeOnPage(page, 1, 0.5, 0.5);
    const boxesA3 = await itemBoxes(page);
    await page.screenshot({ path: `${OUT}/A3-p1-two-instances.png` });
    await gotoPage(page, 2);
    await page.screenshot({ path: `${OUT}/A3-p2-one-instance.png` });
    const byPage = {
      0: boxesA3.filter((item) => item.pageIndex === 0).length,
      1: boxesA3.filter((item) => item.pageIndex === 1).length,
    };
    check(
      "A3-1 同页两个实例 + 第二页一个实例",
      boxesA3.length === 3 && byPage[0] === 2 && byPage[1] === 1,
      `放置点 ${JSON.stringify([place1, place2, place3])} 分布 ${JSON.stringify(byPage)}`,
    );

    await gotoPage(page, 1);
    // 屏幕几何类断言都要先等瞬时提示条收掉：它会整块推动预览区约 36.5px，
    // 跨在拖动过程中就会被误读成漂移（见 waitForBannersToClear）。
    await waitForBannersToClear(page);
    const before = await itemBoxes(page);
    await drag(
      page,
      { x: before[0].centerX, y: before[0].centerY },
      { x: before[0].centerX + 90, y: before[0].centerY - 60 },
    );
    const afterMove = await itemBoxes(page);
    const first0 = afterMove.find((item) => item.pageIndex === 0);
    const second0 = afterMove.find((item) => item.pageIndex === 0 && item !== first0);
    const movedDelta = {
      x: Math.hypot(
        first0.centerX - before[0].centerX - 90,
        first0.centerY - before[0].centerY + 60,
      ),
    };
    const otherUnchanged = second0
      ? Math.abs(second0.x - before[1].x) < 0.6 && Math.abs(second0.y - before[1].y) < 0.6
      : false;
    check(
      "A3-2 拖动第一个实例位置独立",
      movedDelta.x < 1.5 && otherUnchanged,
      `拖动偏差 ${movedDelta.x.toFixed(3)}px，另一实例未移动=${otherUnchanged}`,
    );

    // 缩放第一个实例
    await waitForBannersToClear(page);
    const beforeScale = await itemBoxes(page);
    const target = beforeScale.find(
      (item) => Math.abs(item.centerX - (before[0].centerX + 90)) < 40,
    );
    const handle = await page.locator("[data-testid=placement-handle]").first().boundingBox();
    if (handle && target) {
      await drag(
        page,
        { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 },
        { x: handle.x + 70, y: handle.y + 70 },
      );
    }
    const afterScale = await itemBoxes(page);
    const scaled = afterScale.find((item) => item.pageIndex === 0);
    const ratioOk =
      Math.abs(scaled.width / scaled.height - beforeScale[0].width / beforeScale[0].height) < 0.01;
    check(
      "A3-3 四角手柄等比缩放且长宽比不变",
      scaled.width !== beforeScale[0].width && ratioOk,
      `宽度 ${beforeScale[0].width.toFixed(1)} → ${scaled.width.toFixed(1)}，长宽比 ${(scaled.width / scaled.height).toFixed(4)}`,
    );

    // 删除第二页实例后再放回，验证删除可用
    await gotoPage(page, 2);
    const page2Box = (await itemBoxes(page)).find((item) => item.pageIndex === 1);
    await page.mouse.click(page2Box.centerX, page2Box.centerY);
    await page.waitForTimeout(200);
    await page.locator("[data-testid=placement-delete]").click();
    await page.waitForTimeout(300);
    const afterDelete = (await itemBoxes(page)).filter((item) => item.pageIndex === 1).length;
    check("A3-4 可删除单独实例", afterDelete === 0, `第二页剩余实例 ${afterDelete}`);

    // ---- A4 ----
    await gotoPage(page, 1);
    await page
      .locator("[data-testid=library-item]")
      .nth(1)
      .getByRole("button", { name: "删除" })
      .click();
    const removeTemplateDialog = await handleConfirmDialog(page, "删除", 8000);
    await page.waitForFunction(
      () => document.querySelectorAll("[data-testid=library-item]").length === 1,
    );
    const afterTemplateDelete = (await itemBoxes(page)).length;
    const exportA4 = await exportPdf(page, "A4-after-template-delete.pdf");
    const probeA4 = await probePdf(exportA4.target);
    const imagesA4 = probeA4.pages.reduce((sum, item) => sum + item.images.length, 0);
    check(
      "A4-1 删除模板先确认，确认后已放置实例与导出仍可用",
      afterTemplateDelete === 2 &&
        imagesA4 === 2 &&
        removeTemplateDialog !== null &&
        // 文案已随名称移除改为泛指的「删除这个签名？」，不再带模板名，
        // 因此这里只断「确实是在问删除」+ 按钮集合精确匹配（取消/删除），
        // 「先确认再删」的语义由「弹窗出现过 + 按钮为取消/删除」承载。
        removeTemplateDialog.title.includes("删除") &&
        removeTemplateDialog.buttons.join("/") === "取消/删除",
      `删除弹窗="${removeTemplateDialog?.title}" 按钮=${JSON.stringify(removeTemplateDialog?.buttons)}；页面实例 ${afterTemplateDelete}，导出图片对象 ${imagesA4}`,
    );

    const undoEnabled = await page.getByRole("button", { name: "撤销" }).isEnabled();
    await gotoPage(page, 2);
    const page2BeforeUndo = (await itemBoxes(page)).filter((item) => item.pageIndex === 1).length;
    await page.getByRole("button", { name: "撤销" }).click();
    await page.waitForTimeout(400);
    const page2AfterUndo = (await itemBoxes(page)).filter((item) => item.pageIndex === 1).length;
    await page.getByRole("button", { name: "重做" }).click();
    await page.waitForTimeout(400);
    const page2AfterRedo = (await itemBoxes(page)).filter((item) => item.pageIndex === 1).length;
    check(
      "A4-2 删除模板后撤销重做历史仍可用",
      undoEnabled && page2BeforeUndo === 0 && page2AfterUndo === 1 && page2AfterRedo === 0,
      `第 2 页实例数：撤销前 ${page2BeforeUndo} → 撤销后 ${page2AfterUndo} → 重做后 ${page2AfterRedo}`,
    );

    // 重新建一个模板供后续使用
    await createSignature(page, "L");
    await page.waitForFunction(
      () => document.querySelectorAll("[data-testid=library-item]").length === 2,
    );

    // ---- A7 ----
    await gotoPage(page, 1);
    // 上一行 createSignature 会弹出 3.2s 的瞬时提示条，必须等它收掉再取基准，
    // 否则拖动有可能正好跨在它消失的那一刻，页面整体上移会把位移测错。
    await waitForBannersToClear(page);
    const a7Before = (await itemBoxes(page))[0];
    const a7UndoBefore = await page.getByRole("button", { name: "撤销" }).isEnabled();
    await page.mouse.move(a7Before.centerX, a7Before.centerY);
    await page.mouse.down();
    await page.mouse.move(a7Before.centerX + 40, a7Before.centerY + 10, { steps: 5 });
    await page.mouse.move(a7Before.centerX + 80, a7Before.centerY + 20, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const a7Moved = (await itemBoxes(page))[0];
    await page.getByRole("button", { name: "撤销" }).click();
    await page.waitForTimeout(250);
    const a7Undone = (await itemBoxes(page))[0];
    await page.getByRole("button", { name: "重做" }).click();
    await page.waitForTimeout(250);
    const a7Redone = (await itemBoxes(page))[0];
    await page.getByRole("button", { name: "撤销" }).click();
    await page.waitForTimeout(250);
    const redoEnabledAfterUndo = await page.getByRole("button", { name: "重做" }).isEnabled();
    await pickTemplate(page, 0);
    await placeOnPage(page, 0, 0.3, 0.72);
    await page.waitForTimeout(250);
    const redoAfterNewPlacement = await page.getByRole("button", { name: "重做" }).isEnabled();
    check(
      "A7-1 一次拖动只产生一条撤销记录",
      a7UndoBefore &&
        Math.abs(a7Undone.centerX - a7Before.centerX) < 1.5 &&
        Math.abs(a7Undone.centerY - a7Before.centerY) < 1.5 &&
        Math.abs(a7Redone.centerX - a7Moved.centerX) < 1.5,
      `拖动后 Δx=${(a7Moved.centerX - a7Before.centerX).toFixed(1)}，一次撤销回到原点偏差 ${Math.hypot(a7Undone.centerX - a7Before.centerX, a7Undone.centerY - a7Before.centerY).toFixed(3)}px，重做回到拖动后偏差 ${Math.hypot(a7Redone.centerX - a7Moved.centerX, a7Redone.centerY - a7Moved.centerY).toFixed(3)}px`,
    );
    check(
      "A7-2 撤销后新建实例会清空重做分支",
      redoEnabledAfterUndo && !redoAfterNewPlacement,
      `撤销后可重做=${redoEnabledAfterUndo}，新建实例后可重做=${redoAfterNewPlacement}`,
    );

    // ---- A8 ----
    const sourceHashBefore = await sha256(`${FIX}/plain.pdf`);
    const export1 = await exportPdf(page, "A8-first.pdf");
    const export2 = await exportPdf(page, "A8-second.pdf");
    const sourceHashAfter = await sha256(`${FIX}/plain.pdf`);
    const bytesFirst = await readFile(export1.target);
    const bytesSecond = await readFile(export2.target);
    const probeFirst = await probePdf(export1.target);
    const probeSecond = await probePdf(export2.target);
    const countFirst = probeFirst.pages.reduce((sum, item) => sum + item.images.length, 0);
    const countSecond = probeSecond.pages.reduce((sum, item) => sum + item.images.length, 0);
    check(
      "A8-1 两次导出签名数量相同且字节一致",
      countFirst === countSecond && countFirst > 0 && Buffer.compare(bytesFirst, bytesSecond) === 0,
      `图片对象 ${countFirst} / ${countSecond}，字节 ${bytesFirst.byteLength} 与 ${bytesSecond.byteLength} 完全一致=${Buffer.compare(bytesFirst, bytesSecond) === 0}`,
    );
    check(
      "A8-2 源文件未被改写",
      sourceHashBefore === sourceHashAfter,
      `下载文件名 ${export1.suggested}、${export2.suggested}；源文件 sha256 前后一致=${sourceHashBefore === sourceHashAfter}`,
    );

    // ---- A9 ----
    await openPdf(page, "text-links.pdf", 1);

    // 链接可点性回归：文本层整体透明，但它内部的 <span> 带 z-index:1。若文本层本身
    // 不是层叠上下文（缺 z-index:0），这些 span 会跑到 DOM 中后出现的链接层之上，
    // 透明地吞掉指针事件 —— 链接区域点不动。先做多点命中测试，再用真实点击验证
    // 默认行为（导航由本地 stub 接管，不产生外发流量）。
    await page.waitForSelector("[data-testid=pdf-scroller] a[href]");
    const linkHit = await page.evaluate(async () => {
      const anchor = document.querySelector("[data-testid=pdf-scroller] a[href]");
      if (!anchor) {
        return { found: false };
      }
      anchor.scrollIntoView({ block: "center" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const rect = anchor.getBoundingClientRect();
      const textLayer = document.querySelector(".pdf-text-layer");
      const textLayerStyle = textLayer ? getComputedStyle(textLayer) : null;
      const samples = [
        [0.5, 0.5],
        [0.25, 0.5],
        [0.75, 0.5],
        [0.5, 0.25],
        [0.5, 0.75],
      ];
      return {
        found: true,
        href: anchor.getAttribute("href"),
        target: anchor.getAttribute("target"),
        box: { width: Math.round(rect.width), height: Math.round(rect.height) },
        textLayerPosition: textLayerStyle?.position ?? null,
        textLayerZIndex: textLayerStyle?.zIndex ?? null,
        hits: samples.map(([fx, fy]) => {
          const element = document.elementFromPoint(
            rect.left + rect.width * fx,
            rect.top + rect.height * fy,
          );
          return {
            point: `${fx},${fy}`,
            inAnchor: Boolean(element?.closest("a")),
            onTextLayer: Boolean(element?.closest(".pdf-text-layer")),
            tag: element?.tagName ?? null,
          };
        }),
      };
    });
    check(
      "A9-4 链接区域命中链接本身（文本层未吞掉指针事件）",
      linkHit.found &&
        linkHit.hits.every((hit) => hit.inAnchor) &&
        linkHit.hits.every((hit) => !hit.onTextLayer),
      `href=${linkHit.href} target=${linkHit.target} 尺寸=${linkHit.box?.width}x${linkHit.box?.height}；采样命中=${JSON.stringify(linkHit.hits)}；文本层 position=${linkHit.textLayerPosition} z-index=${linkHit.textLayerZIndex}`,
    );

    const stubbedLinkUrls = new Set();
    await context.route(LINK_URL, async (route) => {
      stubbedLinkUrls.add(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<html><body>link stub</body></html>",
      });
    });
    const popupPromise = context.waitForEvent("page", { timeout: 6000 }).catch(() => null);
    const linkClicked = await page
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
    check(
      "A9-5 点击链接区域会打开指向目标的标签页",
      linkClicked && popupUrl !== null && popupUrl.startsWith(LINK_URL),
      `点击成功=${linkClicked}；新标签页 URL=${popupUrl}；本地 stub 接管的请求=${JSON.stringify([...stubbedLinkUrls])}`,
    );

    await pickTemplate(page, 0);
    await placeOnPage(page, 0, 0.6, 0.35);
    const exportA9 = await exportPdf(page, "A9-text-links-signed.pdf");
    const probeA9 = await probePdf(exportA9.target);
    const textA9 = probeA9.pages[0].text;
    const linksA9 = probeA9.pages[0].annotations.filter((item) => item.subtype === "/Link");
    const imageA9 = probeA9.pages[0].images[0];
    const pageBox = probeA9.pages[0].boxes.cropbox;
    const pageArea = (pageBox[2] - pageBox[0]) * (pageBox[3] - pageBox[1]);
    const imageArea = imageA9
      ? Math.hypot(imageA9.ctm[0], imageA9.ctm[1]) * Math.hypot(imageA9.ctm[2], imageA9.ctm[3])
      : 0;
    check(
      "A9-1 输出仍可提取原文文字",
      textA9.includes("ALPHA-BRAVO-CHARLIE") && textA9.includes("searchable needle 0123456789"),
      `提取到 ${textA9.length} 个字符，包含关键行=${textA9.includes("ALPHA-BRAVO-CHARLIE")}`,
    );
    check(
      "A9-2 输出保留链接注解",
      linksA9.length === 1 && linksA9[0].uri === LINK_URL,
      JSON.stringify(linksA9),
    );
    check(
      "A9-3 签名不是整页截图（图片对象面积远小于页面）",
      imageA9 !== undefined && imageArea / pageArea < 0.2,
      `图片面积占比 ${(imageArea / pageArea).toFixed(4)}，图片像素 ${imageA9?.pixelWidth}x${imageA9?.pixelHeight}`,
    );
    const renderA9 = await renderPdf(exportA9.target, `${OUT}/pdfjs-a9`);
    note(`A9 PDF.js 渲染：${renderA9.split("\n")[0]}`);
    await page.screenshot({ path: `${OUT}/A9-app-preview.png` });

    // ---- A10 ----
    const errorsBeforeA10 = diagnostics.pageErrors.length;
    await page
      .locator("[data-testid=toolbar] input[type=file]")
      .setInputFiles(`${FIX}/book-100p.pdf`);
    await handleConfirmDialog(page, "放弃并打开", 900);
    await page.locator("[data-testid=toolbar] input[type=file]").setInputFiles(`${FIX}/plain.pdf`);
    await handleConfirmDialog(page, "放弃并打开", 900);
    for (let index = 0; index < 6; index += 1) {
      await page
        .locator(index % 2 === 0 ? 'button[title="放大"]' : 'button[title="缩小"]')
        .click({ timeout: 5000 })
        .catch(() => {});
      await page.waitForTimeout(60);
    }
    await page
      .locator("[data-testid=toolbar] input[type=file]")
      .setInputFiles(`${FIX}/rotations.pdf`);
    await handleConfirmDialog(page, "放弃并打开", 900);
    await page.waitForFunction(
      () => {
        const name = document.querySelector("[data-testid=file-name]")?.textContent ?? "";
        const total = document.querySelector("[data-testid=page-indicator]")?.textContent ?? "";
        return name.includes("rotations.pdf") && total.includes("5");
      },
      null,
      { timeout: 20000 },
    );
    await page.waitForTimeout(800);
    const finalName = await page.locator("[data-testid=file-name]").innerText();
    const finalPages = await page.locator(".pdf-page").count();
    const pagesStillRendering = await page.evaluate(
      () =>
        [...document.querySelectorAll(".pdf-page canvas")].filter((canvas) => canvas.width > 0)
          .length,
    );
    check(
      "A10-1 快速换文件后只显示最新会话",
      finalName.includes("rotations.pdf") && finalPages === 5 && pagesStillRendering >= 1,
      `文件名=${finalName.trim()} 页数=${finalPages} 已渲染=${pagesStillRendering} 新增页面错误=${diagnostics.pageErrors.length - errorsBeforeA10}`,
    );
    check(
      "A10-2 全过程无未捕获异常",
      diagnostics.pageErrors.length - errorsBeforeA10 === 0,
      diagnostics.pageErrors.slice(errorsBeforeA10).join(" | ") || "无",
    );

    // ---- A5 ----
    const scaleCheck = await page.locator("[data-testid=zoom-level]").innerText();
    await pickTemplate(page, 0);
    for (let index = 0; index < 5; index += 1) {
      await gotoPage(page, index + 1);
      await placeOnPage(page, index, 0.5, 0.55);
      await page.screenshot({ path: `${OUT}/A5-preview-p${index + 1}.png` });
    }
    const exportA5 = await exportPdf(page, "A5-rotations-signed.pdf");
    const probeA5 = await probePdf(exportA5.target);
    const a5Rows = probeA5.pages.map((item) => ({
      page: item.index + 1,
      rotate: item.rotate,
      cropbox: item.boxes.cropbox,
      images: item.images.length,
      determinant: item.images[0]?.determinant ?? null,
      span: item.images[0] ? [item.images[0].minCorner, item.images[0].maxCorner] : null,
    }));
    const allSingleImage = a5Rows.every((row) => row.images === 1);
    const allPositive = a5Rows.every((row) => row.determinant !== null && row.determinant > 0);
    check(
      "A5-1 五种页面（含旋转与 CropBox）各写入一个图片对象",
      allSingleImage,
      JSON.stringify(a5Rows.map((row) => `p${row.page} rot=${row.rotate} 图片=${row.images}`)),
    );
    check(
      "A5-2 全部变换行列式为正（无镜像 / 无斜切）",
      allPositive,
      JSON.stringify(a5Rows.map((row) => `p${row.page} det=${row.determinant}`)),
    );
    const rotatedPages = a5Rows.filter((row) => row.rotate !== 0);
    check(
      "A5-3 每页图片四角都落在该页 CropBox 内",
      probeA5.pages.every((item) => {
        const image = item.images[0];
        if (!image) return false;
        const box = item.boxes.cropbox;
        return (
          image.minCorner[0] >= box[0] - 1 &&
          image.minCorner[1] >= box[1] - 1 &&
          image.maxCorner[0] <= box[2] + 1 &&
          image.maxCorner[1] <= box[3] + 1
        );
      }),
      JSON.stringify(
        probeA5.pages.map((item) => {
          const box = item.boxes.cropbox;
          const image = item.images[0];
          return `p${item.index + 1} rot=${item.rotate} cropbox=[${box.join(",")}] 图片角点=[${image?.minCorner.join(",")}]~[${image?.maxCorner.join(",")}]`;
        }),
      ),
    );
    note(`A5 旋转页数 ${rotatedPages.length}，预览缩放比例 ${scaleCheck.trim()}`);
    await renderPdf(exportA5.target, `${OUT}/pdfjs-a5`);
    note(`A5 PDF.js 已渲染 5 页 → ${OUT}/pdfjs-a5`);

    // ---- A11 ----
    await page
      .locator("[data-testid=toolbar] input[type=file]")
      .setInputFiles(`${FIX}/book-100p.pdf`);
    // A5 遗留的实例会先触发「放弃当前编辑？」确认框；计时从确认之后开始，只反映纯加载耗时。
    await handleConfirmDialog(page, "放弃并打开", 2000);
    const loadStart = Date.now();
    await page.waitForFunction(
      () => {
        const shown = document.querySelector("[data-testid=file-name]")?.textContent ?? "";
        if (!shown.includes("book-100p.pdf")) return false;
        if (document.querySelectorAll(".pdf-page").length !== 100) return false;
        const wrapper = document.querySelector('.pdf-page[data-page-index="0"]');
        const canvas = wrapper?.querySelector("canvas");
        if (!canvas || !canvas.style.width) return false;
        const cssWidth = Number.parseFloat(wrapper.style.width) || 0;
        const ratio = window.devicePixelRatio || 1;
        return canvas.width > 1 && cssWidth > 0 && Math.abs(canvas.width - cssWidth * ratio) <= 2;
      },
      null,
      { timeout: 60000 },
    );
    const firstPageMs = Date.now() - loadStart;
    await page.waitForTimeout(900);
    const renderedWhileIdle = await countRenderedPages(page);
    const jumpStart = Date.now();
    const pageInput = page.locator("[data-testid=page-input]");
    await pageInput.fill("100");
    await pageInput.press("Enter");
    await page.waitForFunction(
      () => {
        const wrapper = document.querySelector('.pdf-page[data-page-index="99"]');
        const canvas = wrapper?.querySelector("canvas");
        if (!canvas || !canvas.style.width) return false;
        const cssWidth = Number.parseFloat(wrapper.style.width) || 0;
        const ratio = window.devicePixelRatio || 1;
        return canvas.width > 1 && cssWidth > 0 && Math.abs(canvas.width - cssWidth * ratio) <= 2;
      },
      null,
      { timeout: 60000 },
    );
    const jumpMs = Date.now() - jumpStart;
    await page.waitForTimeout(900);
    const renderedAfterJump = await countRenderedPages(page);
    await pickTemplate(page, 0);
    const placedOnLast = await placeOnPage(page, 99, 0.5, 0.5);
    const exportA11 = await exportPdf(page, "A11-book100-signed.pdf");
    const probeA11 = await probePdf(exportA11.target);
    const lastPageImages = probeA11.pages[99].images.length;
    check(
      "A11-1 100 页文档没有一次性渲染全部页面",
      renderedWhileIdle <= 12 && renderedAfterJump <= 12 && probeA11.pageCount === 100,
      `首页渲染后已渲染画布 ${renderedWhileIdle} 个，跳到第 100 页后 ${renderedAfterJump} 个，文档共 ${probeA11.pageCount} 页`,
    );
    check(
      "A11-2 能到达第 100 页并放置签名",
      placedOnLast !== null && lastPageImages === 1,
      `耗时：首屏 ${firstPageMs}ms，跳转到第 100 页 ${jumpMs}ms；第 100 页图片对象 ${lastPageImages}`,
    );
    note(
      `A11 样本 book-100p.pdf 57394 bytes，设备 macOS / Apple Silicon / Chromium ${browser.version()}`,
    );
    await page.screenshot({ path: `${OUT}/A11-page100.png` });

    // ===================================================================
    // A6 —— DPR 2 与多缩放比例
    // ===================================================================
    const hidpi = await browser.newContext({
      viewport: { width: 1280, height: 820 },
      deviceScaleFactor: 2,
    });
    const hidpiPage = await hidpi.newPage();
    attachDiagnostics(hidpiPage);
    await openApp(hidpiPage);
    await openPdf(hidpiPage, "plain.pdf", 2);
    await createSignature(hidpiPage, "R");
    await hidpiPage.waitForFunction(
      () => document.querySelectorAll("[data-testid=library-item]").length === 1,
    );
    await createSignature(hidpiPage, "T");
    await hidpiPage.waitForFunction(
      () => document.querySelectorAll("[data-testid=library-item]").length === 2,
    );
    const dpr = await hidpiPage.evaluate(() => window.devicePixelRatio);
    const assetInfo = await readIndexedDb(hidpiPage);
    const assetRatio = assetInfo[0].pixelWidth / assetInfo[0].pixelHeight;

    await pickTemplate(hidpiPage, 0);
    await placeOnPage(hidpiPage, 0, 0.5, 0.5);
    const zoomScenarios = [
      { label: "自适应宽度", steps: 0, zoomIn: false },
      { label: "缩小到 50%", steps: 5, zoomIn: false },
      { label: "放大到 250%", steps: 8, zoomIn: true },
    ];

    const drift = [];
    const ratios = [];
    for (const scenario of zoomScenarios) {
      // 每档都先回到「自适应宽度」再调整倍率，避免累计误差掩盖真实行为。
      // 定位走 data-testid：按钮文案改过一次（适合宽度 → 自适应宽度），绑文字会跟着一起烂。
      const fitToggled = await hidpiPage
        .locator("[data-testid=fit-width]")
        .evaluate((element) => element.classList.contains("button--toggled"));
      if (!fitToggled) {
        await hidpiPage.locator("[data-testid=fit-width]").click();
        await hidpiPage.waitForTimeout(500);
      }
      for (let step = 0; step < scenario.steps; step += 1) {
        await hidpiPage
          .locator(scenario.zoomIn ? 'button[title="放大"]' : 'button[title="缩小"]')
          .click();
      }
      await hidpiPage.waitForTimeout(700);

      // 每档重新放一个实例，确保被测对象完整落在视口内。
      await pickTemplate(hidpiPage, 0);
      const placed = await placeOnPage(hidpiPage, 0, 0.5, 0.5);
      // 取基准之前必须先让瞬时提示条收掉：它是参与布局的横幅，消失时整个预览区会上移
      // 约 36.5px，若跨在拖动过程中就会被误读成「拖动漂移」（见 waitForBannersToClear）。
      await waitForBannersToClear(hidpiPage);
      await hidpiPage.waitForTimeout(300);
      const scaleText = (await hidpiPage.locator("[data-testid=zoom-level]").innerText()).trim();
      const items = await itemBoxes(hidpiPage);
      const before = items.at(-1);
      const hit = await hidpiPage.evaluate(
        (point) => {
          const element = document.elementFromPoint(point.x, point.y);
          if (!element) return "none";
          // 用最近的 data-testid 钩子标识命中元素，避免打印整串 Tailwind 工具类。
          const hook = element.closest("[data-testid]");
          return hook ? `${element.tagName}[${hook.dataset.testid}]` : element.tagName;
        },
        { x: before.centerX, y: before.centerY },
      );
      const viewport = hidpiPage.viewportSize();
      const insideViewport =
        before.x > 0 &&
        before.y > 0 &&
        before.x + before.width < viewport.width &&
        before.y + before.height < viewport.height;
      const scrollBefore = await hidpiPage.evaluate(
        () => document.querySelector("[data-testid=pdf-scroller]")?.scrollTop ?? 0,
      );
      // 放置模式此刻是否仍武装。第一档「自适应宽度」下，循环里的放置点击会落在刚放好的
      // 实例上，产品既不会放置也不会退出放置模式，于是这次拖动是在武装状态下进行的——
      // 这一项就是把该情形与「拖动位移被 clamp 吃掉」区分开的证据。
      const armedBeforeDrag = await hidpiPage
        .locator("[data-testid=library-item]")
        .nth(0)
        .evaluate((element) => element.dataset.active);
      // Y 方向多走了 36.5px，而 X 完全正确——只作用在纵向的偏差通常来自「某元素在拖动
      // 过程中改了高度，把页面整体推走」，而不是变换本身算错。记下页面矩形可以直接证实。
      const pageRectBefore = await hidpiPage
        .locator('.pdf-page[data-page-index="0"]')
        .boundingBox();
      const dx = 70;
      const dy = -40;
      await drag(
        hidpiPage,
        { x: before.centerX, y: before.centerY },
        { x: before.centerX + dx, y: before.centerY + dy },
      );
      const scrollAfter = await hidpiPage.evaluate(
        () => document.querySelector("[data-testid=pdf-scroller]")?.scrollTop ?? 0,
      );
      const itemsAfter = await itemBoxes(hidpiPage);
      const after = itemsAfter.at(-1);
      const pageRectAfter = await hidpiPage.locator('.pdf-page[data-page-index="0"]').boundingBox();
      drift.push({
        label: scenario.label,
        scale: scaleText,
        error: Math.hypot(after.centerX - before.centerX - dx, after.centerY - before.centerY - dy),
        hit,
        insideViewport,
        scrollDelta: scrollAfter - scrollBefore,
        placed: placed !== null,
        // 「只有某一档漂」有两种解释：拖动确实被 clamp 吃掉了一段位移，或者被测对象换了人。
        // 记录实例数与拖动前 at(-1) 的下标，配合下面的「拖动前后位移」把两者分开。
        countBefore: items.length,
        countAfter: itemsAfter.length,
        targetIndex: items.length - 1,
        afterIndex: itemsAfter.length - 1,
        movedX: after.centerX - before.centerX,
        movedY: after.centerY - before.centerY,
        armedBeforeDrag,
        pageDeltaY: pageRectAfter.y - pageRectBefore.y,
        pageDeltaX: pageRectAfter.x - pageRectBefore.x,
      });
      ratios.push({
        label: scenario.label,
        scale: scaleText,
        ratio: after.width / after.height,
        assetRatio,
        widthPx: after.width,
      });
    }
    const maxDrift = Math.max(...drift.map((item) => item.error));
    check(
      "A6-1 DPR 2 下多缩放比例拖动无漂移",
      maxDrift < 2 && drift.every((item) => item.pageDeltaX === 0 && item.pageDeltaY === 0),
      `devicePixelRatio=${dpr}；各档偏差 ${drift.map((item) => `${item.scale}:${item.error.toFixed(2)}px`).join(", ")}；命中元素 ${drift.map((item) => item.hit).join(" / ")}；滚动位移 ${drift.map((item) => item.scrollDelta).join(", ")}；实例完整在视口内 ${drift.map((item) => item.insideViewport).join(", ")}；实例数 ${drift.map((item) => `${item.countBefore}→${item.countAfter}`).join(", ")}；拖动前放置模式武装 ${drift.map((item) => item.armedBeforeDrag).join("/")}；实测位移 ${drift.map((item) => `(${item.movedX.toFixed(1)},${item.movedY.toFixed(1)})`).join(" ")}；页面 Δ(${drift.map((item) => `${item.pageDeltaX.toFixed(1)},${item.pageDeltaY.toFixed(1)}`).join(" ")})（页面在拖动过程中发生位移即说明有参与布局的横幅收放，此时屏幕位移不再等同于实例位移）`,
    );
    const ratioErrors = ratios.map((item) => Math.abs(item.ratio - item.assetRatio));
    check(
      "A6-2 各档缩放长宽比与原始笔迹一致",
      Math.max(...ratioErrors) < 0.02,
      ratios
        .map(
          (item) =>
            `${item.scale} 显示 ${item.widthPx.toFixed(0)}px 比例 ${item.ratio.toFixed(4)} / 原始 ${item.assetRatio.toFixed(4)}`,
        )
        .join(" | "),
    );
    await hidpiPage.screenshot({ path: `${OUT}/A6-dpr2.png` });

    // 切换态回归：`.button--ghost:enabled:hover`(0,3,0) 特异性高于 `.button--toggled`(0,1,0)，
    // 少了同层的 toggled hover 规则，激活按钮一悬停就会掉回普通 ghost 配色。
    // 同时用「缩小」这个真 ghost 按钮做对照，确认 ghost 自己的 hover 仍然生效。
    // 放在截图之后，避免截图里鼠标停在按钮上。
    const fitButton = hidpiPage.locator("[data-testid=fit-width]");
    const plainGhost = hidpiPage.locator('[data-testid=toolbar] button[title="缩小"]');
    const fitToggledBefore = await fitButton.evaluate((element) =>
      element.classList.contains("button--toggled"),
    );
    if (!fitToggledBefore) {
      await fitButton.click();
      await hidpiPage.waitForTimeout(600);
    }
    const readButtonStyle = (locator) =>
      locator.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          border: style.borderTopColor,
          bg: style.backgroundColor,
          toggled: element.classList.contains("button--toggled"),
        };
      });
    const fitResting = await readButtonStyle(fitButton);
    await fitButton.hover();
    await hidpiPage.waitForTimeout(220);
    const fitHovered = await readButtonStyle(fitButton);
    const ghostResting = await readButtonStyle(plainGhost);
    await plainGhost.hover();
    await hidpiPage.waitForTimeout(220);
    const ghostHovered = await readButtonStyle(plainGhost);
    check(
      "A6-3 切换态按钮 hover 保持激活配色，普通 ghost 的 hover 仍生效",
      fitHovered.toggled &&
        fitResting.border !== ghostResting.border &&
        fitHovered.border === fitResting.border &&
        fitHovered.bg === fitResting.bg &&
        ghostHovered.border !== ghostResting.border &&
        ghostHovered.bg !== ghostResting.bg,
      `切换态 静止=${fitResting.border}/${fitResting.bg} hover=${fitHovered.border}/${fitHovered.bg}；对照 ghost（缩小）静止=${ghostResting.border}/${ghostResting.bg} hover=${ghostHovered.border}/${ghostHovered.bg}`,
    );
    await hidpi.close();

    // ===================================================================
    // A12 —— 网络
    // ===================================================================
    const requestHosts = new Set();
    for (const request of diagnostics.requests) {
      try {
        const url = new URL(request.url);
        requestHosts.add(`${url.protocol}//${url.host}`);
      } catch {
        requestHosts.add(request.url.slice(0, 24));
      }
    }
    const externalHosts = [...requestHosts].filter(
      (host) => !host.includes(APP_HOST) && !host.startsWith("blob:") && !host.startsWith("data:"),
    );
    const pdfRequests = diagnostics.requests.filter((request) => /\.pdf($|\?)/i.test(request.url));
    // A9-5 的链接点击测试由本地 stub 接管（fulfill 一个静态 HTML），
    // 它刻意模拟「点链接会外跳」，因此按 URL 精确排除，不算外发流量。
    const externalRequests = diagnostics.requests.filter((request) => {
      if (stubbedLinkUrls.has(request.url)) {
        return false;
      }
      try {
        const origin = new URL(request.url).origin;
        return (
          !origin.includes(APP_HOST) && !origin.startsWith("blob:") && !origin.startsWith("data:")
        );
      } catch {
        return true;
      }
    });
    check(
      "A12-1 全流程未向远端发送 PDF 或签名",
      externalRequests.length === 0 && pdfRequests.length === 0,
      `外发请求 ${externalRequests.length} 个 ${JSON.stringify(externalRequests.map((item) => item.url))}；出现过的来源 ${JSON.stringify([...requestHosts])}；外部来源 ${JSON.stringify(externalHosts)}（其中 A9-5 链接 stub 已按 URL 排除 ${stubbedLinkUrls.size} 个）；PDF 上传请求 ${pdfRequests.length} 个`,
    );
    const cmapRequests = diagnostics.requests.filter((request) => request.url.includes("/pdfjs/"));
    const workerRequests = diagnostics.requests.filter((request) =>
      /worker.*\.mjs/i.test(request.url),
    );
    const cdnPattern = /(jsdelivr|unpkg|cdnjs|cdn\.|googleapis|mozilla\.org)/i;
    const cdnRequests = diagnostics.requests.filter((request) => cdnPattern.test(request.url));
    const localProbe = await page.evaluate(async (base) => {
      const response = await fetch(`${base}pdfjs/cmaps/Adobe-Japan1-0.bcmap`);
      const bytes = await response.arrayBuffer();
      return { status: response.status, bytes: bytes.byteLength };
    }, APP);
    const workerAllLocal = workerRequests.every((request) => request.url.includes(APP_HOST));
    check(
      "A12-2 worker 与 PDF.js 资源均由应用自身来源提供",
      workerRequests.length > 0 &&
        workerAllLocal &&
        cdnRequests.length === 0 &&
        localProbe.status === 200 &&
        localProbe.bytes > 0,
      `worker 请求 ${workerRequests.length} 个（全部本地=${workerAllLocal}）；CDN 请求 ${cdnRequests.length} 个；本地 CMap 自行探针 HTTP ${localProbe.status} ${localProbe.bytes}B；流程中命中 /pdfjs/ 的请求 ${cmapRequests.length} 个`,
    );
    note(
      `A12 共记录 ${diagnostics.requests.length} 个请求，控制台错误 ${diagnostics.consoleErrors.length} 条`,
    );

    // ===================================================================
    // 附加：范围门槛
    // ===================================================================
    await openPdf(page, "sig-field-empty.pdf", 1);
    const emptyFieldNotice = await page
      .locator("[data-testid=banner][data-tone=notice]")
      .innerText()
      .catch(() => "");
    const emptyFieldOpened = (await page.locator(".pdf-page").count()) === 1;
    check(
      "B1 含未填写数字签名字段时允许打开并提示",
      emptyFieldOpened && emptyFieldNotice.includes("数字签名"),
      `已打开=${emptyFieldOpened} 提示="${emptyFieldNotice.split("\n")[0]}"`,
    );

    // ---- B2 已签名文档：Esc 与「取消」两条路径都不打开、保留原会话且不报错 ----
    await openPdf(page, "plain.pdf", 2);
    const fileNameBeforeDecline = (
      await page.locator("[data-testid=file-name]").innerText()
    ).trim();

    await page
      .locator("[data-testid=toolbar] input[type=file]")
      .setInputFiles(`${FIX}/sig-field-signed.pdf`);
    await handleConfirmDialog(page, "Escape", 10000);
    await page.waitForTimeout(500);
    const afterEsc = {
      file: (await page.locator("[data-testid=file-name]").innerText()).trim(),
      pages: await page.locator(".pdf-page").count(),
      errors: await page.locator("[data-testid=banner][data-tone=error]").count(),
    };

    await page
      .locator("[data-testid=toolbar] input[type=file]")
      .setInputFiles(`${FIX}/sig-field-signed.pdf`);
    const declined = await handleConfirmDialog(page, "取消", 10000, async () => {
      await page.screenshot({ path: `${OUT}/B2-dialog-signed-pdf.png` });
    });
    await page.waitForTimeout(500);
    const afterDecline = {
      file: (await page.locator("[data-testid=file-name]").innerText()).trim(),
      pages: await page.locator(".pdf-page").count(),
      errors: await page.locator("[data-testid=banner][data-tone=error]").count(),
    };

    check(
      "B2 已签名文档先弹确认框；Esc 与「取消」都保留原会话且不报错",
      declined !== null &&
        declined.title.includes("数字签名") &&
        declined.message.includes("失效") &&
        declined.focusedLabel === "取消" &&
        declined.toolbarLabel === "打开 PDF" &&
        declined.buttons.join("/") === "取消/仍然编辑" &&
        afterEsc.file === fileNameBeforeDecline &&
        afterEsc.pages === 2 &&
        afterEsc.errors === 0 &&
        afterDecline.file === fileNameBeforeDecline &&
        afterDecline.pages === 2 &&
        afterDecline.errors === 0,
      `标题="${declined?.title}"；按钮=${JSON.stringify(declined?.buttons)}；默认焦点=${declined?.focusedLabel}；弹窗期间工具栏="${declined?.toolbarLabel}"；Esc 后会话=${afterEsc.file}；取消后会话=${afterDecline.file}（保持原会话=${afterDecline.file === fileNameBeforeDecline}）；错误横幅=${afterDecline.errors}；页数=${afterDecline.pages}`,
    );

    // ---- B2b 确认：允许编辑，并保留签名失效提示 ----
    await page
      .locator("[data-testid=toolbar] input[type=file]")
      .setInputFiles(`${FIX}/sig-field-signed.pdf`);
    const accepted = await handleConfirmDialog(page, "仍然编辑", 10000);
    await page.waitForFunction(() => document.querySelectorAll(".pdf-page").length === 1, null, {
      timeout: 25000,
    });
    const signedNotice = await page
      .locator("[data-testid=banner][data-tone=notice]")
      .innerText()
      .catch(() => "");
    const fileNameAfterSigned = (await page.locator("[data-testid=file-name]").innerText()).trim();
    check(
      "B2b 确认后允许编辑该文档并保留失效提示",
      accepted !== null &&
        accepted.details.length > 0 &&
        fileNameAfterSigned.includes("sig-field-signed") &&
        signedNotice.includes("数字签名") &&
        signedNotice.includes("失效"),
      `弹窗按钮=${JSON.stringify(accepted?.buttons)}；补充说明=${JSON.stringify(accepted?.details)}；已打开=${fileNameAfterSigned}；提示="${signedNotice.split("\n")[0]}"`,
    );

    await page.locator("[data-testid=toolbar] input[type=file]").setInputFiles(`${FIX}/broken.pdf`);
    await page.waitForFunction(
      () =>
        (document.querySelector("[data-testid=banner][data-tone=error]")?.textContent ?? "")
          .length > 0,
      null,
      { timeout: 20000 },
    );
    const brokenError = await page.locator("[data-testid=banner][data-tone=error]").innerText();
    const fileNameAfterBroken = (await page.locator("[data-testid=file-name]").innerText()).trim();
    check(
      "B3 损坏文件显示加载失败且不破坏已有会话",
      brokenError.trim().length > 0 && fileNameAfterBroken === fileNameAfterSigned,
      `提示="${brokenError.split("\n")[0]}"，会话仍为 ${fileNameAfterBroken}`,
    );

    await openPdf(page, "plain.pdf", 2);
    note("B4 损坏文件之后重新打开正常 PDF 成功");

    // ---- B5 「放弃当前编辑？」确认框：取消保留编辑，确认才切换会话 ----
    await pickTemplate(page, 0);
    await placeOnPage(page, 0, 0.5, 0.5);
    await page.waitForFunction(
      () => document.querySelectorAll("[data-testid=placement]").length === 1,
      null,
      {
        timeout: 15000,
      },
    );
    const fileBeforeDiscard = (await page.locator("[data-testid=file-name]").innerText()).trim();

    await page
      .locator("[data-testid=toolbar] input[type=file]")
      .setInputFiles(`${FIX}/text-links.pdf`);
    const discardCancelled = await handleConfirmDialog(page, "取消", 10000, async () => {
      await page.screenshot({ path: `${OUT}/B5-dialog-discard-edits.png` });
    });
    await page.waitForTimeout(500);
    const afterDiscardCancel = {
      file: (await page.locator("[data-testid=file-name]").innerText()).trim(),
      items: (await itemBoxes(page)).length,
    };

    await page
      .locator("[data-testid=toolbar] input[type=file]")
      .setInputFiles(`${FIX}/text-links.pdf`);
    const discardAccepted = await handleConfirmDialog(page, "放弃并打开", 10000);
    await page.waitForFunction(() => document.querySelectorAll(".pdf-page").length === 1, null, {
      timeout: 25000,
    });
    await page.waitForTimeout(400);
    const afterDiscardAccept = {
      file: (await page.locator("[data-testid=file-name]").innerText()).trim(),
      items: (await itemBoxes(page)).length,
    };

    check(
      "B5 有未导出编辑时换文件先确认；取消保留编辑，确认才切换会话",
      discardCancelled !== null &&
        discardCancelled.title.includes("放弃当前编辑") &&
        discardCancelled.focusedLabel === "取消" &&
        // 产品刻意不再按数量描述（导出后删光实例也会与基准不同，按数量会说错），
        // 改为只陈述「存在未导出的修改」；因此这里断存在性语义，而不绑具体条数。
        discardCancelled.details.join().includes("尚未导出") &&
        afterDiscardCancel.file === fileBeforeDiscard &&
        afterDiscardCancel.items === 1 &&
        discardAccepted !== null &&
        afterDiscardAccept.file.includes("text-links.pdf") &&
        afterDiscardAccept.items === 0,
      `弹窗标题="${discardCancelled?.title}"；补充说明=${JSON.stringify(discardCancelled?.details)}；默认焦点=${discardCancelled?.focusedLabel}；取消后会话=${afterDiscardCancel.file} 签名数=${afterDiscardCancel.items}；确认后会话=${afterDiscardAccept.file} 签名数=${afterDiscardAccept.items}`,
    );

    // ---- B6 全程未使用原生弹窗 ----
    check(
      "B6 全程未出现原生 alert/confirm 弹窗",
      diagnostics.nativeDialogs.length === 0,
      diagnostics.nativeDialogs.length === 0
        ? "所有确认交互均由页面内的自绘 dialog 完成"
        : `出现原生弹窗 ${JSON.stringify(diagnostics.nativeDialogs)}`,
    );

    await context.close();

    // ===================================================================
    // A13 —— 第二轮审查 3 项 P2 的回归断言
    //   1) 放大到页面宽于容器后，页面左边缘仍可滚动到达
    //   2) 贴边放置的实例被收进页面内，导出不被裁剪
    //   3) 逐页浏览长文档时，离屏页面释放像素缓冲与文本层
    // 这三条都属于「构建、类型、其余断言全绿也照样坏」，只能靠真实浏览器里的
    // 布局几何与画布后备尺寸看见；带区分力的对照留在 p2-verify.mjs。
    // ===================================================================

    // heavy-text-40p.pdf 由 make-heavy-text.mjs 生成（见 docs/acceptance/README.md）。
    // 缺夹具时自动补齐，避免 setInputFiles 抛一个含义不明的错误。
    await access(`${FIX}/heavy-text-40p.pdf`).catch(async () => {
      await execFileAsync(process.execPath, [`${FIX}/make-heavy-text.mjs`]);
    });

    const regression = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 2,
    });
    const regressionPage = await regression.newPage();
    attachDiagnostics(regressionPage);
    await openApp(regressionPage);
    await openPdf(regressionPage, "plain.pdf", 2);
    await createSignature(regressionPage, "R");
    await pickTemplate(regressionPage, 0);
    await regressionPage.waitForTimeout(200);

    // ---- A13-2 贴边放置：先贴左边缘 ----
    const regressionScroller = await regressionPage
      .locator("[data-testid=pdf-scroller]")
      .boundingBox();
    const regressionPageBox = await regressionPage
      .locator('.pdf-page[data-page-index="0"]')
      .boundingBox();
    const leftEdgeClick = {
      x: regressionPageBox.x + 6,
      y: Math.min(
        regressionPageBox.y + regressionPageBox.height - 6,
        regressionScroller.y + regressionScroller.height - 8,
      ),
    };
    await regressionPage.mouse.click(leftEdgeClick.x, leftEdgeClick.y);
    await regressionPage.waitForTimeout(300);

    // ---- A13-2 贴边放置：缩小到整页可见，再贴下边缘 ----
    for (let step = 0; step < 2; step += 1) {
      await regressionPage.locator('button[title="缩小"]').click();
    }
    await regressionPage.waitForTimeout(900);
    const bottomPageBox = await regressionPage
      .locator('.pdf-page[data-page-index="0"]')
      .boundingBox();
    // 本段直接点页面（不走 placeOnPage），因此要自己重新选中模板：
    // 产品在成功放置一次后会退出放置模式，不再重新武装的话这次点击不会放下任何东西，
    // 于是只剩 1 个实例、第二个贴边几何读到 undefined 而打印 NaNpx，并连带 A13-3 少一张图。
    await pickTemplate(regressionPage, 0);
    await regressionPage.mouse.click(
      bottomPageBox.x + bottomPageBox.width / 2,
      bottomPageBox.y + bottomPageBox.height - 6,
    );
    await regressionPage.waitForTimeout(300);

    const edgeGeometry = await regressionPage.evaluate(() => {
      const pageRect = document
        .querySelector('.pdf-page[data-page-index="0"]')
        .getBoundingClientRect();
      const items = [...document.querySelectorAll("[data-testid=placement]")];
      const rectOf = (rect) => ({
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      });
      return {
        page: rectOf(pageRect),
        items: items.map((element) => rectOf(element.getBoundingClientRect())),
      };
    });
    const insideOf = (item) =>
      item.left >= edgeGeometry.page.left - 0.5 &&
      item.right <= edgeGeometry.page.right + 0.5 &&
      item.top >= edgeGeometry.page.top - 0.5 &&
      item.bottom <= edgeGeometry.page.bottom + 0.5;
    const leftItem = edgeGeometry.items[0];
    const bottomItem = edgeGeometry.items[1];
    // 实例缺失时直接说「没放上」，不要打印 NaNpx——那会把「少放了一次」伪装成数值问题。
    const gap = (value) =>
      Number.isFinite(value) ? `${value.toFixed(2)}px` : "缺（该实例没放上）";
    check(
      "A13-2 贴边放置被收进页面内（左边界与下边界各一次）",
      edgeGeometry.items.length === 2 &&
        insideOf(leftItem) &&
        insideOf(bottomItem) &&
        leftItem.left - edgeGeometry.page.left < 2 &&
        Math.abs(edgeGeometry.page.bottom - bottomItem.bottom) < 2,
      `实例数 ${edgeGeometry.items.length}；第一个左边缘距页面左边缘 ${gap(leftItem && leftItem.left - edgeGeometry.page.left)}，第二个下边缘距页面下边缘 ${gap(bottomItem && edgeGeometry.page.bottom - bottomItem.bottom)}（都应为 0 附近，即被平移收边）`,
    );

    const regressionExport = await exportPdf(regressionPage, "A13-edge-placement.pdf");
    const regressionProbe = await probePdf(regressionExport.target);
    const regressionCropbox = regressionProbe.pages[0].boxes.cropbox;
    const regressionMargins = regressionProbe.pages[0].images.map((image) =>
      Math.min(
        image.minCorner[0] - regressionCropbox[0],
        regressionCropbox[2] - image.maxCorner[0],
        image.minCorner[1] - regressionCropbox[1],
        regressionCropbox[3] - image.maxCorner[1],
      ),
    );
    check(
      "A13-3 两个贴边实例导出后完整位于页面可见区域内",
      regressionProbe.pages[0].images.length === 2 &&
        regressionMargins.every((value) => value >= -0.5),
      `导出图片 ${regressionProbe.pages[0].images.length} 个；各自到最近页面边界的最小余量 ${regressionMargins.map((value) => value.toFixed(1)).join(" / ")}（负数即被裁剪）`,
    );

    // ---- A13-1 放大到横向溢出后，左边缘仍可达 ----
    for (let step = 0; step < 5; step += 1) {
      await regressionPage.locator('button[title="放大"]').click();
    }
    await regressionPage.waitForTimeout(900);
    const reachability = await regressionPage.evaluate(() => {
      const scroller = document.querySelector("[data-testid=pdf-scroller]");
      scroller.scrollLeft = 0;
      const scrollerRect = scroller.getBoundingClientRect();
      const pageRect = scroller.querySelector(".pdf-page").getBoundingClientRect();
      return {
        overflow: scroller.scrollWidth - scroller.clientWidth,
        pageLeftFromOrigin: Math.round(pageRect.left - scrollerRect.left),
        contentMinWidth: getComputedStyle(scroller.firstElementChild).minWidth,
        zoom: document.querySelector("[data-testid=zoom-level]").textContent.trim(),
      };
    });
    check(
      "A13-1 放大后页面左边缘仍可滚动到达（不再落入负向区域）",
      reachability.overflow > 40 && reachability.pageLeftFromOrigin >= -1,
      `缩放 ${reachability.zoom}，横向溢出 ${reachability.overflow}px，页面左边缘相对滚动原点 ${reachability.pageLeftFromOrigin}px，内容层 min-width=${reachability.contentMinWidth}`,
    );
    await regression.close();

    // ---- A13-4 / A13-5 / A13-6 长文档逐页浏览的离屏占用 ----
    const longRegression = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 2,
    });
    const longRegressionPage = await longRegression.newPage();
    attachDiagnostics(longRegressionPage);
    await openApp(longRegressionPage);
    await openPdf(longRegressionPage, "heavy-text-40p.pdf", 40);
    await createSignature(longRegressionPage, "R");
    await pickTemplate(longRegressionPage, 0);
    const longFirstBox = await longRegressionPage
      .locator('.pdf-page[data-page-index="0"]')
      .boundingBox();
    await longRegressionPage.mouse.click(
      longFirstBox.x + longFirstBox.width / 2,
      longFirstBox.y + 120,
    );
    await longRegressionPage.waitForTimeout(400);

    const readPageResources = () =>
      longRegressionPage.evaluate(() => {
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
        let spansInBand = 0;
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
            counterfactualBytes += cssWidth * ratio * cssHeight * ratio * 4;
          }
          if (canvas && canvas.width > 1) {
            liveBuffers += 1;
            liveBytes += canvas.width * canvas.height * 4;
            if (!inBand) liveOutsideBand += 1;
            if (rect.top >= scrollerRect.bottom && rect.top - scrollerRect.bottom < band) {
              preRenderedBelowFold += 1;
            }
          }
          const spans = wrapper.querySelectorAll(".pdf-text-layer span").length;
          if (inBand) spansInBand += spans;
          else spansOutsideBand += spans;
        }
        return {
          liveBuffers,
          liveOutsideBand,
          everRendered,
          liveMb: Number((liveBytes / 1048576).toFixed(2)),
          counterfactualMb: Number((counterfactualBytes / 1048576).toFixed(2)),
          spansOutsideBand,
          spansInBand,
          preRenderedBelowFold,
          placements: document.querySelectorAll("[data-testid=placement]").length,
        };
      });

    const longInput = longRegressionPage.locator("[data-testid=page-input]");
    for (let number = 2; number <= 13; number += 1) {
      await longInput.fill(String(number));
      await longInput.press("Enter");
      await longRegressionPage.waitForTimeout(300);
    }
    await longRegressionPage.waitForTimeout(700);
    const browseState = await readPageResources();

    check(
      "A13-4 逐页浏览后，离屏页面不保留画面缓冲与文本层",
      browseState.everRendered >= 8 &&
        browseState.liveOutsideBand === 0 &&
        browseState.liveBuffers <= 5 &&
        browseState.spansOutsideBand === 0,
      `已渲染过的页面 ${browseState.everRendered} 个，仍持有缓冲 ${browseState.liveBuffers} 个（离屏 ${browseState.liveOutsideBand} 个），离屏文本节点 ${browseState.spansOutsideBand} 个，占用 ${browseState.liveMb}MB；同样这些页面在旧实现下会一直占住约 ${browseState.counterfactualMb}MB`,
    );
    check(
      "A13-5 预渲染余量生效：折叠线以下的相邻页已提前渲染",
      browseState.preRenderedBelowFold >= 1 && browseState.spansInBand >= 40,
      `折叠线以下、900px 余量内已渲染的页面 ${browseState.preRenderedBelowFold} 个，带内文本节点 ${browseState.spansInBand} 个。余量带若失效（root 用视口时会被滚动容器可视区裁掉），这个数会是 0，滚回去只能看到白页`,
    );

    await longInput.fill("1");
    await longInput.press("Enter");
    await longRegressionPage.waitForFunction(
      () => {
        const wrapper = document.querySelector('.pdf-page[data-page-index="0"]');
        if (!wrapper) return false;
        const canvas = wrapper.querySelector("canvas");
        const cssWidth = Number.parseFloat(wrapper.style.width || "0") || 0;
        const ratio = window.devicePixelRatio || 1;
        return Boolean(
          canvas &&
          canvas.width > 1 &&
          Math.abs(canvas.width - cssWidth * ratio) <= 2 &&
          wrapper.querySelectorAll(".pdf-text-layer span").length > 0,
        );
      },
      null,
      { timeout: 30000 },
    );
    const returnState = await readPageResources();
    check(
      "A13-6 回到已看过的页面：画面与文本层重建、签名仍在",
      returnState.placements === 1 && returnState.liveBuffers >= 1 && returnState.spansInBand >= 40,
      `返回第 1 页后：签名实例 DOM ${returnState.placements} 个（离屏释放保留了 viewport 与实例数据），带内文本节点 ${returnState.spansInBand} 个`,
    );
    await longRegressionPage.screenshot({ path: `${OUT}/A13-longdoc-return.png` });
    await longRegression.close();

    // ===================================================================
    // A14 —— 第三轮审查 2 项 P2 的回归断言
    //   1) 切换文档后缩略图不再被「用新文档编号画进已移除画布 + 写脏渲染缓存」拖成永久空白
    //   2) 保存签名时闸门在进入第一个异步操作之前就合上
    // A14-3/4 需要把观察器回调投递推迟，才能把 P2-4 的竞态变成确定性复现：
    // 前台切换时首帧回调只比 stale 渲染晚 2—5ms，会把 stale 任务取消，症状根本不出现。
    // 这条扰动只改投递时序、不改应用逻辑，实测数据与判据见 docs/code-review 第八节。
    // ===================================================================

    await access(`${FIX}/dot-40p.pdf`).catch(async () => {
      await execFileAsync(process.execPath, [`${FIX}/make-dot.mjs`]);
    });

    /** 缩略图面板状态：哪些项在可视区内、每项画布是否真的画上了像素（alpha 占比）。 */
    const readThumbs = (page, scrollTo = null) =>
      page.evaluate(async (target) => {
        const aside = document.querySelector("[data-testid=thumb-item]")?.closest("aside");
        if (!aside) {
          return { total: 0, inView: [], drawnInView: 0, blankInView: [], defaultSizedInView: 0 };
        }
        if (target === "top") {
          aside.scrollTop = 0;
        } else if (target === "bottom") {
          aside.scrollTop = aside.scrollHeight;
        }
        if (target) {
          await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
          await new Promise((resolve) => setTimeout(resolve, 700));
        }
        const asideRect = aside.getBoundingClientRect();
        const list = [...aside.querySelectorAll("[data-testid=thumb-item]")].map((item) => {
          const canvas = item.querySelector("canvas");
          const rect = item.getBoundingClientRect();
          let opaque = 0;
          let total = 0;
          if (canvas.width > 1 && canvas.height > 1) {
            const data = canvas
              .getContext("2d")
              .getImageData(0, 0, canvas.width, canvas.height).data;
            for (let y = 0; y < canvas.height; y += 2) {
              for (let x = 0; x < canvas.width; x += 2) {
                total += 1;
                if (data[(y * canvas.width + x) * 4 + 3] > 0) opaque += 1;
              }
            }
          }
          return {
            index: Number(item.dataset.thumbIndex),
            inView: rect.bottom > asideRect.top + 1 && rect.top < asideRect.bottom - 1,
            defaultSized: canvas.width === 300 && canvas.height === 150,
            alpha: total > 0 ? opaque / total : 0,
          };
        });
        const inView = list.filter((entry) => entry.inView);
        return {
          total: list.length,
          inView: inView.map((entry) => entry.index),
          drawnInView: inView.filter((entry) => entry.alpha > 0.5).length,
          blankInView: inView.filter((entry) => entry.alpha <= 0.5).map((entry) => entry.index),
          defaultSizedInView: inView.filter((entry) => entry.defaultSized).length,
        };
      }, scrollTo);

    const describeThumbs = (state) =>
      `面板 ${state.total} 项，可视 ${state.inView.length} 项（页码 ${state.inView[0]}–${state.inView[state.inView.length - 1]}），已绘制 ${state.drawnInView} 项，空白 ${JSON.stringify(state.blankInView)}，仍是默认 300x150 的 ${state.defaultSizedInView} 个`;

    // ---- A14-1 / A14-2：常规前台切换 ----
    const thumbContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const thumbPage = await thumbContext.newPage();
    attachDiagnostics(thumbPage);
    await openApp(thumbPage);
    await openPdf(thumbPage, "heavy-text-40p.pdf", 40);
    await thumbPage.waitForTimeout(1400);

    const beforeSwitch = await readThumbs(thumbPage);
    await openPdf(thumbPage, "book-100p.pdf", 100);
    await thumbPage.waitForTimeout(1200);
    const afterSwitch = await readThumbs(thumbPage);
    check(
      "A14-1 切换文档后，可视缩略图全部已绘制",
      beforeSwitch.drawnInView === beforeSwitch.inView.length &&
        beforeSwitch.inView.length >= 4 &&
        afterSwitch.drawnInView === afterSwitch.inView.length &&
        afterSwitch.inView.length >= 4,
      `切换前 ${describeThumbs(beforeSwitch)}；切换后（40 页 → 100 页）${describeThumbs(afterSwitch)}`,
    );

    const afterScroll = await readThumbs(thumbPage, "bottom");
    check(
      "A14-2 滚动到面板底部后，新入视野的缩略图已绘制且没有画布停在默认尺寸",
      afterScroll.inView.length >= 3 &&
        afterScroll.drawnInView === afterScroll.inView.length &&
        afterSwitch.defaultSizedInView === 0 &&
        afterScroll.defaultSizedInView === 0,
      `滚到底 ${describeThumbs(afterScroll)}`,
    );
    await thumbPage.screenshot({ path: `${OUT}/A14-thumbnails-after-switch.png` });
    await thumbContext.close();

    // ---- A14-3 / A14-4：把染步推迟，让 P2-4 的竞态确定性复现 ----
    const deferredContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await deferredContext.addInitScript(() => {
      window.__probeIoDelay = 0;
      window.__probeDeliveries = [];
      const Original = window.IntersectionObserver;
      window.IntersectionObserver = class extends Original {
        constructor(callback, options) {
          super((entries, observer) => {
            const thumbs = entries.filter((entry) =>
              entry.target?.matches?.("[data-testid=thumb-item]"),
            );
            if (thumbs.length > 0) {
              const record = {
                scheduledAt: performance.now(),
                thumbs: thumbs.length,
                visible: thumbs.filter((entry) => entry.isIntersecting).length,
                delay: window.__probeIoDelay,
              };
              window.__probeDeliveries.push(record);
              if (record.delay > 0) {
                window.setTimeout(() => {
                  record.ranAt = performance.now();
                  callback(entries, observer);
                }, record.delay);
                return;
              }
              record.ranAt = record.scheduledAt;
            }
            callback(entries, observer);
          }, options);
        }
      };
    });
    const deferredPage = await deferredContext.newPage();
    attachDiagnostics(deferredPage);
    await openApp(deferredPage);
    await openPdf(deferredPage, "heavy-text-40p.pdf", 40);
    await deferredPage.waitForTimeout(1400);

    const deferredSetup = await deferredPage.evaluate((delay) => {
      window.__probeIoDelay = delay;
      window.__probeDeliveries.length = 0;
      window.__probeSwitchAt = performance.now();
      const aside = document.querySelector("[data-testid=thumb-item]")?.closest("aside");
      window.__probeOldCanvases = [...aside.querySelectorAll("[data-testid=thumb-item]")].map(
        (item) => item.querySelector("canvas"),
      );
      window.__probeCanvasWrites = [];
      const watcher = new MutationObserver((records) => {
        for (const record of records) {
          window.__probeCanvasWrites.push({
            t: performance.now(),
            attr: record.attributeName,
            detached: !record.target.isConnected,
          });
        }
      });
      for (const canvas of window.__probeOldCanvases) {
        watcher.observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });
      }
      return {
        oldCanvases: window.__probeOldCanvases.length,
        painted: window.__probeOldCanvases.filter((canvas) => canvas.width > 1).length,
      };
    }, IO_DELAY_MS);

    await openPdf(deferredPage, "dot-40p.pdf", 40);
    await deferredPage.waitForTimeout(IO_DELAY_MS + 1200);
    const deferredState = await deferredPage.evaluate(() => ({
      switchAt: window.__probeSwitchAt,
      deliveries: window.__probeDeliveries,
      writeCount: window.__probeCanvasWrites.length,
      detachedWrites: window.__probeCanvasWrites.filter((record) => record.detached).length,
      firstWriteAt: window.__probeCanvasWrites[0]
        ? window.__probeCanvasWrites[0].t - window.__probeSwitchAt
        : null,
    }));
    const deferredThumbs = await readThumbs(deferredPage);
    const firstDelivery = deferredState.deliveries[0];
    const deferral = firstDelivery ? (firstDelivery.ranAt ?? 0) - firstDelivery.scheduledAt : 0;

    check(
      "A14-3 切换文档时，旧画布没有被新文档的渲染改写",
      deferredState.detachedWrites === 0 &&
        deferredSetup.painted === deferredSetup.oldCanvases &&
        Boolean(firstDelivery) &&
        firstDelivery.delay === IO_DELAY_MS &&
        deferral >= IO_DELAY_MS - 50,
      `切换前 ${deferredSetup.oldCanvases} 个旧画布均已设尺寸；首帧观察器回调被推迟（注入 ${IO_DELAY_MS}ms，实测 ${deferral.toFixed(0)}ms，判别阈值 ≥${IO_DELAY_MS - 50}ms，足以让 stale 渲染先跑完）；旧画布尺寸属性被改写 ${deferredState.writeCount} 次，其中 detached=${deferredState.detachedWrites}。旧实现会把新文档的页面画进这批已移除画布（实测 40 个画布 80 次改写、全部 detached），并据此写脏 renderedKeys`,
    );
    check(
      "A14-4 染步被推迟时，可视缩略图依然全部已绘制",
      deferredThumbs.inView.length >= 4 &&
        deferredThumbs.drawnInView === deferredThumbs.inView.length &&
        deferredThumbs.defaultSizedInView === 0,
      `${describeThumbs(deferredThumbs)}。旧实现在同样扰动下表现为 8 个可视项全部空白、尺寸停在 300x150、且不会自愈`,
    );
    await deferredPage.screenshot({ path: `${OUT}/A14-thumbnails-deferred-frame.png` });
    await deferredContext.close();

    // ---- A14-5 / A14-6：保存签名的闸门 ----
    const padContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await padContext.addInitScript(() => {
      window.__toBlobDelay = 0;
      // 拦截原型方法：保存原实现是为了稍后用 original.call(this, …) 调用。
      // 这里正是「故意引用未绑定方法」，规则看不穿后续的 .call(this)，故就地关闭并说明原因。
      // eslint-disable-next-line typescript/unbound-method
      const original = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (callback, ...rest) {
        const delay = Number(window.__toBlobDelay) || 0;
        if (delay <= 0) {
          return original.call(this, callback, ...rest);
        }
        return window.setTimeout(() => original.call(this, callback, ...rest), delay);
      };
    });
    const padPage = await padContext.newPage();
    attachDiagnostics(padPage);
    await openApp(padPage);
    await openPdf(padPage, "plain.pdf", 2);

    await padPage
      .locator("[data-testid=signature-library]")
      .getByRole("button", { name: "新建签名" })
      .first()
      .click();
    await padPage.waitForSelector("[data-testid=signature-pad-canvas]");
    await padPage.waitForTimeout(260);
    await drawGlyph(padPage, "R");
    await padPage.evaluate((delay) => {
      window.__toBlobDelay = delay;
    }, TO_BLOB_DELAY_MS);

    const libraryBefore = await libraryItemCount(padPage);
    await padPage
      .locator("[data-testid=signature-pad-dialog]")
      .getByRole("button", { name: /保存到签名库|保存中/ })
      .click();
    const padWindow = await padPage.evaluate(async () => {
      const dialog = document.querySelector("[data-testid=signature-pad-dialog]");
      const buttons = [...dialog.querySelectorAll("button")];
      const save = buttons.find((button) => /保存到签名库|保存中/.test(button.textContent ?? ""));
      const cancel = buttons.find((button) => (button.textContent ?? "").trim() === "取消");
      const snapshot = { disabled: save.disabled, label: (save.textContent ?? "").trim() };
      save.click();
      cancel.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      snapshot.dialogOpenAfterCancel = Boolean(
        document.querySelector("[data-testid=signature-pad-dialog]"),
      );
      return snapshot;
    });
    check(
      "A14-5 保存进行中：按钮已禁用，点「取消」不放行",
      padWindow.disabled === true &&
        padWindow.label.includes("保存中") &&
        padWindow.dialogOpenAfterCancel === true,
      `窗口期内按钮 disabled=${padWindow.disabled}、文案="${padWindow.label}"；点取消 80ms 后弹窗仍在=${padWindow.dialogOpenAfterCancel}。旧实现：裁剪完成前 isSaving 仍为 false，按钮可再点、取消会把窗口关掉而保存继续`,
    );

    await padPage
      .locator("[data-testid=signature-pad-dialog]")
      .waitFor({ state: "hidden", timeout: 8000 })
      .catch(() => {});
    // 旧实现的第二次保存要再等一个 toBlob 延迟才落库，留足时间再比较数量。
    await padPage.waitForTimeout(1800);
    const libraryAfter = await libraryItemCount(padPage);
    check(
      "A14-6 窗口期内重复点击保存只写入 1 项，保存成功后弹窗正常关闭",
      libraryAfter - libraryBefore === 1 &&
        (await padPage
          .locator("[data-testid=signature-pad-dialog]")
          .isHidden()
          .catch(() => false)),
      `库内新增 ${libraryAfter - libraryBefore} 项（${libraryBefore} → ${libraryAfter}）。旧实现会在窗口期内另起一次 cropToInk + saveTemplate，落库 2 项同名签名`,
    );

    // 反向对照：只合闸门不复位会把弹窗锁死，确认没有过度加锁。
    await padPage
      .locator("[data-testid=signature-library]")
      .getByRole("button", { name: "新建签名" })
      .first()
      .click();
    await padPage.waitForSelector("[data-testid=signature-pad-canvas]");
    await padPage.waitForTimeout(200);
    const padReopened = await padPage.evaluate(() => {
      const dialog = document.querySelector("[data-testid=signature-pad-dialog]");
      const save = [...dialog.querySelectorAll("button")].find((button) =>
        /保存到签名库|保存中/.test(button.textContent ?? ""),
      );
      return (save.textContent ?? "").trim();
    });
    await padPage
      .locator("[data-testid=signature-pad-dialog]")
      .getByRole("button", { name: "取消" })
      .click();
    const padClosed = await padPage
      .locator("[data-testid=signature-pad-dialog]")
      .waitFor({ state: "hidden", timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    check(
      "A14-7 保存成功后闸门已复位：重开弹窗按钮不再停在「保存中…」",
      padReopened.includes("保存到签名库") && padClosed,
      `重开后按钮文案="${padReopened}"，取消可关闭=${padClosed}`,
    );
    await padContext.close();

    // ===================================================================
    // A15 / A16 —— 第四轮审查 2 项 P2 的回归断言
    //   1) 加密文档（所有者密码 + 空用户口令）能打开，但导出必须被拒绝
    //   2) 确认弹窗点击正文后，Esc 仍能关闭、Tab 仍在弹窗内循环
    // 两条都属于「构建与其余断言全绿也照样坏」：前者回退后不报错、只是静默产出
    // 坏文件，后者回退后表现为键盘在弹窗内失效。纯 Node 侧的守卫缺失对照见
    // tests/geometry/pdf-encrypted-export.test.ts；本段两条也做过逐片段回退核对。
    // ===================================================================
    const cryptoContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const cryptoPage = await cryptoContext.newPage();
    attachDiagnostics(cryptoPage);
    await openApp(cryptoPage);

    // ---- A15-1 加密文档能打开：PDF.js 对「空用户口令」不要求输入密码 ----
    await openPdf(cryptoPage, "encrypted-owner-password.pdf", 2);
    await waitForBannersToClear(cryptoPage);
    const encryptedOpened = await cryptoPage.evaluate(() => {
      const canvas = document.querySelector(".pdf-page canvas");
      let opaque = 0;
      let sampled = 0;
      if (canvas && canvas.width > 1 && canvas.height > 1) {
        const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        for (let y = 0; y < canvas.height; y += 4) {
          for (let x = 0; x < canvas.width; x += 4) {
            sampled += 1;
            if (data[(y * canvas.width + x) * 4 + 3] > 0) opaque += 1;
          }
        }
      }
      const banners = [...document.querySelectorAll("[data-testid=banner]")].map((banner) =>
        (banner.textContent ?? "").trim(),
      );
      return {
        file: (document.querySelector("[data-testid=file-name]")?.textContent ?? "").trim(),
        pages: document.querySelectorAll(".pdf-page").length,
        backing: canvas ? `${canvas.width}x${canvas.height}` : "无画布",
        defaultSized: canvas ? canvas.width === 300 && canvas.height === 150 : false,
        opaqueRatio: sampled > 0 ? opaque / sampled : -1,
        encryptedNotice: banners.some((text) => text.includes("已加密")),
      };
    });
    check(
      "A15-1 加密文档无需密码即可打开并渲染（所有者密码 + 空用户口令）",
      encryptedOpened.file.includes("encrypted-owner-password.pdf") &&
        encryptedOpened.pages === 2 &&
        !encryptedOpened.defaultSized &&
        encryptedOpened.opaqueRatio > 0.5 &&
        !encryptedOpened.encryptedNotice,
      `已打开 ${encryptedOpened.file}，页数 ${encryptedOpened.pages}，首页画布 ${encryptedOpened.backing}（默认尺寸=${encryptedOpened.defaultSized}），不透明像素占比 ${encryptedOpened.opaqueRatio.toFixed(2)}，出现「已加密」提示=${encryptedOpened.encryptedNotice}`,
    );

    // ---- A15-2 导出必须拒绝，且不能留下任何下载产物 ----
    await createSignature(cryptoPage, "R");
    await pickTemplate(cryptoPage, 0);
    await placeOnPage(cryptoPage, 0, 0.42, 0.55);
    await cryptoPage.waitForFunction(
      () => document.querySelectorAll("[data-testid=placement]").length === 1,
      null,
      { timeout: 15000 },
    );

    const cryptoDownloads = [];
    cryptoPage.on("download", (download) => cryptoDownloads.push(download.suggestedFilename()));
    await cryptoPage.getByRole("button", { name: /下载签名后的 PDF|正在导出/ }).click();
    const exportFailure = await cryptoPage
      .locator("[data-testid=banner][data-tone=error]")
      .filter({ hasText: "导出失败" })
      .first()
      .waitFor({ state: "visible", timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    // 断言文案语义而非整句常量：逐字绑定会让「改一个字就静默放过」变成「改一个字就红」，
    // 而这里真正要守的是「拒绝」「加密」两件事都被告知。
    const exportFailureText = exportFailure
      ? (
          await cryptoPage
            .locator("[data-testid=banner][data-tone=error]")
            .filter({ hasText: "导出失败" })
            .first()
            .innerText()
        ).trim()
      : "";
    // 导出被拒后编辑不应被清空，也不该给用户留下一个「已导出」的成功提示。
    const afterRefusedExport = {
      items: (await itemBoxes(cryptoPage)).length,
      successBanner: await cryptoPage
        .locator("[data-testid=banner][data-tone=success]")
        .filter({ hasText: "已导出" })
        .count(),
    };
    await cryptoPage.waitForTimeout(600);
    check(
      "A15-2 加密文档导出被拒绝：提示已加密且未产生任何下载",
      exportFailure &&
        exportFailureText.includes("已加密") &&
        exportFailureText.includes("暂不支持") &&
        cryptoDownloads.length === 0 &&
        afterRefusedExport.items === 1 &&
        afterRefusedExport.successBanner === 0,
      `错误提示="${exportFailureText.split("\n")[0]}"；下载事件 ${cryptoDownloads.length} 次${cryptoDownloads.length ? `（${JSON.stringify(cryptoDownloads)}）` : ""}；实例仍为 ${afterRefusedExport.items} 个；成功提示 ${afterRefusedExport.successBanner} 条。守卫缺失对照流程：此处会照常触发下载并生成一个内容未解密、读不回页面的坏文件`,
    );

    // ---- A16-1 / A16-2 点击弹窗正文后的键盘可用性 ----
    // 有未导出的编辑时切换文档会先弹「放弃当前编辑」。点击正文（不可聚焦内容）曾让焦点
    // 落到 document.body —— 弹窗面板不是可聚焦祖先，键盘事件不再经过组件，Esc 直接失效。
    // A16-1 断言机制（焦点归属），A16-2 断言用户可感知的结果（Esc 关闭）。
    // 摘掉 tabindex 的对照实测：activeElement=<BODY>、在弹窗内=false、Esc 后关闭=false、
    // 且键盘事件不再进入组件；恢复后三条同时成立 —— 因此这两条都能区分新旧实现。
    const focusDialog = cryptoPage.locator("[data-testid=confirm-dialog]");
    await cryptoPage
      .locator("[data-testid=toolbar] input[type=file]")
      .setInputFiles(`${FIX}/sig-field-signed.pdf`);
    await focusDialog.waitFor({ state: "visible", timeout: 10000 });
    await cryptoPage.waitForTimeout(180);
    const sessionBeforeBodyClick = (
      await cryptoPage.locator("[data-testid=file-name]").innerText()
    ).trim();
    await focusDialog.locator("[data-testid=confirm-message]").click();
    const focusAfterBodyClick = await cryptoPage.evaluate(() => {
      const active = document.activeElement;
      return {
        tag: active?.tagName ?? null,
        role: active?.getAttribute?.("role") ?? null,
        isPanel: active === document.querySelector("[data-testid=confirm-dialog] [role=dialog]"),
        inside: Boolean(active?.closest?.("[data-testid=confirm-dialog]")),
        isBody: active === document.body,
      };
    });
    check(
      "A16-1 点击确认框正文后，焦点落到弹窗面板而不是 document.body",
      focusAfterBodyClick.isPanel && !focusAfterBodyClick.isBody,
      `点正文后 activeElement=<${focusAfterBodyClick.tag}> role=${focusAfterBodyClick.role}，是 dialog 面板=${focusAfterBodyClick.isPanel}，在弹窗内=${focusAfterBodyClick.inside}，是 body=${focusAfterBodyClick.isBody}。旧实现：焦点落到 body，键盘事件不再经过弹窗组件`,
    );

    await cryptoPage.keyboard.press("Escape");
    const closedByEscape = await focusDialog
      .waitFor({ state: "hidden", timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    const sessionAfterEscape = (
      await cryptoPage.locator("[data-testid=file-name]").innerText()
    ).trim();
    check(
      "A16-2 此后 Esc 仍能关闭弹窗，且不切换文档",
      closedByEscape && sessionAfterEscape === sessionBeforeBodyClick,
      `Esc 后关闭=${closedByEscape}（旧实现为 false），会话仍为 ${sessionAfterEscape}。Esc 是这次修复唯一被用户直接感知的效果`,
    );

    // ---- A16-3 反向对照：焦点落在面板上时，Shift+Tab 不得越出弹窗 ----
    // 这条守的不是「原来的 bug」（旧实现里焦点在 body，浏览器把点击位置当起点，
    // Shift+Tab 反而留在弹窗内），而是 tabindex 修复自身带来的副作用：
    // 焦点落到面板后，面板既不是 first 也算 inside，只判断这两者就会走浏览器默认行为，
    // 把焦点交给遮罩背后的工具栏。实测（探针 focus-probe.mjs）：
    //   修复前：点击正文 → Shift+Tab → <BUTTON>「新建签名」在弹窗内=false
    //   修复后：点击正文 → Shift+Tab → <BUTTON>「放弃并打开」在弹窗内=true
    // 与 A14-7 同类：为「过度修复/修复副作用」设的反向断言。
    await cryptoPage
      .locator("[data-testid=toolbar] input[type=file]")
      .setInputFiles(`${FIX}/sig-field-signed.pdf`);
    await focusDialog.waitFor({ state: "visible", timeout: 10000 });
    await cryptoPage.waitForTimeout(180);
    await focusDialog.locator("[data-testid=confirm-message]").click();
    // 循环顺序按运行时读到的按钮来判，不写死文案：这一段拿到的是「放弃当前编辑」弹窗
    //（有未导出的编辑），它的确认按钮是「放弃并打开」，与数字签名弹窗不同名。
    const dialogButtons = (
      await focusDialog.locator("[data-testid=confirm-actions] .button").allInnerTexts()
    ).map((label) => label.trim());
    const tabWalk = [];
    // 第一步必须从 dialog 面板自身执行 Shift+Tab，直接覆盖
    // `active === panelRef.value` 分支；之后再验证正向与反向循环。
    for (const key of ["Shift+Tab", "Tab", "Shift+Tab", "Shift+Tab"]) {
      await cryptoPage.keyboard.press(key);
      await cryptoPage.waitForTimeout(60);
      tabWalk.push(
        await cryptoPage.evaluate((pressed) => {
          const active = document.activeElement;
          return {
            pressed,
            tag: active?.tagName ?? null,
            label: (active?.textContent ?? "").trim().slice(0, 12),
            inside: Boolean(active?.closest?.("[data-testid=confirm-dialog]")),
          };
        }, key),
      );
    }
    const tabWalkDetail = tabWalk
      .map((step) => `${step.pressed}→<${step.tag}>「${step.label}」在弹窗内=${step.inside}`)
      .join("；");
    note(`点击正文后的逐步焦点：${tabWalkDetail}`);
    const expectedCycle = [dialogButtons[1], dialogButtons[0], dialogButtons[1], dialogButtons[0]];
    check(
      "A16-3 点击正文后连续 Tab / Shift+Tab，焦点始终收在弹窗内",
      dialogButtons.length === 2 &&
        tabWalk.length === 4 &&
        tabWalk.every((step) => step.inside && step.tag === "BUTTON") &&
        tabWalk.every((step, index) => step.label === expectedCycle[index]),
      `${tabWalkDetail}（弹窗按钮 ${JSON.stringify(dialogButtons)}）。修复副作用对照：加 tabindex 但不把面板自身视为「不在循环内」时，从面板出发的 Shift+Tab 会落到 <BUTTON>「新建签名」——即遮罩背后的工具栏`,
    );

    await handleConfirmDialog(cryptoPage, "取消", 1200);
    await cryptoContext.close();
  } finally {
    await browser.close();
  }

  const passed = results.filter((item) => item.ok).length;
  console.log(`\n汇总：${passed}/${results.length} 项通过`);
  for (const item of results.filter((entry) => !entry.ok)) {
    console.log(`  失败 ${item.id}: ${item.detail}`);
  }

  await writeFile(
    `${OUT}/report.json`,
    // 结尾补换行：归档到 docs/acceptance/ 后要过 vp check 的格式检查，
    // 生成物自己带上会省掉一遍「归档后再修一行」的手工步骤。
    `${JSON.stringify(
      {
        results,
        notes,
        // 分段说明，让 report.json 自解释（归档到 docs/acceptance/ 后，
        // 单看报告也能知道 A1…A14 各自覆盖什么，不必回来读脚本）。
        sections: A,
        requestHosts: [...new Set(allRequestUrls.map((url) => new URL(url).origin))],
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`报告已写入 ${OUT}/report.json`);
  return results;
}
