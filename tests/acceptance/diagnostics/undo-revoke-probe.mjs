import { chromium, launchOptions, APP, FIX } from "../harness.mjs";

const BASE = APP;

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch(
  launchOptions({
    headless: true,
    args: ["--no-sandbox"],
  }),
);
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console:" + m.text());
});

const report = { steps: [], conclusion: null };

async function gatherImgs() {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-testid=placement] img")).map((img) => ({
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      currentSrc: img.currentSrc || "",
      isBlob: (img.currentSrc || "").startsWith("blob:"),
    })),
  );
}

async function fetchStatus(src) {
  if (!src) return "no-src";
  try {
    const r = await page.evaluate(async (s) => {
      const resp = await fetch(s);
      return resp.status;
    }, src);
    return r;
  } catch (e) {
    return "rejected:" + (e && e.message ? e.message : String(e));
  }
}

async function placementCount() {
  return page.locator("[data-testid=placement]").count();
}

async function createSignature() {
  await page.locator("[data-testid=signature-library] button", { hasText: "新建签名" }).click();
  await page.waitForSelector("[data-testid=signature-pad-dialog]", { timeout: 10000 });
  await sleep(450); // let panel-in animation settle + pad init
  const box = await page.locator("[data-testid=signature-pad-canvas]").boundingBox();
  const cx = box.x + box.width * 0.5;
  const cy = box.y + box.height * 0.5;
  await page.mouse.move(cx - 90, cy - 25);
  await page.mouse.down();
  await page.mouse.move(cx - 40, cy + 5, { steps: 6 });
  await page.mouse.move(cx + 10, cy + 35, { steps: 6 });
  await page.mouse.move(cx + 70, cy - 5, { steps: 6 });
  await page.mouse.up();
  await sleep(150);
  await page
    .locator("[data-testid=signature-pad-dialog] button", { hasText: "保存到签名库" })
    .click();
  await page.waitForSelector("[data-testid=signature-pad-dialog]", {
    state: "detached",
    timeout: 10000,
  });
  log("  [createSignature] 签名已保存到签名库");
}

async function openPdf(name) {
  await page.locator("[data-testid=toolbar] input[type=file]").setInputFiles(`${FIX}/${name}`);
  // 处理「放弃当前编辑」确认框（仅在已有未导出签名时出现）
  await sleep(400);
  const cd = page.locator("[data-testid=confirm-dialog]");
  if (await cd.count()) {
    const btn = cd.locator("button", { hasText: "放弃并打开" });
    if (await btn.count()) await btn.click();
    await cd.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  }
  await page.waitForSelector("[data-testid=pdf-scroller]", { timeout: 15000 });
  await page.waitForSelector("[data-testid=library-item-pick]", { timeout: 10000 });
  await sleep(500);
  log(`  [openPdf] 已打开 ${name}`);
}

async function placeAt(fracX, fracY) {
  const sc = await page.locator("[data-testid=pdf-scroller]").boundingBox();
  await page.mouse.click(sc.x + sc.width * fracX, sc.y + sc.height * fracY);
  await sleep(250);
}

async function enterPlacing() {
  const item = page.locator("[data-testid=library-item]", { hasText: "测试签名" });
  await item.locator("[data-testid=library-item-pick]").click();
  await sleep(250);
}

async function placeInstances(n) {
  await enterPlacing();
  const fracs = [
    [0.4, 0.5],
    [0.62, 0.5],
    [0.5, 0.3],
    [0.5, 0.7],
    [0.3, 0.4],
  ];
  for (let i = 0; i < n; i++) {
    const [fx, fy] = fracs[i % fracs.length];
    await placeAt(fx, fy);
  }
  await page.keyboard.press("Escape"); // 退出放置模式
  await sleep(250);
}

async function selectAndDeleteFirst() {
  const before = await placementCount();
  await page.locator("[data-testid=placement]").first().click();
  await page.waitForSelector("[data-testid=placement-delete]", { timeout: 5000 });
  await page.locator("[data-testid=placement-delete]").click();
  await page.waitForFunction(
    (b) => document.querySelectorAll("[data-testid=placement]").length === b - 1,
    before,
    { timeout: 5000 },
  );
  await sleep(200);
}

async function clickUndo() {
  await page.locator("[data-testid=toolbar] button", { hasText: "撤销" }).click();
  await sleep(300);
}
async function clickRedo() {
  await page.locator("[data-testid=toolbar] button", { hasText: "重做" }).click();
  await sleep(300);
}

async function waitImgLoaded(timeout = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const imgs = await gatherImgs();
    const broken = imgs.filter((i) => i.naturalWidth === 0);
    if (imgs.length > 0 && broken.length === 0) return imgs;
    await sleep(150);
  }
  return gatherImgs();
}

try {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-testid=signature-library]", { timeout: 15000 });

  // —— 步骤 1：新建签名 ——
  await createSignature();

  // —— 步骤 2-3：打开 PDF 并放置 2 个实例（同一模板） ——
  await openPdf("plain.pdf");
  await placeInstances(2);
  let imgs = await gatherImgs();
  report.steps.push({ step: "A3-place-2", count: imgs.length, imgs });
  log(`A3 placements=${imgs.length}`, JSON.stringify(imgs.map((i) => i.naturalWidth)));

  // —— 步骤 5：选中实例1并删除 ——
  await selectAndDeleteFirst();
  const afterDel = await placementCount();
  report.steps.push({ step: "A5-delete-1", remaining: afterDel });
  log(`A5 after delete, remaining placements=${afterDel}`);

  // —— 步骤 6：fetch 探测剩余实例(实例2) 的 currentSrc ——
  const remain = await gatherImgs();
  const fs = await fetchStatus(remain[0]?.currentSrc || "");
  report.steps.push({
    step: "A6-fetch-remaining",
    naturalWidth: remain[0]?.naturalWidth,
    currentSrc: remain[0]?.currentSrc,
    fetchStatus: fs,
  });
  log(`A6 fetch remaining instance -> status=${fs}, nw=${remain[0]?.naturalWidth}`);

  // —— 步骤 7：撤销恢复实例1，探测图片是否裂开 ——
  await clickUndo();
  let restored = await waitImgLoaded(2000);
  const brokenAfterUndo = restored.filter((i) => i.naturalWidth === 0).length;
  report.steps.push({
    step: "A7-undo-restore",
    count: restored.length,
    imgs: restored,
    brokenCount: brokenAfterUndo,
  });
  log(
    `A7 after undo, count=${restored.length}, naturalWidths=${JSON.stringify(restored.map((i) => i.naturalWidth))}`,
  );

  // —— 步骤 8：重做/撤销 重复两次，确认稳定 ——
  const stab = [];
  for (let k = 0; k < 2; k++) {
    await clickRedo();
    const afterRedo = await placementCount();
    await clickUndo();
    const afterUndo = await waitImgLoaded(2000);
    stab.push({
      iter: k + 1,
      redoCount: afterRedo,
      undoCount: afterUndo.length,
      undoNaturalWidths: afterUndo.map((i) => i.naturalWidth),
    });
    log(
      `A8 iter${k + 1} redoCount=${afterRedo} undoCount=${afterUndo.length} nw=${JSON.stringify(afterUndo.map((i) => i.naturalWidth))}`,
    );
  }
  report.steps.push({ step: "A8-stability", rounds: stab });

  // —— 场景 B：删除实例1后打开新文档(rotations.pdf)，确认无异常 ——
  await selectAndDeleteFirst(); // 删掉当前第一个（实例1）
  log(`B before open rotations, remaining=${await placementCount()}`);
  await openPdf("rotations.pdf");
  const errBanner = await page.locator('[data-testid=banner][data-tone="error"]').count();
  const pageInd =
    (await page
      .locator("[data-testid=page-indicator]")
      .innerText()
      .catch(() => "")) || "";
  const countB = await placementCount();
  report.steps.push({
    step: "B-open-rotations",
    errorBanner: errBanner,
    pageIndicator: pageInd.replace(/\s+/g, " ").trim(),
    placementsAfterNewDoc: countB,
  });
  log(
    `B rotations opened: errorBanner=${errBanner}, indicator="${pageInd.trim()}", placements=${countB}`,
  );

  // —— 场景 C：undo 栈深度（5 个实例，删全部，连撤 5 次） ——
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("[data-testid=signature-library]", { timeout: 15000 });
  await openPdf("plain.pdf");
  await placeInstances(5);
  let cImgs = await gatherImgs();
  report.steps.push({
    step: "C-place-5",
    count: cImgs.length,
    naturalWidths: cImgs.map((i) => i.naturalWidth),
  });
  log(`C placed 5, count=${cImgs.length}`);

  for (let i = 0; i < 5; i++) {
    await selectAndDeleteFirst();
  }
  const afterDelAll = await placementCount();
  report.steps.push({ step: "C-delete-5", remaining: afterDelAll });
  log(`C after delete all, remaining=${afterDelAll}`);

  const undoDepth = [];
  for (let i = 1; i <= 5; i++) {
    await clickUndo();
    const cur = await waitImgLoaded(2000);
    const broken = cur.filter((x) => x.naturalWidth === 0).length;
    undoDepth.push({
      undoStep: i,
      count: cur.length,
      minNaturalWidth: cur.length ? Math.min(...cur.map((x) => x.naturalWidth)) : 0,
      brokenCount: broken,
    });
    log(
      `C undo#${i} count=${cur.length} minNW=${cur.length ? Math.min(...cur.map((x) => x.naturalWidth)) : 0} broken=${broken}`,
    );
  }
  report.steps.push({ step: "C-undo-depth", rounds: undoDepth });

  // —— 结论 ——
  const brokenFlags = [];
  for (const s of report.steps) {
    if (Array.isArray(s.imgs)) brokenFlags.push(...s.imgs.map((i) => i.naturalWidth));
    if (Array.isArray(s.undoNaturalWidths)) brokenFlags.push(...s.undoNaturalWidths);
    if (Array.isArray(s.naturalWidths)) brokenFlags.push(...s.naturalWidths);
    if (Array.isArray(s.rounds)) {
      for (const r of s.rounds) {
        if (Array.isArray(r.undoNaturalWidths)) brokenFlags.push(...r.undoNaturalWidths);
        if (Array.isArray(r.minNaturalWidth)) brokenFlags.push(r.minNaturalWidth);
        if (typeof r.minNaturalWidth === "number") brokenFlags.push(r.minNaturalWidth);
      }
    }
  }
  const sawZero = brokenFlags.some((nw) => typeof nw === "number" && nw === 0);
  const fetchFailed = report.steps.find((s) => s.step === "A6-fetch-remaining")?.fetchStatus;
  report.conclusion = {
    prematureRevoke:
      sawZero || (typeof fetchFailed === "string" && fetchFailed.startsWith("rejected")),
    sawZeroNaturalWidth: sawZero,
    fetchRemainingStatus: fetchFailed,
    pageErrors: errors.slice(0, 5),
  };
  log("\n===== CONCLUSION =====");
  log(JSON.stringify(report.conclusion, null, 2));
} catch (e) {
  log("FATAL", e);
  report.fatal = String(e);
  report.pageErrors = errors.slice(0, 10);
} finally {
  await browser.close();
  log("\n===== FULL REPORT =====");
  log(JSON.stringify(report, null, 2));
}
