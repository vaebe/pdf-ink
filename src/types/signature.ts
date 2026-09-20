/**
 * 签名模板：保存在本地签名库中，可跨文档复用。
 */
export interface SignatureTemplate {
  id: string;
  /** 裁剪到笔迹边界后的透明背景 PNG。 */
  blob: Blob;
  pixelWidth: number;
  pixelHeight: number;
  createdAt: number;
}

/**
 * 签名图片资源：当前会话持有的不可变图片数据。
 * 页面实例通过 `assetId` 引用，因此删除模板不会影响已放置的实例和撤销记录。
 */
export interface SignatureAsset {
  assetId: string;
  blob: Blob;
  pixelWidth: number;
  pixelHeight: number;
}
