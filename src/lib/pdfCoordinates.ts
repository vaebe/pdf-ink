import type { PageViewport } from "pdfjs-dist";
import type { Matrix6 } from "../types/pdf";

/** 二维点，单位取决于使用场景（PDF 用户空间点或 viewport CSS 点）。 */
export interface Point {
  x: number;
  y: number;
}

/**
 * 用矩阵把图片单位空间坐标（原点左下角）映射到 PDF 用户空间。
 */
export function applyMatrix(matrix: Matrix6, u: number, v: number): Point {
  return {
    x: matrix[0] * u + matrix[2] * v + matrix[4],
    y: matrix[1] * u + matrix[3] * v + matrix[5],
  };
}

/**
 * 由图片左下、右下、左上三个角点在 PDF 用户空间中的位置构造矩阵。
 * 三个角点不能共线，否则矩阵不可逆。
 */
export function matrixFromCorners(origin: Point, right: Point, up: Point): Matrix6 {
  return [
    right.x - origin.x,
    right.y - origin.y,
    up.x - origin.x,
    up.y - origin.y,
    origin.x,
    origin.y,
  ];
}

/** 平移矩阵，位移以 PDF 用户空间为单位。 */
export function translateMatrix(matrix: Matrix6, dx: number, dy: number): Matrix6 {
  return [matrix[0], matrix[1], matrix[2], matrix[3], matrix[4] + dx, matrix[5] + dy];
}

/**
 * 以图片单位空间中的锚点 (anchorU, anchorV) 为不动点等比缩放。
 * 锚点常见取值为四个角：(0,0) 左下、(1,0) 右下、(0,1) 左上、(1,1) 右上。
 */
export function scaleMatrixAbout(
  matrix: Matrix6,
  factor: number,
  anchorU: number,
  anchorV: number,
): Matrix6 {
  const anchor = applyMatrix(matrix, anchorU, anchorV);
  const linearX = matrix[0] * anchorU + matrix[2] * anchorV;
  const linearY = matrix[1] * anchorU + matrix[3] * anchorV;
  return [
    matrix[0] * factor,
    matrix[1] * factor,
    matrix[2] * factor,
    matrix[3] * factor,
    anchor.x - linearX * factor,
    anchor.y - linearY * factor,
  ];
}

/** 矩阵两个列向量的长度，即图片在 PDF 用户空间中的宽与高。 */
export function matrixExtent(matrix: Matrix6): { width: number; height: number } {
  return {
    width: Math.hypot(matrix[0], matrix[1]),
    height: Math.hypot(matrix[2], matrix[3]),
  };
}

/**
 * 图片在 PDF 用户空间中的旋转角度，单位度，逆时针为正。
 * 与 pdf-lib `drawImage` 的 `rotate` 参数同向。
 */
export function matrixRotationDegrees(matrix: Matrix6): number {
  return (Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI;
}

/** 导出参数：pdf-lib `drawImage` 需要的平移、尺寸和旋转。 */
export interface PdfDrawParams {
  x: number;
  y: number;
  width: number;
  height: number;
  rotate: number;
}

/**
 * 把矩阵分解为 pdf-lib `drawImage` 参数。
 *
 * pdf-lib 的执行顺序是 translate → rotate → scale，因此
 * `[a, b]` 是宽方向、`[c, d]` 是高方向，且高方向应为宽方向逆时针旋转 90 度。
 * 该分解只适用于无镜像、无斜切的等比编辑，写入前必须用
 * {@link isDecomposableMatrix} 校验。
 */
export function matrixToDrawParams(matrix: Matrix6): PdfDrawParams {
  const { width, height } = matrixExtent(matrix);
  return {
    x: matrix[4],
    y: matrix[5],
    width,
    height,
    rotate: matrixRotationDegrees(matrix),
  };
}

/**
 * 校验矩阵能否被 {@link matrixToDrawParams} 无损表达。
 *
 * pdf-lib 按 translate → rotate → scale 的顺序执行，结果矩阵的两个列向量必然满足
 * `[c, d] = λ · [-b, a]`（λ > 0），也就是「两列正交」且「行列式为正」。
 * 列向量长度分别对应图片宽高，因此不要求两列等长。
 */
export function isDecomposableMatrix(matrix: Matrix6, tolerance = 1e-6): boolean {
  const [a, b, c, d] = matrix;
  const width = Math.hypot(a, b);
  const height = Math.hypot(c, d);
  if (width <= 0 || height <= 0) {
    return false;
  }
  const dot = a * c + b * d;
  const determinant = a * d - b * c;
  const scale = Math.max(width, height);
  return Math.abs(dot) <= tolerance * scale * scale && determinant > 0;
}

/**
 * viewport 中 1 个 PDF 用户空间单位对应的 CSS 像素数量。
 * `viewport.scale` 不含 UserUnit，`viewport.width/height` 含 UserUnit，两者不能混用。
 */
export function viewportCssScale(viewport: PageViewport): number {
  return viewport.scale * viewport.userUnit;
}

/** 把 PDF 用户空间长度换算为当前 viewport 的 CSS 像素长度。 */
export function pdfLengthToCss(viewport: PageViewport, length: number): number {
  return length * viewportCssScale(viewport);
}

/** 页面内容区（CSS 坐标，原点在页面左上角）上的点转换为 PDF 用户空间点。 */
export function viewportPointToPdf(viewport: PageViewport, point: Point): Point {
  const [x, y] = viewport.convertToPdfPoint(point.x, point.y);
  return { x, y };
}

/**
 * 把页面内容区中的位移换算为 PDF 用户空间的位移。
 * 使用同一 viewport 上两点之差，因此页面旋转、缩放和 CropBox 原点都会被正确处理。
 */
export function viewportDeltaToPdf(viewport: PageViewport, dx: number, dy: number): Point {
  const origin = viewportPointToPdf(viewport, { x: 0, y: 0 });
  const moved = viewportPointToPdf(viewport, { x: dx, y: dy });
  return { x: moved.x - origin.x, y: moved.y - origin.y };
}

/** DOM 中还原一个签名实例所需的尺寸与 CSS transform。 */
export interface DomPlacement {
  /** CSS 像素宽度。 */
  width: number;
  /** CSS 像素高度。 */
  height: number;
  /** CSS transform 字符串，作用于 transform-origin 为 0 0 的绝对定位元素。 */
  transform: string;
}

/**
 * 把实例矩阵还原为 DOM 变换。
 *
 * DOM 图片元素的原点在左上角，而矩阵约定原点是左下角，两者不能直接套用，
 * 因此先把图片的左上、右上、左下三个角点换算到 viewport 坐标，再据此构造变换。
 */
export function matrixToDomPlacement(matrix: Matrix6, viewport: PageViewport): DomPlacement {
  const { width: pdfWidth, height: pdfHeight } = matrixExtent(matrix);
  const width = pdfLengthToCss(viewport, pdfWidth);
  const height = pdfLengthToCss(viewport, pdfHeight);
  if (!(width > 0) || !(height > 0)) {
    return { width: 0, height: 0, transform: "none" };
  }

  // 图片单位空间的上方对应 viewport 的负 y 方向，因此左上角是 (0, 1)。
  const topLeft = applyMatrix(matrix, 0, 1);
  const topRight = applyMatrix(matrix, 1, 1);
  const bottomLeft = applyMatrix(matrix, 0, 0);

  const [tlX, tlY] = viewport.convertToViewportPoint(topLeft.x, topLeft.y);
  const [trX, trY] = viewport.convertToViewportPoint(topRight.x, topRight.y);
  const [blX, blY] = viewport.convertToViewportPoint(bottomLeft.x, bottomLeft.y);

  const a = (trX - tlX) / width;
  const b = (trY - tlY) / width;
  const c = (blX - tlX) / height;
  const d = (blY - tlY) / height;

  return {
    width,
    height,
    transform: `matrix(${a}, ${b}, ${c}, ${d}, ${tlX}, ${tlY})`,
  };
}

/**
 * 由页面内容区上的中心点和期望尺寸构造实例矩阵。
 * 尺寸以 CSS 像素给出，因此结果会跟随页面旋转与缩放。
 */
export function createPlacementMatrixAtCenter(
  viewport: PageViewport,
  center: Point,
  widthPx: number,
  heightPx: number,
): Matrix6 {
  const halfWidth = widthPx / 2;
  const halfHeight = heightPx / 2;
  const bottomLeft = viewportPointToPdf(viewport, {
    x: center.x - halfWidth,
    y: center.y + halfHeight,
  });
  const bottomRight = viewportPointToPdf(viewport, {
    x: center.x + halfWidth,
    y: center.y + halfHeight,
  });
  const topLeft = viewportPointToPdf(viewport, {
    x: center.x - halfWidth,
    y: center.y - halfHeight,
  });
  return matrixFromCorners(bottomLeft, bottomRight, topLeft);
}

/** 图片在 PDF 用户空间中的轴对齐包围盒。 */
export interface PdfBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 计算实例四个角点在 PDF 用户空间中的轴对齐包围盒。 */
export function matrixBounds(matrix: Matrix6): PdfBounds {
  const corners = [
    applyMatrix(matrix, 0, 0),
    applyMatrix(matrix, 1, 0),
    applyMatrix(matrix, 0, 1),
    applyMatrix(matrix, 1, 1),
  ];
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

/**
 * 把实例平移回页面可见区域内。
 * 只在实例本身小于页面时生效，避免大签名被强行挤压。
 */
export function clampMatrixToViewBox(
  matrix: Matrix6,
  viewBox: readonly [number, number, number, number],
): Matrix6 {
  const bounds = matrixBounds(matrix);
  const pageWidth = viewBox[2] - viewBox[0];
  let dx = 0;

  if (bounds.maxX - bounds.minX <= pageWidth) {
    if (bounds.minX < viewBox[0]) {
      dx = viewBox[0] - bounds.minX;
    } else if (bounds.maxX > viewBox[2]) {
      dx = viewBox[2] - bounds.maxX;
    }
  }

  const pageHeight = viewBox[3] - viewBox[1];
  let dy = 0;
  if (bounds.maxY - bounds.minY <= pageHeight) {
    if (bounds.minY < viewBox[1]) {
      dy = viewBox[1] - bounds.minY;
    } else if (bounds.maxY > viewBox[3]) {
      dy = viewBox[3] - bounds.maxY;
    }
  }

  return dx === 0 && dy === 0 ? matrix : translateMatrix(matrix, dx, dy);
}

/** 在给定页面尺寸下，实例还能放大的最大倍数。 */
export function maxScaleFactorWithinViewBox(
  matrix: Matrix6,
  viewBox: readonly [number, number, number, number],
): number {
  const bounds = matrixBounds(matrix);
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  if (!(width > 0) || !(height > 0)) {
    return 1;
  }
  const limit = Math.min((viewBox[2] - viewBox[0]) / width, (viewBox[3] - viewBox[1]) / height);
  return Math.max(limit, 1);
}

/** 图片像素尺寸对应的宽高比。 */
export function assetAspectRatio(pixelWidth: number, pixelHeight: number): number {
  if (!(pixelWidth > 0) || !(pixelHeight > 0)) {
    return 1;
  }
  return pixelWidth / pixelHeight;
}

/** 按长边 CSS 尺寸和图片宽高比算出实例的初始 CSS 宽高。 */
export function defaultPlacementSize(
  pixelWidth: number,
  pixelHeight: number,
  longEdgePx: number,
): { width: number; height: number } {
  const ratio = assetAspectRatio(pixelWidth, pixelHeight);
  if (ratio >= 1) {
    return { width: longEdgePx, height: longEdgePx / ratio };
  }
  return { width: longEdgePx * ratio, height: longEdgePx };
}
