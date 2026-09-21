import { useConfirmDialog } from "./useConfirmDialog";

/** 首页和操作页共用同一份数字签名风险提示。 */
export function useSignedDocumentConfirm() {
  const { requestConfirm } = useConfirmDialog();
  /**
   * 检测到数字签名的文档允许编辑，但必须由用户确认：继续编辑并导出会使原数字签名失效。
   * 取消则放弃打开，保持当前文档不变。
   */
  function confirmSignedDocumentEdit(fileName: string): Promise<boolean> {
    return requestConfirm({
      title: "该 PDF 已包含数字签名",
      message: `「${fileName}」包含数字签名。继续编辑并导出后，原有数字签名将失效。`,
      details: [
        "数字签名只在文件内容与签署时完全一致的情况下有效；导出的新文件加入了签名图片，内容已与原件不同，原有签名无法再通过验证。",
        "原始文件不会被修改，仍完整保留在你的设备上。",
        "导出的结果会另存为新的 PDF 文件。",
      ],
      confirmLabel: "仍然编辑",
      cancelLabel: "取消",
      tone: "warning",
    });
  }

  return { confirmSignedDocumentEdit };
}
