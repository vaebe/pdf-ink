import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PDFDocument, degrees } from "pdf-lib";
import { probePdf, renderPdf } from "../support/pdf";

let output: string;
let sample: string;

// 使用已知数值构造样本，独立检查读回工具的矩阵、CropBox 和旋转坐标。
beforeAll(async () => {
  output = await mkdtemp(join(tmpdir(), "pdf-ink-probe-"));
  sample = join(output, "sample.pdf");
  const document = await PDFDocument.create();
  const page = document.addPage([300, 400]);
  page.setCropBox(10, 20, 180, 260);
  page.setRotation(degrees(90));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAABpAiUmAAAAEklEQVR4nGNgYGD4z4AGGNEFAB0kAQFGc0kfAAAAAElFTkSuQmCC",
    "base64",
  );
  const image = await document.embedPng(png);
  page.drawImage(image, { x: 30, y: 40, width: 24, height: 12 });
  await writeFile(sample, await document.save());
});

afterAll(async () => {
  if (output) await rm(output, { recursive: true, force: true });
});

test("读回图片矩阵、像素尺寸、旋转与原始页面边界", async () => {
  const report = await probePdf(sample);
  expect(report.pageCount).toBe(1);
  expect(report.pages[0].rotate).toBe(90);
  expect(report.pages[0].boxes).toEqual({
    cropbox: [10, 20, 190, 280],
    mediabox: [0, 0, 300, 400],
  });
  expect(report.pages[0].images).toHaveLength(1);
  expect(report.pages[0].images[0]).toMatchObject({
    ctm: [24, 0, 0, 12, 30, 40],
    determinant: 288,
    minCorner: [30, 40],
    maxCorner: [54, 52],
    pixelWidth: 4,
    pixelHeight: 2,
  });
});

test("读回夹具中的可搜索文字和链接 URI", async () => {
  const report = await probePdf(
    fileURLToPath(new URL("../fixtures/text-links.pdf", import.meta.url)),
  );
  expect(report.pages[0].text).toContain("ALPHA-BRAVO-CHARLIE");
  expect(report.pages[0].text).toContain("searchable needle 0123456789");
  expect(
    report.pages[0].annotations.filter((annotation) => annotation.subtype === "/Link"),
  ).toEqual([expect.objectContaining({ uri: "https://example.com/pdfink-a9" })]);
});

test("将旋转后的可见页面渲染为实际 PNG 产物", async () => {
  await renderPdf(sample, output);
  const png = await readFile(join(output, "sample-p1.png"));
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  // 旋转 90 度后，CropBox 的高成为输出宽；默认渲染比例为 1.5。
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([390, 270]);
});
