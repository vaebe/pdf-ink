import { chromium, launchOptions, APP, FIX } from "../../support/browser.mjs";
const URL = APP;
const PDF = `${FIX}/plain.pdf`;

const browser = await chromium.launch(launchOptions({ headless: true }));

async function openWith(w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: "networkidle" });
  const fileInput = page.locator("[data-testid=toolbar] input[type=file]");
  await fileInput.setInputFiles(PDF);
  await page.locator("[data-testid=file-name]").waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
  return { ctx, page };
}

async function zoomText(page) {
  return (await page.locator("[data-testid=zoom-level]").innerText()).trim();
}

const results = [];
function log(s) {
  results.push(s);
  console.log(s);
}

// Scenario 1: 1280x800 normal
{
  const { ctx, page } = await openWith(1280, 800);
  const before = await zoomText(page);
  await page.locator('button[title="放大"]').click();
  await page.waitForTimeout(400);
  const afterIn = await zoomText(page);
  await page.locator('button[title="缩小"]').click();
  await page.waitForTimeout(400);
  const afterOut = await zoomText(page);
  log(`S1 1280x800: before=${before} afterZoomIn=${afterIn} afterZoomOut=${afterOut}`);
  await ctx.close();
}

// Scenario 2: 3600x1000 wide -> effectiveScale>4
{
  const { ctx, page } = await openWith(3600, 1000);
  const before = await zoomText(page);
  await page.locator('button[title="放大"]').click();
  await page.waitForTimeout(400);
  const afterIn = await zoomText(page);
  // click again
  await page.locator('button[title="放大"]').click();
  await page.waitForTimeout(400);
  const afterIn2 = await zoomText(page);
  log(`S2 3600x1000: before=${before} afterZoomIn=${afterIn} afterZoomIn2=${afterIn2}`);
  // click 自适应宽度 to recover
  try {
    await page.getByText("自适应宽度", { exact: true }).click();
    await page.waitForTimeout(400);
    const afterFit = await zoomText(page);
    log(`S2 fit-width recover: afterFit=${afterFit}`);
  } catch (e) {
    log(`S2 fit-width click failed: ${e.message}`);
  }
  await ctx.close();
}

// Scenario 3: 480x900 narrow -> effectiveScale<0.4
{
  const { ctx, page } = await openWith(480, 900);
  const before = await zoomText(page);
  await page.locator('button[title="缩小"]').click();
  await page.waitForTimeout(400);
  const afterOut = await zoomText(page);
  log(`S3 480x900: before=${before} afterZoomOut=${afterOut}`);
  await ctx.close();
}

// Scenario 4: 2560x1000 mid
{
  const { ctx, page } = await openWith(2560, 1000);
  const before = await zoomText(page);
  await page.locator('button[title="放大"]').click();
  await page.waitForTimeout(400);
  const afterIn = await zoomText(page);
  await page.locator('button[title="缩小"]').click();
  await page.waitForTimeout(400);
  const afterOut = await zoomText(page);
  log(`S4 2560x1000: before=${before} afterZoomIn=${afterIn} afterZoomOut=${afterOut}`);
  await ctx.close();
}

await browser.close();
console.log("\n=== DONE ===");
