import { chromium, launchOptions, APP } from "../../support/browser.mjs";
const browser = await chromium.launch(launchOptions({ headless: true }));
const page = await browser.newPage();
await page.goto(APP, { waitUntil: "domcontentloaded" });
console.log("title:", await page.title());
console.log("body text:", (await page.locator("body").innerText()).slice(0, 300));
await browser.close();
console.log("probe ok");
