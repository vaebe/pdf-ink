import { chromium, launchOptions, APP } from "../harness.mjs";
const browser = await chromium.launch(launchOptions({}));
const page = await browser.newPage({ viewport: { width: 1080, height: 680 } });
await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="toolbar"]');

const info = await page.evaluate(() => {
  const h = (el) => (el ? getComputedStyle(el).height : "n/a");
  const rules = [];
  for (const sheet of document.styleSheets) {
    let list;
    try {
      list = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of list) {
      if (rule.cssText && rule.cssText.includes("#app")) rules.push(rule.cssText.slice(0, 200));
    }
  }
  const app = document.getElementById("app");
  return {
    viewportHeight: window.innerHeight,
    htmlHeight: getComputedStyle(document.documentElement).height,
    bodyHeight: h(document.body),
    appHeight: h(app),
    rootHeight: h(app.firstElementChild),
    mainHeight: h(document.querySelector("main")),
    sectionHeight: h(document.querySelector("main > section")),
    appRules: rules,
  };
});

console.log(JSON.stringify(info, null, 2));
await browser.close();
