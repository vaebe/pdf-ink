import { chromium, launchOptions, APP, FIX } from "../harness.mjs";
const URL = APP;
const FX = `${FIX}/`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readState(page) {
  const pageInput = (await page.locator("[data-testid=page-input]").inputValue()).trim();
  const zoom = (await page.locator("[data-testid=zoom-level]").textContent()).trim();
  const scrollTop = await page.locator("[data-testid=pdf-scroller]").evaluate((el) => el.scrollTop);
  const fileName = (await page.locator("[data-testid=file-name]").textContent()).trim();
  const banners = await page
    .locator("[data-testid=banner]")
    .evaluateAll((els) =>
      els.map((e) => ({ tone: e.getAttribute("data-tone"), text: e.textContent.trim() })),
    );
  return { pageInput, zoom, scrollTop, fileName, banners };
}

async function openDoc(page, file) {
  await page.locator("[data-testid=toolbar] input[type=file]").setInputFiles(FX + file);
}

async function setupBook(page) {
  await openDoc(page, "book-100p.pdf");
  await page.waitForFunction(() =>
    document.querySelector("[data-testid=file-name]")?.textContent?.includes("book-100p.pdf"),
  );
  await sleep(600);
  // go to page 30
  await page.locator("[data-testid=page-input]").fill("30");
  await page.locator("[data-testid=page-input]").press("Enter");
  await sleep(600);
  // ensure fit-width is OFF (product default is off now) -> fixed zoom 125%
  const fitBtn = page.locator('button:has-text("自适应宽度")');
  const toggled = await fitBtn.evaluate((el) => el.classList.contains("button--toggled"));
  if (toggled) await fitBtn.click();
  await sleep(300);
}

const log = (label, s) =>
  console.log(
    label,
    JSON.stringify({
      page: s.pageInput,
      zoom: s.zoom,
      scrollTop: s.scrollTop,
      file: s.fileName,
      banners: s.banners,
    }),
  );

async function main() {
  const browser = await chromium.launch(launchOptions({ headless: true }));
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  await page.goto(URL);
  await page.waitForSelector("[data-testid=toolbar]");

  // ---- Scenario A: broken.pdf ----
  await setupBook(page);
  const aBefore = await readState(page);
  log("A_before", aBefore);
  await openDoc(page, "broken.pdf");
  await page.waitForSelector("[data-testid=banner][data-tone=error]", { timeout: 8000 });
  await sleep(500);
  const aAfter = await readState(page);
  log("A_after ", aAfter);

  // ---- Scenario B: signed cancel ----
  await setupBook(page);
  const bBefore = await readState(page);
  log("B_before", bBefore);
  await openDoc(page, "sig-field-signed.pdf");
  await page.waitForSelector("[data-testid=confirm-dialog]", { timeout: 8000 });
  await sleep(300);
  // capture mid-dialog view (already reset before await resolves)
  const bMid = await readState(page);
  log("B_mid   ", bMid);
  await page.locator('[data-testid=confirm-dialog] button:has-text("取消")').click();
  await sleep(500);
  const bAfter = await readState(page);
  log("B_after ", bAfter);

  // ---- Scenario C: control, plain.pdf success ----
  await setupBook(page);
  const cBefore = await readState(page);
  log("C_before", cBefore);
  await openDoc(page, "plain.pdf");
  await page.waitForFunction(
    () => document.querySelector("[data-testid=file-name]")?.textContent?.includes("plain.pdf"),
    { timeout: 8000 },
  );
  await sleep(600);
  const cAfter = await readState(page);
  log("C_after ", cAfter);

  await browser.close();
}
main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
