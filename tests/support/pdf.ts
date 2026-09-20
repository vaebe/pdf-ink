/** 测试侧 PDF 读回与 PNG 产物工具；使用现有 PDF.js / pdf-lib，不依赖 Python。 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { AnnotationType, getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFPageProxy } from "pdfjs-dist";

type PDFOperatorList = Awaited<ReturnType<PDFPageProxy["getOperatorList"]>>;
type RenderParameters = Parameters<PDFPageProxy["render"]>[0];

type Matrix = [number, number, number, number, number, number];

/** 图片绘制时的 PDF 用户空间矩阵及边界，不使用应用的坐标换算函数。 */
interface ImageInfo {
  name: string;
  ctm: number[];
  determinant: number;
  corners: number[][];
  minCorner: number[];
  maxCorner: number[];
  pixelWidth: number;
  pixelHeight: number;
}

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));
const pdfOptions = {
  cMapUrl: join(pdfjsRoot, "cmaps") + "/",
  cMapPacked: true,
  standardFontDataUrl: join(pdfjsRoot, "standard_fonts") + "/",
  wasmUrl: join(pdfjsRoot, "wasm") + "/",
};

/** 按 PDF.js 的 cm 指令顺序累积仿射矩阵。 */
function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** 保持旧报告的小数精度，便于对照历史矩阵、边界和容差。 */
function round(value: number, digits: number) {
  return Number(value.toFixed(digits));
}

/** 读取当前验收夹具中图片绘制指令的累积变换。 */
function imageObjects({ fnArray, argsArray }: PDFOperatorList): ImageInfo[] {
  let matrix: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  const images: ImageInfo[] = [];
  for (let index = 0; index < fnArray.length; index += 1) {
    const op = fnArray[index];
    const args = argsArray[index];
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      stack.push([...matrix]);
      if (op === OPS.paintFormXObjectBegin && args[0]) {
        matrix = multiply(matrix, args[0]);
      }
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      matrix = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    } else if (op === OPS.transform) {
      matrix = multiply(matrix, args);
    } else if (op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject) {
      const [a, b, c, d, e, f] = matrix;
      const corners = [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ].map(([u, v]) => [round(a * u + c * v + e, 6), round(b * u + d * v + f, 6)]);
      const inline = op === OPS.paintInlineImageXObject;
      images.push({
        name: inline ? `inline-${index}` : args[0],
        ctm: matrix.map((value) => round(value, 9)),
        determinant: round(a * d - b * c, 9),
        corners,
        minCorner: [Math.min(...corners.map(([x]) => x)), Math.min(...corners.map(([, y]) => y))],
        maxCorner: [Math.max(...corners.map(([x]) => x)), Math.max(...corners.map(([, y]) => y))],
        pixelWidth: inline ? args[0].width : args[1],
        pixelHeight: inline ? args[0].height : args[2],
      });
    }
  }
  return images;
}

/** 提取导出 PDF 的页面、图片、链接和文字，保持原验收所消费的报告字段。 */
export async function probePdf(path: string) {
  const data = new Uint8Array(await readFile(path));
  // PDF.js 的 view 是裁剪后的可见范围；原始 MediaBox/CropBox 由 pdf-lib 读取。
  const structure = await PDFDocument.load(data);
  const task = getDocument({ data: data.slice(), ...pdfOptions });
  try {
    const document = await task.promise;
    const pages = [];
    for (let index = 0; index < document.numPages; index += 1) {
      const page = await document.getPage(index + 1);
      const sourcePage = structure.getPage(index);
      const box = ({
        x,
        y,
        width,
        height,
      }: {
        x: number;
        y: number;
        width: number;
        height: number;
      }) => [x, y, x + width, y + height].map((value) => round(value, 3));
      const text = await page.getTextContent();
      const annotations = await page.getAnnotations();
      pages.push({
        index,
        rotate: page.rotate,
        boxes: { cropbox: box(sourcePage.getCropBox()), mediabox: box(sourcePage.getMediaBox()) },
        images: imageObjects(await page.getOperatorList()),
        annotations: annotations.map((annotation) => ({
          subtype:
            annotation.annotationType === AnnotationType.LINK ? "/Link" : `/${annotation.subtype}`,
          uri: annotation.unsafeUrl ?? annotation.url ?? null,
          rect: annotation.rect?.map((value: number) => round(value, 3)) ?? null,
        })),
        text: text.items
          .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
          .join(""),
      });
      page.cleanup();
    }
    return { path, pageCount: pages.length, pages };
  } finally {
    await task.destroy();
  }
}

/** PDF.js 在 Node 下提供的 canvas 工厂；PNG 编码沿用其已有画布依赖。 */
type CanvasTarget = {
  canvas: NonNullable<RenderParameters["canvas"]> & { toBuffer(format: "image/png"): Buffer };
  context: NonNullable<RenderParameters["canvasContext"]>;
};
type CanvasFactory = {
  create(width: number, height: number): CanvasTarget;
  destroy(target: CanvasTarget): void;
};

/** 按原来的 1.5 倍缩放生成每页 PNG；图片供人工查看，不作像素差异断言。 */
export async function renderPdf(path: string, outDir: string, scale = 1.5) {
  await mkdir(outDir, { recursive: true });
  const task = getDocument({ data: new Uint8Array(await readFile(path)), ...pdfOptions });
  try {
    const document = await task.promise;
    const factory = document.canvasFactory as CanvasFactory;
    const stem = basename(path, ".pdf");
    const rendered: string[] = [];
    for (let index = 0; index < document.numPages; index += 1) {
      const page = await document.getPage(index + 1);
      const viewport = page.getViewport({ scale });
      const target = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
      try {
        await page.render({ canvas: target.canvas, canvasContext: target.context, viewport })
          .promise;
        const output = join(outDir, `${stem}-p${index + 1}.png`);
        await writeFile(output, target.canvas.toBuffer("image/png"));
        rendered.push(`${output}  ${target.canvas.width}x${target.canvas.height}`);
      } finally {
        factory.destroy(target);
        page.cleanup();
      }
    }
    return rendered.join("\n");
  } finally {
    await task.destroy();
  }
}
