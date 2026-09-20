import { chromium, launchOptions, APP } from "../../support/browser.mjs";
const browser = await chromium.launch(launchOptions({}));
const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="toolbar"]');

// 直接在页面里造一个同时带 border-line / border-accent 的元素，看谁生效。
const cascade = await page.evaluate(() => {
  const probe = document.createElement("div");
  probe.className = "border border-line border-accent bg-subtle bg-accent-soft";
  document.body.append(probe);
  const s = getComputedStyle(probe);
  const indexOf = (selector) => {
    let index = -1;
    let counter = 0;
    for (const sheet of document.styleSheets) {
      let list;
      try {
        list = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of list) {
        const text = rule.cssText ?? "";
        counter += 1;
        const match = text.match(/(^|[^{,]*)(\.[a-z-]+)\s*\{/g);
        if (match && match.some((m) => m.includes(selector))) index = counter;
      }
    }
    return index;
  };
  return {
    borderColor: s.borderTopColor,
    background: s.backgroundColor,
    indexBorderAccent: indexOf(".border-accent"),
    indexBorderLine: indexOf(".border-line"),
  };
});
console.log(JSON.stringify(cascade, null, 2));

// 打印真实顺序：把两层 utility 规则的位置找出来
const order = await page.evaluate(() => {
  const found = [];
  for (const sheet of document.styleSheets) {
    let list;
    try {
      list = sheet.cssRules;
    } catch {
      continue;
    }
    list.forEach((rule, i) => {
      const t = rule.cssText ?? "";
      if (
        /^\.(border-accent|border-line|bg-accent-soft|bg-subtle|border-accent-strong)\s*\{/.test(t)
      ) {
        found.push({ index: i, rule: t.slice(0, 60) });
      }
    });
  }
  return found;
});
console.log(order);
await browser.close();
