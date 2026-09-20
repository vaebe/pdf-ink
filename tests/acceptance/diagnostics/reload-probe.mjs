/*
 * 探针：开发服务器会不会因为「非模块图内的文件被写入」而触发整页重载？
 *
 * 动机：验收脚本 A2-2 会在页面里给 IDBObjectStore.prototype.put 打补丁，
 * 一旦中途发生整页重载，补丁丢失 → 保存反而成功/弹窗消失，脚本以超时崩溃。
 * 需要确认这是调试期的外部干扰，而不是产品缺陷。
 */
import { appendFile } from "node:fs/promises";
import { chromium, launchOptions, APP, REPO_ROOT } from "../harness.mjs";
import { join } from "node:path";

const browser = await chromium.launch(launchOptions({ headless: true }));
const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await context.newPage();

let loads = 0;
let navigations = 0;
page.on("load", () => {
  loads += 1;
});
page.on("framenavigated", (frame) => {
  if (frame === page.mainFrame()) {
    navigations += 1;
  }
});

await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-testid=toolbar]");
await page.evaluate(() => {
  window.__marker = "alive";
});

const probe = async (label, mutate) => {
  const before = { loads, navigations };
  await page.evaluate(() => {
    window.__marker = "alive";
  });
  await mutate();
  await page.waitForTimeout(2500);
  const marker = await page
    .evaluate(() => window.__marker ?? "(已丢失)")
    .catch(() => "(页面不可用)");
  console.log(
    `${label}: load 事件 +${loads - before.loads}，导航 +${navigations - before.navigations}，标记=${marker}`,
  );
};

await probe("写入 docs/acceptance/README.md（非模块图）", () =>
  appendFile(join(REPO_ROOT, "docs/acceptance/README.md"), "\n"),
);
await probe("写入 docs/implementation-report.md（非模块图）", () =>
  appendFile(join(REPO_ROOT, "docs/implementation-report.md"), "\n"),
);
await probe("写入仓库根 README.md（非模块图）", () =>
  appendFile(join(REPO_ROOT, "README.md"), "\n"),
);
await probe("写入 .workbuddy/memory 下的文件", () =>
  appendFile(join(REPO_ROOT, ".workbuddy/memory/2026-09-20.md"), "\n"),
);

await browser.close();
