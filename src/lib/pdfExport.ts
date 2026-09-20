import { degrees, PDFDocument, PDFName, PDFSignature } from "pdf-lib";
import type { PDFImage } from "pdf-lib";
import type { DigitalSignatureInfo, DocumentSession, SignaturePlacement } from "../types/pdf";
import { isDecomposableMatrix, matrixToDrawParams } from "./pdfCoordinates";

/**
 * 检测文档中的签名字段及签名值是否存在。
 *
 * 不能凭页面上是否有签名图片判断：这里读取 AcroForm 中类型为 Sig 的字段，
 * 并检查字段是否带有签名值（/V）。这只是存在性检测，不做证书校验或
 * 密码学验签，不证明签名的真实性或有效性。
 */
export async function inspectDigitalSignatures(bytes: Uint8Array): Promise<DigitalSignatureInfo> {
  const pdfDocument = await PDFDocument.load(bytes.slice(), {
    ignoreEncryption: true,
    updateMetadata: false,
  });

  let hasSignatureField = false;
  let isSigned = false;

  try {
    const fields = pdfDocument.getForm().getFields();
    for (const field of fields) {
      if (!(field instanceof PDFSignature)) {
        continue;
      }
      hasSignatureField = true;
      if (field.acroField.dict.get(PDFName.of("V")) !== undefined) {
        isSigned = true;
      }
    }
  } catch {
    // 表单结构异常时不阻断加载，由加载路径统一提示。
    return { hasSignatureField: false, isSigned: false };
  }

  return { hasSignatureField, isSigned };
}

/** 导出所需的输入，全部来自当前会话快照。 */
export interface ExportSignedPdfInput {
  session: DocumentSession;
  /** 导出开始时取得的编辑快照，导出过程中不再读取实时状态。 */
  placements: readonly SignaturePlacement[];
}

/**
 * 从原始字节重新生成带签名的 PDF。
 *
 * 每次都从 `session.originalBytes` 出发，不把上一次输出当作输入，
 * 因此连续下载不会叠加签名。同一图片按 assetId 复用，不会重复嵌入。
 */
export async function exportSignedPdf({
  session,
  placements,
}: ExportSignedPdfInput): Promise<Uint8Array> {
  const pdfDocument = await PDFDocument.load(session.originalBytes.slice(), {
    updateMetadata: false,
  });

  if (pdfDocument.getPageCount() !== session.pages.length) {
    throw new Error("原始文档页数与会话记录不一致，已拒绝导出以避免写错页面。");
  }

  const imageCache = new Map<string, PDFImage>();

  for (const placement of placements) {
    if (!isDecomposableMatrix(placement.matrix)) {
      throw new Error("签名实例的变换包含镜像或斜切，无法按当前坐标契约写入 PDF。");
    }

    const asset = session.assets.get(placement.assetId);
    if (!asset) {
      throw new Error("签名实例引用的图片不在当前会话中，无法导出。");
    }

    let image = imageCache.get(placement.assetId);
    if (!image) {
      image = await pdfDocument.embedPng(await asset.blob.arrayBuffer());
      imageCache.set(placement.assetId, image);
    }

    const page = pdfDocument.getPage(placement.pageIndex);
    const { x, y, width, height, rotate } = matrixToDrawParams(placement.matrix);
    page.drawImage(image, { x, y, width, height, rotate: degrees(rotate) });
  }

  return pdfDocument.save();
}
