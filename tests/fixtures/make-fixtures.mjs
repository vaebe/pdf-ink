/**
 * 为 A1—A12 浏览器验收生成合成样本 PDF。
 * 样本全部由 pdf-lib 现场生成，不含任何真实敏感文档。
 * 用法：node --experimental-strip-types make-fixtures.mjs [输出目录]
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, PDFName, PDFString, StandardFonts, degrees, rgb } from "pdf-lib";

const outDir = process.argv[2] ?? import.meta.dirname;
await mkdir(outDir, { recursive: true });

const PAGE_W = 612;
const PAGE_H = 792;

/** 在页面四周画方向标记，便于用独立渲染器判断是否镜像 / 旋转错误。 */
function drawOrientationMarks(page, label, font) {
  const { width, height } = page.getSize();
  const red = rgb(0.85, 0.15, 0.15);
  const blue = rgb(0.15, 0.25, 0.85);

  // 左上角红色方块 + "TL"，右上角蓝色方块 + "TR"
  page.drawRectangle({ x: 24, y: height - 44, width: 40, height: 20, color: red });
  page.drawText("TL", { x: 30, y: height - 38, size: 12, font, color: rgb(1, 1, 1) });
  page.drawRectangle({ x: width - 64, y: height - 44, width: 40, height: 20, color: blue });
  page.drawText("TR", { x: width - 58, y: height - 38, size: 12, font, color: rgb(1, 1, 1) });

  page.drawText(`${label}  w=${width} h=${height}`, {
    x: 24,
    y: height / 2,
    size: 14,
    font,
  });
  page.drawText("bottom-left-anchor", { x: 24, y: 24, size: 9, font });
  // 基线横线，用于判断上下是否颠倒
  page.drawLine({
    start: { x: 24, y: 40 },
    end: { x: width - 24, y: 40 },
    thickness: 1,
    color: rgb(0.5, 0.5, 0.5),
  });
}

async function plain() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= 2; i += 1) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    page.drawText(`PDFInk acceptance sample — page ${i}`, {
      x: 60,
      y: 700,
      size: 20,
      font: bold,
    });
    page.drawText("Selectable text line one for the text layer.", {
      x: 60,
      y: 660,
      size: 12,
      font,
    });
    page.drawText("Selectable text line two for the text layer.", {
      x: 60,
      y: 640,
      size: 12,
      font,
    });
    drawOrientationMarks(page, `page-${i}`, font);
  }
  return doc.save();
}

async function rotations() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const specs = [
    { w: 612, h: 792, rotation: 0, label: "p1-rot0" },
    { w: 612, h: 792, rotation: 90, label: "p2-rot90" },
    { w: 400, h: 300, rotation: 180, label: "p3-rot180" },
    { w: 500, h: 500, rotation: 270, label: "p4-rot270-crop", crop: [50, 60, 450, 460] },
    { w: 842, h: 595, rotation: 0, label: "p5-a4landscape" },
  ];
  for (const spec of specs) {
    const page = doc.addPage([spec.w, spec.h]);
    page.setRotation(degrees(spec.rotation));
    if (spec.crop) {
      page.setCropBox(
        spec.crop[0],
        spec.crop[1],
        spec.crop[2] - spec.crop[0],
        spec.crop[3] - spec.crop[1],
      );
    }
    drawOrientationMarks(page, spec.label, font);
  }
  return doc.save();
}

async function textAndLinks() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([PAGE_W, PAGE_H]);

  page.drawText("Extractable text — A9 fixture", { x: 60, y: 720, size: 20, font: bold });
  const lines = [
    "ALPHA-BRAVO-CHARLIE",
    "searchable needle 0123456789",
    "text layer must survive export",
  ];
  lines.forEach((line, index) => {
    page.drawText(line, { x: 60, y: 680 - index * 22, size: 12, font });
  });

  // 站外链接注解
  const link = doc.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [60, 600, 260, 618],
    Border: [0, 0, 0],
    A: { Type: "Action", S: "URI", URI: PDFString.of("https://example.com/pdfink-a9") },
  });
  page.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(link)]));
  page.drawText("external link target", { x: 60, y: 602, size: 11, font, color: rgb(0, 0, 0.8) });

  drawOrientationMarks(page, "p1-text-links", font);
  return doc.save();
}

async function manyPages(count = 100) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= count; i += 1) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    page.drawText(`page ${i} of ${count}`, { x: 60, y: 700, size: 18, font });
    page.drawText("A11 heavy document performance fixture", { x: 60, y: 670, size: 11, font });
    if (i % 10 === 0) {
      page.drawText(`MARKER-${i}`, { x: 60, y: 400, size: 28, font });
    }
    // 每页加一些矢量内容，让渲染成本更接近真实文档
    for (let k = 0; k < 40; k += 1) {
      page.drawRectangle({
        x: 40 + ((k * 37) % 520),
        y: 100 + ((k * 53) % 480),
        width: 30,
        height: 12,
        color: rgb(0.9, 0.9, 0.92),
      });
    }
  }
  return doc.save();
}

async function signatureField({ withValue }) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 520]);
  page.drawText(withValue ? "signed document" : "unsigned signature field", {
    x: 40,
    y: 460,
    size: 14,
    font,
  });
  const field = doc.context.obj({
    FT: "Sig",
    T: PDFString.of("Signature1"),
    Type: "Annot",
    Subtype: "Widget",
    Rect: [40, 340, 320, 420],
    P: page.ref,
    F: 4,
  });
  if (withValue) {
    field.set(PDFName.of("V"), doc.context.obj({ Type: "Sig" }));
  }
  doc.getForm().acroForm.addField(doc.context.register(field));
  return doc.save();
}

const fixtures = {
  "plain.pdf": await plain(),
  "rotations.pdf": await rotations(),
  "text-links.pdf": await textAndLinks(),
  "book-100p.pdf": await manyPages(100),
  "sig-field-empty.pdf": await signatureField({ withValue: false }),
  "sig-field-signed.pdf": await signatureField({ withValue: true }),
};

for (const [name, bytes] of Object.entries(fixtures)) {
  await writeFile(path.join(outDir, name), bytes);
  console.log(`${name.padEnd(22)} ${String(bytes.byteLength).padStart(9)} bytes`);
}

// 损坏样本：截断的 PDF 头 + 垃圾数据
const broken = Buffer.concat([
  Buffer.from("%PDF-1.7\n"),
  Buffer.from("this is not a valid xref stream\n".repeat(50)),
  Buffer.from("%%EOF\n"),
]);
await writeFile(path.join(outDir, "broken.pdf"), broken);
console.log(`${"broken.pdf".padEnd(22)} ${String(broken.byteLength).padStart(9)} bytes`);

console.log(`\n输出目录：${outDir}`);
