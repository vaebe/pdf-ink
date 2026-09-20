/**
 * 坐标与导出契约验证脚本。
 *
 * 使用真实的 pdfjs-dist 与 pdf-lib 跑通「放置 → 预览还原 → 写入 PDF → 读回」，
 * 重点验证页面旋转、CropBox 原点、非 1 倍缩放和 DOM 原点差异下的四个角点偏差。
 *
 * 用法：node scripts/verify-pdf-geometry.mjs
 *
 * 该脚本不启动浏览器，也不生成软件产物；它只对坐标与导出契约做数值验证。
 */
import { registerHooks } from "node:module";
import { PDFDocument, PDFName, PDFString, degrees } from "pdf-lib";
// PDF.js 在 Node 环境下需要使用 legacy 构建，浏览器端仍使用默认构建。
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

// 让 Node 能直接加载以打包器方式写的 TS 源码（省略 .ts 后缀）。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  applyMatrix,
  createPlacementMatrixAtCenter,
  isDecomposableMatrix,
  matrixToDomPlacement,
  matrixExtent,
  scaleMatrixAbout,
  translateMatrix,
  viewportDeltaToPdf,
} = await import("../src/lib/pdfCoordinates.ts");
const { exportSignedPdf, inspectDigitalSignatures } = await import("../src/lib/pdfExport.ts");

const failures = [];
const notes = [];

function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

function maxDeviation(pairs) {
  let worst = 0;
  for (const [actual, expected] of pairs) {
    worst = Math.max(worst, Math.hypot(actual.x - expected.x, actual.y - expected.y));
  }
  return worst;
}

function multiply(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/** 从操作符列表中还原每个图片绘制点处的当前变换矩阵。 */
function collectImageTransforms(operatorList) {
  const { fnArray, argsArray } = operatorList;
  const results = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  for (let index = 0; index < fnArray.length; index += 1) {
    const fn = fnArray[index];
    if (fn === OPS.save) {
      stack.push([...ctm]);
    } else if (fn === OPS.restore) {
      ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    } else if (fn === OPS.transform) {
      ctm = multiply(ctm, argsArray[index]);
    } else if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintInlineImageXObject ||
      fn === OPS.paintImageMaskXObject
    ) {
      results.push([...ctm]);
    }
  }
  return results;
}

function parseCssMatrix(transform) {
  const match = /matrix\(([^)]+)\)/.exec(transform);
  if (!match) {
    return null;
  }
  const values = match[1].split(",").map((value) => Number.parseFloat(value));
  return { a: values[0], b: values[1], c: values[2], d: values[3], e: values[4], f: values[5] };
}

/** 生成覆盖 0/90/180/270 度旋转、非零 CropBox 原点与混合页面尺寸的样本。 */
async function createSamplePdf() {
  const document = await PDFDocument.create();
  const specs = [
    { width: 612, height: 792, rotation: 0 },
    { width: 612, height: 792, rotation: 90 },
    { width: 400, height: 300, rotation: 180 },
    { width: 500, height: 500, rotation: 270, cropBox: [50, 60, 450, 460] },
  ];
  for (const spec of specs) {
    const page = document.addPage([spec.width, spec.height]);
    page.setRotation(degrees(spec.rotation));
    if (spec.cropBox) {
      page.setCropBox(
        spec.cropBox[0],
        spec.cropBox[1],
        spec.cropBox[2] - spec.cropBox[0],
        spec.cropBox[3] - spec.cropBox[1],
      );
    }
  }
  return document.save();
}

/** 生成一张 4x2 全透明 PNG，作为签名图片（无需 canvas 依赖）。 */
/** 生成一张全透明底色、4x2 的签名 PNG 字节。 */
function createSignaturePngBytes() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAABpAiUmAAAAEklEQVR4nGNgYGD4z4AGGNEFAB0kAQFGc0kfAAAAAElFTkSuQmCC",
    "base64",
  );
}

/**
 * 生成一个包含数字签名字段（并可带签名值）的 PDF。
 * 用于验证「已签名的文档必须被拒绝编辑」。
 */
async function createSignatureFieldPdf({ withValue }) {
  const document = await PDFDocument.create();
  const page = document.addPage([300, 400]);
  const field = document.context.obj({
    FT: "Sig",
    T: PDFString.of("Signature1"),
    Type: "Annot",
    Subtype: "Widget",
    Rect: [40, 40, 240, 90],
    P: page.ref,
    F: 4,
  });
  if (withValue) {
    field.set(PDFName.of("V"), document.context.obj({ Type: "Sig" }));
  }
  document.getForm().acroForm.addField(document.context.register(field));
  return document.save();
}

const SCALES = [1, 1.7, 2.35];

async function main() {
  const originalBytes = await createSamplePdf();

  // 0) 数字签名识别：不含表单的普通文档必须能安全通过，不得抛错。
  const signatureInfo = await inspectDigitalSignatures(originalBytes);
  check(
    "普通文档的数字签名识别不报错且判定为未签名",
    signatureInfo.hasSignatureField === false && signatureInfo.isSigned === false,
    JSON.stringify(signatureInfo),
  );

  const emptyFieldBytes = await createSignatureFieldPdf({ withValue: false });
  const emptyFieldInfo = await inspectDigitalSignatures(emptyFieldBytes);
  check(
    "存在未填写的数字签名字段时仅提示不拒绝",
    emptyFieldInfo.hasSignatureField === true && emptyFieldInfo.isSigned === false,
    JSON.stringify(emptyFieldInfo),
  );

  const signedBytes = await createSignatureFieldPdf({ withValue: true });
  const signedInfo = await inspectDigitalSignatures(signedBytes);
  check(
    "已填写签名值的文档被判定为已签名",
    signedInfo.hasSignatureField === true && signedInfo.isSigned === true,
    JSON.stringify(signedInfo),
  );

  const loadingTask = getDocument({ data: originalBytes.slice() });
  const pdfDocument = await loadingTask.promise;

  const pages = [];
  const matrices = [];
  const assets = new Map();
  assets.set("asset-test", {
    assetId: "asset-test",
    blob: new Blob([createSignaturePngBytes()], { type: "image/png" }),
    pixelWidth: 4,
    pixelHeight: 2,
  });

  console.log(`样本页数：${pdfDocument.numPages}`);

  for (let index = 0; index < pdfDocument.numPages; index += 1) {
    const page = await pdfDocument.getPage(index + 1);
    const view = page.view;
    pages.push({
      pageIndex: index,
      viewBox: [view[0], view[1], view[2], view[3]],
      rotation: page.rotate,
      userUnit: page.userUnit,
    });

    for (const scale of SCALES) {
      const viewport = page.getViewport({ scale });
      const center = { x: viewport.width * 0.37, y: viewport.height * 0.62 };
      const cssWidth = 132;
      const cssHeight = 66;
      const matrix = createPlacementMatrixAtCenter(viewport, center, cssWidth, cssHeight);
      const label = `第 ${index + 1} 页 rotation=${page.rotate} viewBox=[${view.join(", ")}] scale=${scale}`;

      check(`${label} 矩阵可分解`, isDecomposableMatrix(matrix));

      // 1) 点击位置应落在实例中心，偏差不超过 1 PDF 用户单位。
      const centerPdf = applyMatrix(matrix, 0.5, 0.5);
      const [centerViewportX, centerViewportY] = viewport.convertToViewportPoint(
        centerPdf.x,
        centerPdf.y,
      );
      const centerDeviation = Math.hypot(centerViewportX - center.x, centerViewportY - center.y);
      check(
        `${label} 点击中心一致`,
        centerDeviation <= 1,
        `偏差 ${centerDeviation.toExponential(3)} CSS px`,
      );

      // 2) 预览还原：DOM 变换反推回的 PDF 角点应与矩阵一致。
      const dom = matrixToDomPlacement(matrix, viewport);
      const css = parseCssMatrix(dom.transform);
      const extent = matrixExtent(matrix);
      const expectedWidth = extent.width * viewport.scale * viewport.userUnit;
      const expectedHeight = extent.height * viewport.scale * viewport.userUnit;
      check(
        `${label} 预览尺寸等于 PDF 尺寸 × 缩放`,
        Math.abs(dom.width - expectedWidth) < 1e-6 && Math.abs(dom.height - expectedHeight) < 1e-6,
        `${dom.width.toFixed(3)}×${dom.height.toFixed(3)}`,
      );

      if (css) {
        const localToPage = (x, y) => ({
          x: css.a * x + css.c * y + css.e,
          y: css.b * x + css.d * y + css.f,
        });
        // DOM 元素左上角对应图片单位空间的 (0, 1)，右下角对应 (1, 0)。
        const corners = [
          { local: [0, 0], unit: [0, 1] },
          { local: [dom.width, 0], unit: [1, 1] },
          { local: [0, dom.height], unit: [0, 0] },
          { local: [dom.width, dom.height], unit: [1, 0] },
        ];
        const pairs = corners.map((corner) => {
          const pagePoint = localToPage(corner.local[0], corner.local[1]);
          const [pdfX, pdfY] = viewport.convertToPdfPoint(pagePoint.x, pagePoint.y);
          return [{ x: pdfX, y: pdfY }, applyMatrix(matrix, corner.unit[0], corner.unit[1])];
        });
        const deviation = maxDeviation(pairs);
        check(
          `${label} 预览四角与 PDF 矩阵一致`,
          deviation <= 1,
          `最大偏差 ${deviation.toExponential(3)} PDF 单位`,
        );
      } else {
        check(`${label} 预览 transform 可解析`, false, dom.transform);
      }

      // 3) 拖动位移换算：页面位移应等于按住中心拖动同样的屏幕距离。
      const dragDelta = { x: 25, y: -13 };
      const pdfDelta = viewportDeltaToPdf(viewport, dragDelta.x, dragDelta.y);
      const moved = translateMatrix(matrix, pdfDelta.x, pdfDelta.y);
      const movedCenter = applyMatrix(moved, 0.5, 0.5);
      const [movedX, movedY] = viewport.convertToViewportPoint(movedCenter.x, movedCenter.y);
      const dragDeviation = Math.hypot(
        movedX - (center.x + dragDelta.x),
        movedY - (center.y + dragDelta.y),
      );
      check(
        `${label} 拖动位移换算一致`,
        dragDeviation <= 1,
        `偏差 ${dragDeviation.toExponential(3)} CSS px`,
      );

      // 4) 等比缩放：以右下角为锚点放大后锚点不动，长宽比不变。
      const scaled = scaleMatrixAbout(matrix, 1.7, 1, 0);
      const anchorBefore = applyMatrix(matrix, 1, 0);
      const anchorAfter = applyMatrix(scaled, 1, 0);
      const anchorDrift = Math.hypot(
        anchorAfter.x - anchorBefore.x,
        anchorAfter.y - anchorBefore.y,
      );
      const extentBefore = matrixExtent(matrix);
      const extentAfter = matrixExtent(scaled);
      const ratioBefore = extentBefore.width / extentBefore.height;
      const ratioAfter = extentAfter.width / extentAfter.height;
      check(
        `${label} 缩放锚点固定且长宽比不变`,
        anchorDrift < 1e-9 && Math.abs(ratioBefore - ratioAfter) < 1e-9,
        `锚点漂移 ${anchorDrift.toExponential(2)}，比例 ${ratioAfter.toFixed(6)}`,
      );

      if (scale === 1.7) {
        matrices.push(matrix);
      }
    }
  }

  // 5) 导出并读回：从原始字节重新导出，检查写入 PDF 的变换是否等于实例矩阵。
  const session = {
    fileName: "sample.pdf",
    originalBytes,
    pdfDocument,
    loadingTask,
    pages,
    assets,
  };
  const placements = matrices.map((matrix, index) => ({
    id: `placement-${index}`,
    assetId: "asset-test",
    pageIndex: index,
    matrix,
  }));

  // 导出前对会话持有的原始字节做快照，用于检测导出是否原地改写了输入。
  // 不能拿「重新生成一份样本」来比较：pdf-lib 会把创建时间写进文档，跨秒即产生不同字节。
  const sourceBytesBeforeExport = originalBytes.slice();

  const exportStartedAt = Date.now();
  const exportedOnce = await exportSignedPdf({ session, placements });
  const exportCost = Date.now() - exportStartedAt;
  const exportedTwice = await exportSignedPdf({ session, placements });
  notes.push(`导出耗时约 ${exportCost} ms（${pages.length} 页 / ${placements.length} 个实例）`);

  check(
    "连续两次导出签名数量一致",
    Buffer.compare(Buffer.from(exportedOnce), Buffer.from(exportedTwice)) === 0,
    `${exportedOnce.byteLength} bytes`,
  );
  check(
    "导出未改写原始字节",
    Buffer.compare(Buffer.from(originalBytes), Buffer.from(sourceBytesBeforeExport)) === 0,
    `会话持有的原始字节 ${originalBytes.byteLength} 字节，导出前快照 ${sourceBytesBeforeExport.byteLength} 字节，逐字节比对${Buffer.compare(Buffer.from(originalBytes), Buffer.from(sourceBytesBeforeExport)) === 0 ? "一致" : "不一致"}`,
  );

  const verifyTask = getDocument({ data: exportedOnce.slice() });
  const exportedDocument = await verifyTask.promise;
  check("导出结果页数不变", exportedDocument.numPages === pages.length);

  let worstExportDeviation = 0;
  for (let index = 0; index < exportedDocument.numPages; index += 1) {
    const page = await exportedDocument.getPage(index + 1);
    const operatorList = await page.getOperatorList();
    const transforms = collectImageTransforms(operatorList);
    const expected = matrices[index];
    const label = `第 ${index + 1} 页导出`;

    if (transforms.length !== 1) {
      check(`${label} 只有一个图片绘制操作`, false, `实际 ${transforms.length} 个`);
      continue;
    }
    check(`${label} 只有一个图片绘制操作`, true);

    const actual = transforms[0];
    for (const unit of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [0.5, 0.5],
    ]) {
      const actualPoint = applyMatrix(actual, unit[0], unit[1]);
      const expectedPoint = applyMatrix(expected, unit[0], unit[1]);
      worstExportDeviation = Math.max(
        worstExportDeviation,
        Math.hypot(actualPoint.x - expectedPoint.x, actualPoint.y - expectedPoint.y),
      );
    }
    check(
      `${label} 变换与实例矩阵一致`,
      worstExportDeviation <= 1,
      `累计最大偏差 ${worstExportDeviation.toExponential(3)} PDF 单位`,
    );
  }

  await verifyTask.destroy();
  await loadingTask.destroy();

  console.log("\n汇总：");
  for (const note of notes) {
    console.log(`  - ${note}`);
  }
  console.log(`  - 导出读回最大角点偏差：${worstExportDeviation.toExponential(3)} PDF 单位`);
  if (failures.length > 0) {
    console.log(`\n失败项 ${failures.length} 个：\n  - ${failures.join("\n  - ")}`);
    process.exitCode = 1;
  } else {
    console.log("\n全部坐标与导出契约检查通过。");
  }
}

await main();
