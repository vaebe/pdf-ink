import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import type { SignatureAsset } from "./signature";

/**
 * 六参数仿射矩阵 [a, b, c, d, e, f]。
 *
 * 约定：把「图片单位空间」映射到「PDF 用户空间」，图片单位空间原点位于图片左下角，
 * u 轴指向图片右侧、v 轴指向图片上方，取值范围均为 [0, 1]。
 * 因此矩阵同时保存了实例的位置、尺寸和方向。
 */
export type Matrix6 = [number, number, number, number, number, number];

/** 页面几何信息，数值直接取自 PDF.js 页面对象，供坐标换算使用。 */
export interface PageGeometry {
  /** 从 0 开始的页索引。 */
  pageIndex: number;
  /** 页面可见区域 [xMin, yMin, xMax, yMax]，PDF 用户空间单位。 */
  viewBox: [number, number, number, number];
  /** 页面自带旋转，0/90/180/270。 */
  rotation: number;
  /** 页面 UserUnit，缩放换算时需要一并考虑。 */
  userUnit: number;
}

/** 页面上的签名实例。 */
export interface SignaturePlacement {
  id: string;
  /** 指向当前会话中的 `SignatureAsset`，不保存模板编号。 */
  assetId: string;
  /** 从 0 开始的页索引。 */
  pageIndex: number;
  matrix: Matrix6;
}

/** 已打开文档的会话状态。 */
export interface DocumentSession {
  fileName: string;
  /** 导出专用原始字节，导出时始终从这里重新生成，不写回源文件。 */
  originalBytes: Uint8Array;
  /** 预览用的 PDF.js 文档对象。 */
  pdfDocument: PDFDocumentProxy;
  /** 对应的加载任务，用于销毁 worker。 */
  loadingTask: PDFDocumentLoadingTask;
  pages: PageGeometry[];
  /** 当前会话持有的签名图片，按 assetId 索引。 */
  assets: Map<string, SignatureAsset>;
}

/** 文档中数字签名信息的识别结果。 */
export interface DigitalSignatureInfo {
  /** 文档包含签名（Sig）字段。 */
  hasSignatureField: boolean;
  /** 至少一个签名字段已经填写签名值，即文档已被数字签名。 */
  isSigned: boolean;
}
