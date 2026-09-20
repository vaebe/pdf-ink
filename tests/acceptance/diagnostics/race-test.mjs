import { chromium, launchOptions, APP, FIX } from "../harness.mjs";
const BASE = APP;
const FX = FIX;
const SIGNED = `${FX}/sig-field-signed.pdf`;
const PLAIN = `${FX}/plain.pdf`;

const log = (...a) => console.log(...a);

async function snap(page, label) {
  const data = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const dialog = q("[data-testid=confirm-dialog]");
    const openBtn = [...document.querySelectorAll("[data-testid=toolbar] button")].find(
      (b) => b.textContent.includes("打开 PDF") || b.textContent.includes("正在打开"),
    );
    const banner = q("[data-testid=banner]");
    const lib = q("[data-testid=signature-library]");
    // what element is on top at center of the 新建签名 button
    let topAtLib = null;
    let libBtnBlocked = null;
    if (lib) {
      const btn = [...lib.querySelectorAll("button")].find(
        (b) => b.textContent.trim() === "新建签名",
      );
      if (btn) {
        const r = btn.getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        topAtLib = el ? el.getAttribute("data-testid") || el.tagName : null;
        libBtnBlocked = !(el === btn || btn.contains(el) || el === null);
      }
    }
    return {
      confirmVisible: !!dialog,
      confirmTitle: dialog ? q("[data-testid=confirm-title]")?.textContent?.trim() : null,
      confirmActions: dialog
        ? [...q("[data-testid=confirm-actions]").querySelectorAll("button")].map((b) =>
            b.textContent.trim(),
          )
        : null,
      fileName: q("[data-testid=file-name]")?.textContent?.trim(),
      openBtnText: openBtn ? openBtn.textContent.trim() : null,
      openBtnDisabled: openBtn ? openBtn.disabled : null,
      bannerTone: banner ? banner.getAttribute("data-tone") : null,
      bannerText: banner ? banner.textContent.trim().slice(0, 40) : null,
      zoom: q("[data-testid=zoom-level]")?.textContent?.trim(),
      libVisible: !!lib,
      libBtnBlocked,
      topAtLib,
    };
  });
  log(`\n=== ${label} ===`);
  log(JSON.stringify(data, null, 2));
  return data;
}

async function openFile(page, path) {
  await page.locator("[data-testid=toolbar] input[type=file]").setInputFiles(path);
}

async function waitConfirm(page, titleIncludes) {
  await page.locator("[data-testid=confirm-dialog]").waitFor({ state: "visible", timeout: 8000 });
  if (titleIncludes) {
    await page
      .locator("[data-testid=confirm-title]")
      .filter({ hasText: titleIncludes })
      .waitFor({ timeout: 8000 });
  }
}

async function clickConfirmBtn(page, label) {
  await page.locator("[data-testid=confirm-actions]").getByText(label, { exact: true }).click();
}

async function placeSignature(page) {
  await page
    .locator("[data-testid=signature-library]")
    .getByText("新建签名", { exact: true })
    .click();
  await page.locator("[data-testid=signature-pad-dialog]").waitFor({ state: "visible" });
  const box = await page.locator("[data-testid=signature-pad-canvas]").boundingBox();
  const c = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  for (const [a, b] of [
    [
      [0.2, 0.6],
      [0.4, 0.3],
    ],
    [
      [0.4, 0.3],
      [0.6, 0.6],
    ],
    [
      [0.6, 0.6],
      [0.8, 0.3],
    ],
  ]) {
    const p1 = c(...a),
      p2 = c(...b);
    await page.mouse.move(p1.x, p1.y);
    await page.mouse.down();
    await page.mouse.move((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, { steps: 8 });
    await page.mouse.move(p2.x, p2.y, { steps: 8 });
    await page.mouse.up();
  }
  await page.getByText("保存到签名库", { exact: true }).click();
  await page
    .locator("[data-testid=signature-pad-dialog]")
    .waitFor({ state: "detached", timeout: 8000 });
  await page.locator("[data-testid=library-item-pick]").first().click();
  const sb = await page.locator("[data-testid=pdf-scroller]").boundingBox();
  await page.mouse.click(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.waitForTimeout(300);
}

(async () => {
  const browser = await chromium.launch(
    launchOptions({
      headless: true,
    }),
  );
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("CONSOLE: " + m.text());
  });

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });

  // ---------- SCENARIO 1 ----------
  log("\n########## SCENARIO 1 ##########");
  await openFile(page, SIGNED);
  await waitConfirm(page, "该 PDF 已包含数字签名");
  await snap(page, "S1.0 打开已签名文档后, 确认框出现");
  // S1d: 打开按钮是否可点
  // 不关闭对话框, 直接打开 plain.pdf
  await openFile(page, PLAIN);
  await page
    .locator("[data-testid=file-name]")
    .filter({ hasText: "plain.pdf" })
    .waitFor({ timeout: 8000 });
  await page.waitForTimeout(400);
  await snap(page, "S1.1 plain.pdf 加载完成后 (file-name=plain.pdf)");
  // S1b: 探测签名库新建按钮是否被遮罩拦截
  // S1c: 点击"仍然编辑"
  await clickConfirmBtn(page, "仍然编辑");
  await page.waitForTimeout(500);
  await snap(page, 'S1.2 点击"仍然编辑"之后');
  // 再点一次取消 (此时对话框应已消失)
  const dlgAfter = await page.locator("[data-testid=confirm-dialog]").count();
  log(`\n=== S1.3 点击"仍然编辑"后 confirm-dialog 数量 ===`);
  log(JSON.stringify({ dialogCount: dlgAfter }));

  // ---------- SCENARIO 2 ----------
  log("\n########## SCENARIO 2 ##########");
  await page
    .locator("[data-testid=banner] button")
    .click()
    .catch(() => {});
  // 先打开 plain.pdf 并放置签名
  await openFile(page, PLAIN);
  await page
    .locator("[data-testid=file-name]")
    .filter({ hasText: "plain.pdf" })
    .waitFor({ timeout: 8000 });
  await page.waitForTimeout(300);
  await placeSignature(page);
  await snap(page, "S2.0 plain.pdf 已打开并放置签名");
  await openFile(page, SIGNED);
  await waitConfirm(page, "放弃当前编辑");
  await snap(page, 'S2.1 弹"放弃当前编辑？"');
  await clickConfirmBtn(page, "放弃并打开");
  await waitConfirm(page, "该 PDF 已包含数字签名");
  await snap(page, 'S2.2 顺序弹出"该 PDF 已包含数字签名"');
  await clickConfirmBtn(page, "仍然编辑");
  await page
    .locator("[data-testid=file-name]")
    .filter({ hasText: "sig-field-signed.pdf" })
    .waitFor({ timeout: 8000 });
  await page.waitForTimeout(400);
  await snap(page, 'S2.3 点击"仍然编辑"后完成打开');

  // ---------- SCENARIO 3 ----------
  log("\n########## SCENARIO 3 ##########");
  // 当前已是 signed 会话; 重新打开一个新(另一个) signed 文件前先清空会话不现实,
  // 直接: 打开 signed A -> 对话框A挂着 -> 再打开 signed B
  // 为制造"对话框A挂着"状态, 先退回空(不可行). 改为: 直接连续打开两次 signed.
  await openFile(page, SIGNED); // A
  await waitConfirm(page, "该 PDF 已包含数字签名");
  await snap(page, "S3.0 对话框A (sig-field-signed.pdf) 挂着");
  await openFile(page, SIGNED); // B 另一个相同文件
  await page.waitForTimeout(500);
  await snap(page, 'S3.1 在A挂着时再打开"另一个" signed');
  // 验证确认对话框数量(应=1, 非堆叠)
  const cnt = await page.locator("[data-testid=confirm-dialog]").count();
  log(`\n=== S3.2 confirm-dialog 数量(期望1) ===`);
  log(JSON.stringify({ dialogCount: cnt }));
  await clickConfirmBtn(page, "仍然编辑");
  await page.waitForTimeout(400);
  await snap(page, 'S3.3 点击"仍然编辑"后');

  log("\n########## ERRORS ##########");
  log(errors.length ? errors.join("\n") : "(no console/page errors)");

  await browser.close();
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
