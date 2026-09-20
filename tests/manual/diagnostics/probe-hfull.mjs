import { chromium, launchOptions, APP } from "../../support/browser.mjs";
const browser = await chromium.launch(launchOptions({}));
const page = await browser.newPage({ viewport: { width: 1080, height: 680 } });
await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="toolbar"]');

const info = await page.evaluate(() => {
  const root = document.getElementById("app").firstElementChild;
  const found = [];
  for (const sheet of document.styleSheets) {
    let list;
    try {
      list = sheet.cssRules;
    } catch {
      continue;
    }
    const walk = (rules, prefix) => {
      for (const rule of rules) {
        if (rule.cssRules) {
          walk(
            rule.cssRules,
            `${prefix}${rule.conditionText ?? rule.name ?? rule.cssText.slice(0, 24)} > `,
          );
          continue;
        }
        if (rule.selectorText && /\.h-full|\.min-h-0/.test(rule.selectorText)) {
          found.push(`${prefix}${rule.cssText.slice(0, 160)}`);
        }
      }
    };
    walk(list, "");
  }
  return {
    className: root.className,
    computedDisplay: getComputedStyle(root).display,
    computedHeight: getComputedStyle(root).height,
    matches: root.matches(".h-full"),
    found,
  };
});

console.log(JSON.stringify(info, null, 2));
await browser.close();
