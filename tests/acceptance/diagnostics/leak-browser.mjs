// 任务 B：浏览器侧确认 PDF.js worker 泄漏。
// 用 Node 22 + playwright-core + 指定 Chrome 运行，只读，不修改项目。

import { chromium, launchOptions, APP, FIX } from "../harness.mjs";
const BASE = APP;
const TRIGGER = `${FIX}/trigger.pdf`;
const PLAIN = `${FIX}/plain.pdf`;

const workers = (page) => page.workers().length;

async function openFile(page, path) {
  await page.locator("[data-testid=toolbar] input[type=file]").setInputFiles(path);
}

async function main() {
  const browser = await chromium.launch(
    launchOptions({
      headless: true,
    }),
  );
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 100));
  });

  await page.goto(BASE, { waitUntil: "networkidle" });

  const seq = [];
  const baseline = workers(page);
  seq.push({ step: "baseline", workers: baseline });
  console.log("baseline workers =", baseline);

  for (let i = 1; i <= 3; i++) {
    // 失败打开触发文件
    await openFile(page, TRIGGER);
    await page
      .waitForSelector("[data-testid=banner][data-tone=error]", { timeout: 8000 })
      .catch(() => console.log(`  第${i}次: 未检测到错误banner`));
    await page.waitForTimeout(3200); // >3s 观察遗留
    const afterFail = workers(page);
    seq.push({ step: `fail#${i}`, workers: afterFail });
    console.log(`fail#${i}: workers after fail =`, afterFail);

    // 成功打开 plain.pdf
    await openFile(page, PLAIN);
    await page
      .waitForSelector('[data-testid=file-name]:has-text("plain.pdf")', { timeout: 8000 })
      .catch(() => console.log(`  第${i}次: plain.pdf 未成功加载`));
    await page.waitForTimeout(1500);
    const afterSuccess = workers(page);
    seq.push({ step: `success#${i}`, workers: afterSuccess });
    console.log(`success#${i}: workers after success =`, afterSuccess);
  }

  console.log("\n序列(baseline→fail→success…):");
  console.log(seq.map((s) => `${s.step}=${s.workers}`).join("  "));
  console.log("\nconsole errors(截断):", consoleErrors.slice(0, 6));

  const fails = seq.filter((s) => s.step.startsWith("fail"));
  const growth = fails.map((f) => f.workers - baseline);
  console.log("每次失败后相对基线增量:", growth.join(", "));

  await browser.close();
}

await main();
