/**
 * 第三轮审查 2 项 P2 的独立回归探针（真实 Chromium）。
 *
 *   P2-4  切换 PDF 后缩略图持续空白
 *         PageThumbnails.vue 的 watch(documentId) flush 为 `pre`，在 DOM 更新前运行：
 *         此刻 canvasRefs 里还是旧文档的画布，documentId 已是新值。旧实现从这里主动
 *         遍历渲染，于是「用新文档编号把内容画进旧画布」，并给新编号写进 renderedKeys；
 *         随后挂载的新画布因缓存命中选择跳过，永久空白。
 *
 *         这条症状受竞态掩护：前台切换时观察器的首帧回调就落在同一个染步里，
 *         只比 stale 渲染晚 2—5ms（本环境实测），它会把尚未完成的 stale 任务取消掉，
 *         症状就不出现。只有当染步被推迟（后台标签页、长卡帧、重型主视图抢主线程）时，
 *         stale 渲染才会先跑完并写下缓存 —— 此时可见缩略图会全部空白、尺寸停在 300x150，
 *         而且再也不会恢复。所以本探针分两组：
 *           A 组（常规前台切换）守护正常路径；
 *           B 组把观察器回调投递整体延后，把 P2-4 的症状做成**确定性**复现。
 *         B 组的扰动只改时序、不改应用逻辑，见 docs/code-review 第八节。
 *
 *   P2-5  保存签名的锁设置过晚
 *         SignaturePadDialog.vue 原先在 await cropToInk()（内部 await toBlob）之后才置
 *         isSaving。这段窗口里 canSave 仍为真、handleClose 仍放行，于是可以重复点保存
 *         （写两条），也可以在保存途中点取消把窗口关掉、签名照样存进去。
 *
 * 断言都带区分力对照：每条 detail 写明「旧实现会报什么」，数字本身就能区分新旧。
 * 对照组用 p3-control.mjs 把根因临时回退成旧写法再跑一遍本探针。
 *
 * 用法：node p3-verify.mjs [thumb|save|all]
 */
import { mkdir } from "node:fs/promises";
import { chromium, launchOptions, APP, FIX, OUT_ROOT } from "../../support/browser.mjs";

const OUT = OUT_ROOT;
/** B 组把观察器回调投递延后这么多毫秒，模拟「染步被推迟到 stale 渲染之后」。 */
const IO_DELAY = 400;
/** 保存锁的探针需要把 toBlob 的窗口拉长到可观测：默认实现只有几毫秒，点不进去。 */
const TO_BLOB_DELAY = 600;

const only = (process.argv[2] ?? "all").toLowerCase();
const runThumb = only === "all" || only === "thumb";
const runSave = only === "all" || only === "save";

await mkdir(OUT, { recursive: true });

const results = [];
function check(id, ok, detail = "") {
  results.push({ id, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}\n        ${detail}`);
}

// ---------- 通用辅助 ----------

async function openApp(page) {
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-testid=toolbar]");
}

async function handleConfirmDialog(page, action, timeout = 1200) {
  const dialog = page.locator("[data-testid=confirm-dialog]");
  const appeared = await dialog
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    return false;
  }
  await dialog.getByRole("button", { name: action, exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 6000 }).catch(() => {});
  return true;
}

async function openPdf(page, fileName, expectedPages) {
  await page.locator("[data-testid=toolbar] input[type=file]").setInputFiles(`${FIX}/${fileName}`);
  await handleConfirmDialog(page, "放弃并打开");
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

/** 等第一屏缩略图真正画上去。 */
async function waitForThumbs(page) {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("[data-testid=thumb-item]")].some((item) => {
        const canvas = item.querySelector("canvas");
        return canvas.width > 1 && canvas.height > 1;
      }),
    null,
    { timeout: 30000 },
  );
  await page.waitForTimeout(900);
}

const GLYPH_R = [
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
];

async function drawR(page) {
  const box = await page.locator("[data-testid=signature-pad-canvas]").boundingBox();
  for (const stroke of GLYPH_R) {
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

/**
 * 库内条目数。
 * 产品已移除签名名称输入，`library-item-name` 节点随之消失，条目身份只能靠数量判断。
 */
async function libraryItemCount(page) {
  return await page.locator("[data-testid=library-item]").count();
}

/**
 * 读取缩略图面板状态。
 * 刻意用「画布像素的 alpha 占比」判断是否画上去了，而不是只看 width：
 * 旧实现把新文档的内容写进了**已移除**的旧画布，新画布连 width 都停在默认 300x150，
 * 于是 width 与 alpha 是两个互相独立的信号，任何一个为负都算失败。
 */
async function readThumbs(page, { scrollTo = null } = {}) {
  return await page.evaluate(async (scrollToArg) => {
    // App 里还有一个签名库 <aside>，这里按「包含缩略图项」定位，避免取错滚动容器。
    const aside = document.querySelector("[data-testid=thumb-item]")?.closest("aside");
    if (!aside) {
      return {
        total: 0,
        inView: [],
        drawnInView: 0,
        blankInView: [],
        defaultSizedInView: 0,
        drawnTotal: 0,
      };
    }
    if (scrollToArg === "top") {
      aside.scrollTop = 0;
    } else if (scrollToArg === "bottom") {
      aside.scrollTop = aside.scrollHeight;
    }
    if (scrollToArg) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    const asideRect = aside.getBoundingClientRect();
    const items = [...aside.querySelectorAll("[data-testid=thumb-item]")];
    const list = [];
    for (const item of items) {
      const canvas = item.querySelector("canvas");
      const rect = item.getBoundingClientRect();
      const inView = rect.bottom > asideRect.top + 1 && rect.top < asideRect.bottom - 1;
      let opaque = 0;
      let total = 0;
      if (canvas.width > 1 && canvas.height > 1) {
        const context = canvas.getContext("2d");
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let y = 0; y < canvas.height; y += 2) {
          for (let x = 0; x < canvas.width; x += 2) {
            total += 1;
            if (data[(y * canvas.width + x) * 4 + 3] > 0) {
              opaque += 1;
            }
          }
        }
      }
      list.push({
        index: Number(item.dataset.thumbIndex),
        inView,
        width: canvas.width,
        height: canvas.height,
        alpha: total > 0 ? opaque / total : 0,
      });
    }
    return {
      total: list.length,
      inView: list.filter((entry) => entry.inView),
      drawnInView: list.filter((entry) => entry.inView && entry.alpha > 0.5).length,
      blankInView: list
        .filter((entry) => entry.inView && entry.alpha <= 0.5)
        .map((entry) => entry.index),
      defaultSized: list.filter((entry) => entry.width === 300 && entry.height === 150).length,
      defaultSizedInView: list.filter(
        (entry) => entry.inView && entry.width === 300 && entry.height === 150,
      ).length,
      drawnTotal: list.filter((entry) => entry.alpha > 0.5).length,
    };
  }, scrollTo);
}

function summarize(view) {
  const indices = view.inView.map((entry) => entry.index);
  return `可见 ${view.inView.length} 项（页码 ${indices[0]}–${indices[indices.length - 1]}），已绘制 ${view.drawnInView} 项，空白 ${JSON.stringify(view.blankInView)}，可见项中仍是默认 300x150 的 ${view.defaultSizedInView} 个，全量已绘制 ${view.drawnTotal}/${view.total}`;
}

/** 给当前所有缩略图画布打标记，用于确认切换后节点确实被替换。 */
async function markThumbCanvases(page) {
  return await page.evaluate(() => {
    const canvases = [...document.querySelectorAll("[data-testid=thumb-canvas]")];
    for (const canvas of canvases) {
      canvas.dataset.probeMark = "old";
    }
    return canvases.length;
  });
}

// ---------- P2-4 A 组：常规前台切换 ----------

async function verifyThumbnails(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  await openApp(page);
  await openPdf(page, "heavy-text-40p.pdf", 40);
  await waitForThumbs(page);

  const before = await readThumbs(page);
  check(
    "P2-4a 基线：切换前可见缩略图全部已绘制",
    before.inView.length >= 4 && before.drawnInView === before.inView.length,
    `${summarize(before)}（基线必须先成立，否则后面的失败无法归因到切换）`,
  );

  const markedBefore = await markThumbCanvases(page);
  // 换成页数更多的文档：切换后绝大多数缩略图都落在面板可视区之外。
  await openPdf(page, "book-100p.pdf", 100);
  await page.waitForTimeout(1200);

  const after = await readThumbs(page);
  const markedAfter = await page.locator("[data-testid=thumb-canvas][data-probe-mark=old]").count();
  check(
    "P2-4b 前台切换后可见缩略图全部已绘制",
    after.inView.length >= 4 && after.drawnInView === after.inView.length,
    `${summarize(after)}（守护项：旧实现在这条路径上也能过——观察器首帧回调与 DOM 补丁落在同一染步，实测只比 stale 渲染晚 2—5ms，会把 stale 任务取消掉。区分力在 P2-4g/h/i）`,
  );
  check(
    "P2-4c 前置条件：切换后画布节点确已被替换",
    markedBefore >= 4 && markedAfter === 0,
    `切换前带标记的画布 ${markedBefore} 个，切换后残留 ${markedAfter} 个（旧实现同样满足：正因节点被换掉，pre-flush 时抓到的引用必然过期）`,
  );

  const scrolled = await readThumbs(page, { scrollTo: "bottom" });
  check(
    "P2-4d 滚动到面板底部后，新进入视野的缩略图已绘制",
    scrolled.inView.length >= 3 && scrolled.drawnInView === scrolled.inView.length,
    `${summarize(scrolled)}（守护项：旧实现同样过——这些页的 stale 任务早被首帧回调取消，滚入视野时是首次渲染）`,
  );
  check(
    "P2-4e 可见项没有画布停留在默认 300x150",
    after.defaultSizedInView === 0 && scrolled.defaultSizedInView === 0,
    `切换后可见项中默认尺寸画布 ${after.defaultSizedInView} 个，滚到底后 ${scrolled.defaultSizedInView} 个（旧实现的失败形态见 P2-4i：8 个可见项全部停在 300x150）`,
  );
  check(
    "P2-4f 切换过程无控制台报错",
    consoleErrors.length === 0,
    consoleErrors.length === 0
      ? "无 console.error"
      : `出现 ${JSON.stringify(consoleErrors.slice(0, 3))}`,
  );

  await page.screenshot({ path: `${OUT}/P2-4-thumbs-after-switch.png` });
  await context.close();
}

// ---------- P2-4 B 组：把染步推迟，症状确定性复现 ----------

async function verifyThumbnailsDeferred(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  // 只推迟回调投递，不改应用逻辑：等价于「这一帧的染步被拖后」。
  await context.addInitScript(() => {
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

  const page = await context.newPage();
  await openApp(page);
  await openPdf(page, "heavy-text-40p.pdf", 40);
  await waitForThumbs(page);

  // 布下「旧画布被改写」的探针：canvas.width = n 会反映到 width 属性上，可被观察到。
  const setup = await page.evaluate(
    ({ delay }) => {
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
            index: window.__probeOldCanvases.indexOf(record.target),
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
    },
    { delay: IO_DELAY },
  );

  await openPdf(page, "dot-40p.pdf", 40);
  // 等扰动后的回调真正投递并完成渲染。
  await page.waitForTimeout(IO_DELAY + 1200);

  const state = await page.evaluate(() => ({
    switchAt: window.__probeSwitchAt,
    deliveries: window.__probeDeliveries,
    writeCount: window.__probeCanvasWrites.length,
    detachedWrites: window.__probeCanvasWrites.filter((record) => record.detached).length,
    firstWriteAt: window.__probeCanvasWrites[0]
      ? window.__probeCanvasWrites[0].t - window.__probeSwitchAt
      : null,
  }));
  const thumbs = await readThumbs(page);
  const firstDelivery = state.deliveries[0];
  const deferral = firstDelivery ? (firstDelivery.ranAt ?? 0) - firstDelivery.scheduledAt : 0;

  check(
    "P2-4g 扰动生效：观察器回调确实被推迟到 stale 渲染之后",
    Boolean(firstDelivery) &&
      firstDelivery.delay === IO_DELAY &&
      deferral >= IO_DELAY - 50 &&
      setup.painted === setup.oldCanvases,
    `切换前 ${setup.oldCanvases} 个旧画布（已设尺寸 ${setup.painted} 个）；首帧回调计划于 +${firstDelivery ? firstDelivery.scheduledAt.toFixed(1) : "?"}ms（相对切换），实际投递 +${firstDelivery ? firstDelivery.ranAt.toFixed(1) : "?"}ms，推迟 ${deferral.toFixed(0)}ms（无扰动时实测只晚 2—5ms，来不及让 stale 渲染跑完）`,
  );
  check(
    "P2-4h 切换时旧画布没有被新文档的渲染改写",
    state.detachedWrites === 0,
    `旧画布尺寸属性被改写 ${state.writeCount} 次（其中 detached=${state.detachedWrites}）${state.firstWriteAt === null ? "" : `，首次在 +${state.firstWriteAt.toFixed(1)}ms`}（旧实现：切换后立即用**新文档编号**把内容画进这批**已从 DOM 移除**的画布，实测 40 个画布共 80 次 width/height 改写，全部 detached=true；这正是 renderedKeys 被写脏、新画布永久跳过渲染的根因）`,
  );
  check(
    "P2-4i 染步被推迟时，可见缩略图依然全部已绘制",
    thumbs.inView.length >= 4 &&
      thumbs.drawnInView === thumbs.inView.length &&
      thumbs.defaultSizedInView === 0,
    `${summarize(thumbs)}（旧实现：8 个可见项全部空白、尺寸停在默认 300x150，且不会自愈——因为缓存里已经写着「这页渲染过了」）`,
  );

  await page.screenshot({ path: `${OUT}/P2-4-deferred-frame.png` });
  await context.close();
}

// ---------- P2-5 保存锁 ----------

async function verifySaveLock(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  // 把 toBlob 的回调延后，制造一个确定可点的「保存中」窗口。
  await context.addInitScript(() => {
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
  const page = await context.newPage();
  await openApp(page);
  await openPdf(page, "plain.pdf", 2);

  await page
    .locator("[data-testid=signature-library]")
    .getByRole("button", { name: "新建签名" })
    .first()
    .click();
  await page.waitForSelector("[data-testid=signature-pad-canvas]");
  await page.waitForTimeout(260);
  await drawR(page);
  await page.evaluate((delay) => {
    window.__toBlobDelay = delay;
  }, TO_BLOB_DELAY);

  const saveButton = page
    .locator("[data-testid=signature-pad-dialog]")
    .getByRole("button", { name: /保存到签名库|保存中/ });
  const before = await libraryItemCount(page);
  await saveButton.click();

  // 同一个 evaluate 里完成「读状态 → 再点保存 → 点取消 → 等一帧再读弹窗」，
  // 避免 Playwright 往返把动作甩出窗口。
  const inWindow = await page.evaluate(async () => {
    const dialog = document.querySelector("[data-testid=signature-pad-dialog]");
    const buttons = [...dialog.querySelectorAll("button")];
    const save = buttons.find((button) => /保存到签名库|保存中/.test(button.textContent ?? ""));
    const cancel = buttons.find((button) => (button.textContent ?? "").trim() === "取消");
    const snapshot = {
      disabled: save.disabled,
      label: (save.textContent ?? "").trim(),
      saveButtonFound: Boolean(save),
      cancelButtonFound: Boolean(cancel),
    };
    save.click();
    cancel.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    snapshot.dialogOpenAfterCancel = Boolean(
      document.querySelector("[data-testid=signature-pad-dialog]"),
    );
    return snapshot;
  });

  check(
    "P2-5a 保存进行中：保存按钮已禁用且文案为「保存中…」",
    inWindow.saveButtonFound &&
      inWindow.cancelButtonFound &&
      inWindow.disabled === true &&
      inWindow.label.includes("保存中"),
    `窗口期内 disabled=${inWindow.disabled}，文案="${inWindow.label}"（旧实现：裁剪完成前 isSaving 仍为 false → disabled=false、文案="保存到签名库"，按钮可以再点一次）`,
  );
  check(
    "P2-5b 保存进行中点「取消」：弹窗不放行",
    inWindow.dialogOpenAfterCancel === true,
    `点取消 80ms 后弹窗仍在=${inWindow.dialogOpenAfterCancel}（旧实现：handleClose 只看 isSaving（当时还是 false）→ 立即 emit close，弹窗关闭=${!inWindow.dialogOpenAfterCancel}，而保存任务继续跑完）`,
  );

  // 等第一次保存真正落地（toBlob 延迟 + IndexedDB 写入），再留出足够时间让窗口期内
  // 可能启动的第二次保存也写完——旧实现的第二条要比第一条晚约一个 toBlob 延迟才落库，
  // 只等一会儿会让「只新增 1 项」因为还没写完而恒真。
  await page
    .locator("[data-testid=signature-pad-dialog]")
    .waitFor({ state: "hidden", timeout: 8000 })
    .catch(() => {});
  await page.waitForTimeout(1800);
  const after = await libraryItemCount(page);
  check(
    "P2-5c 窗口期内重复点击保存：签名库只新增 1 项",
    after - before === 1,
    `库内新增 ${after - before} 项（${before} → ${after}）（旧实现：第二次点击另起一次 cropToInk + saveTemplate → 新增 2 项同名签名）`,
  );

  // 反向对照：只加锁不复位就会把弹窗锁死，这里确认没有过度加锁。
  await page
    .locator("[data-testid=signature-library]")
    .getByRole("button", { name: "新建签名" })
    .first()
    .click();
  await page.waitForSelector("[data-testid=signature-pad-canvas]");
  await page.waitForTimeout(200);
  const reopened = await page.evaluate(() => {
    const dialog = document.querySelector("[data-testid=signature-pad-dialog]");
    const buttons = [...dialog.querySelectorAll("button")];
    const save = buttons.find((button) => /保存到签名库|保存中/.test(button.textContent ?? ""));
    return { label: (save.textContent ?? "").trim() };
  });
  await page
    .locator("[data-testid=signature-pad-dialog]")
    .getByRole("button", { name: "取消" })
    .click();
  const closed = await page
    .locator("[data-testid=signature-pad-dialog]")
    .waitFor({ state: "hidden", timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  check(
    "P2-5d 保存成功后状态复位：重开弹窗按钮不再卡在「保存中…」",
    reopened.label.includes("保存到签名库") && closed,
    `重开后按钮文案="${reopened.label}"，取消可关闭=${closed}（若只在成功路径置回 isSaving、或漏掉 finally，这里会永久停在「保存中…」且无法关闭）`,
  );

  await context.close();
}

// ---------- 主流程 ----------

const browser = await chromium.launch(launchOptions({ headless: true }));
try {
  if (runThumb) {
    await verifyThumbnails(browser);
    await verifyThumbnailsDeferred(browser);
  }
  if (runSave) {
    await verifySaveLock(browser);
  }
} finally {
  await browser.close();
}

const passed = results.filter((item) => item.ok).length;
console.log(`\n汇总：${passed}/${results.length} 项通过`);
for (const item of results.filter((entry) => !entry.ok)) {
  console.log(`  失败 ${item.id}: ${item.detail}`);
}
process.exitCode = passed === results.length ? 0 : 1;
