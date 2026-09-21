import { computed, ref, shallowRef } from "vue";
import {
  getDocument,
  GlobalWorkerOptions,
  InvalidPDFException,
  PasswordException,
} from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import PdfWorkerSource from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { DigitalSignatureInfo, DocumentSession, PageGeometry } from "../types/pdf";
import { inspectDigitalSignatures, ENCRYPTED_PDF_MESSAGE } from "../lib/pdfExport";

/**
 * worker 与主库版本一致，且由本地资源目录提供，不从未经确认的 CDN 加载。
 * PDF.js 自带的 CMap、标准字体、WASM 与 ICC 资源已同步到 public/pdfjs。
 */
GlobalWorkerOptions.workerSrc = PdfWorkerSource;

/** 打开文件时的可选行为。 */
export interface OpenFileOptions {
  /**
   * 文档检测到数字签名时调用，由调用方在真正打开前提示用户。
   * 返回 `false` 表示用户放弃打开：此时保持当前会话与已有提示不变，不产生错误。
   * 未提供时按「允许编辑」处理。
   */
  confirmSignedDocument?: (fileName: string) => boolean | Promise<boolean>;
}

function describeLoadError(error: unknown): string {
  if (error instanceof PasswordException || (error as Error | null)?.name === "PasswordException") {
    return ENCRYPTED_PDF_MESSAGE;
  }
  if (
    error instanceof InvalidPDFException ||
    (error as Error | null)?.name === "InvalidPDFException"
  ) {
    return "该文件不是有效的 PDF，或文件已损坏，无法打开。";
  }
  if (error instanceof Error && error.message) {
    return `无法打开该 PDF：${error.message}`;
  }
  return "无法打开该 PDF，请确认文件完整且未损坏。";
}

async function readPageGeometries(pdfDocument: PDFDocumentProxy): Promise<PageGeometry[]> {
  const pages: PageGeometry[] = [];
  for (let pageIndex = 0; pageIndex < pdfDocument.numPages; pageIndex += 1) {
    const page = await pdfDocument.getPage(pageIndex + 1);
    const view = page.view;
    pages.push({
      pageIndex,
      viewBox: [view[0] ?? 0, view[1] ?? 0, view[2] ?? 0, view[3] ?? 0],
      rotation: page.rotate,
      userUnit: page.userUnit,
    });
  }
  return pages;
}

const resourceBase = `${import.meta.env.BASE_URL}pdfjs/`;

/** 检测到数字签名的文档允许编辑，但必须提示用户其原数字签名会失效。 */
const SIGNED_DOCUMENT_NOTICE =
  "该 PDF 包含数字签名：编辑并导出的新文件中，原有数字签名将失效。原始文件不会被修改，导出结果会另存为新文件。";

/** 含未填写签名字段的文档：允许编辑，导出不改动该字段。 */
const EMPTY_SIGNATURE_FIELD_NOTICE =
  "该 PDF 包含尚未填写的数字签名字段，导出的文件不会改动这些字段。";

/** 当前文档的会话状态。单个应用实例共用一份，避免多个组件各自持有副本。 */
const session = shallowRef<DocumentSession | null>(null);
const isLoading = ref(false);
const loadError = ref<string | null>(null);
const noticeMessage = ref<string | null>(null);
/** 每次成功打开新文档递增，供视图层重建按页组件。 */
const documentId = ref(0);

/** 请求序号，用于丢弃过期的加载结果。 */
let latestRequest = 0;

async function performOpen(file: File, requestId: number, options: OpenFileOptions): Promise<void> {
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  // 预览得到的字节可能被 PDF.js 转移给 worker，导出必须使用独立副本。
  const previewBytes = fileBytes.slice();
  const exportBytes = fileBytes.slice();

  let signatureInfo: DigitalSignatureInfo;
  try {
    signatureInfo = await inspectDigitalSignatures(exportBytes);
  } catch {
    signatureInfo = { hasSignatureField: false, isSigned: false };
  }

  if (requestId !== latestRequest) {
    return;
  }

  // 已签名的文档不再拒绝：先让用户确认，确认后才继续加载。
  if (signatureInfo.isSigned && options.confirmSignedDocument) {
    // 等待用户决定期间并没有在加载，工具栏不应停留在「正在打开…」。
    if (requestId === latestRequest) {
      isLoading.value = false;
    }
    const confirmed = await options.confirmSignedDocument(file.name);
    if (!confirmed || requestId !== latestRequest) {
      return;
    }
    isLoading.value = true;
  }

  const loadingTask = getDocument({
    data: previewBytes,
    cMapUrl: `${resourceBase}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${resourceBase}standard_fonts/`,
    wasmUrl: `${resourceBase}wasm/`,
    iccUrl: `${resourceBase}iccs/`,
  });

  // 任务所有权：交接给会话之前由本加载流程负责销毁（加载失败、几何读取失败、
  // 请求过期都会走同一个兜底）；交接之后归会话管理，兜底清理不再碰它。
  let handedOver = false;
  try {
    const pdfDocument = await loadingTask.promise;

    // 过期的 pending 加载单独销毁，不能覆盖当前会话。
    if (requestId !== latestRequest) {
      return;
    }

    const pages = await readPageGeometries(pdfDocument);

    if (requestId !== latestRequest) {
      return;
    }

    const previousSession = session.value;
    documentId.value += 1;
    session.value = {
      fileName: file.name,
      originalBytes: exportBytes,
      pdfDocument,
      loadingTask,
      pages,
      assets: new Map(),
    };
    handedOver = true;

    if (signatureInfo.isSigned) {
      noticeMessage.value = SIGNED_DOCUMENT_NOTICE;
    } else if (signatureInfo.hasSignatureField) {
      noticeMessage.value = EMPTY_SIGNATURE_FIELD_NOTICE;
    } else {
      noticeMessage.value = null;
    }

    // 等新会话渲染接管后，再销毁旧文档与旧的 worker。
    await new Promise((resolve) => {
      window.requestAnimationFrame(() => resolve(undefined));
    });

    if (previousSession) {
      await previousSession.loadingTask.destroy().catch(() => undefined);
    }
  } finally {
    if (!handedOver) {
      // 销毁失败不掩盖主要错误，错误提示仍以原始异常为准。
      await loadingTask.destroy().catch(() => undefined);
    }
  }
}

/**
 * 文档加载与 PDF.js 生命周期管理。
 *
 * 替换采用两阶段切换：新文件先作为 pending 加载，成功且仍是最新请求后才切换会话，
 * 并销毁旧文档；加载失败时保留原会话。
 */
export function usePdfDocument() {
  /**
   * 打开文件。检测到数字签名的文档会先经 `options.confirmSignedDocument` 提示用户，
   * 用户放弃时保持当前会话不变。
   */
  async function openFile(file: File, options: OpenFileOptions = {}): Promise<void> {
    const requestId = latestRequest + 1;
    latestRequest = requestId;
    isLoading.value = true;
    loadError.value = null;
    // noticeMessage 不在这里预置：它由 performOpen 在会话真正切换时更新，
    // 这样用户在确认弹窗里放弃打开时，当前文档的提示才会保留。

    try {
      await performOpen(file, requestId, options);
    } catch (error) {
      if (requestId === latestRequest) {
        loadError.value = describeLoadError(error);
      }
    } finally {
      if (requestId === latestRequest) {
        isLoading.value = false;
      }
    }
  }

  /** 离开操作页时释放当前文档，并使尚未结束的加载请求失效。 */
  function closeDocument(): void {
    latestRequest += 1;
    const previousSession = session.value;
    session.value = null;
    isLoading.value = false;
    clearMessages();
    if (previousSession) {
      void previousSession.loadingTask.destroy().catch(() => undefined);
    }
  }

  function clearMessages(): void {
    loadError.value = null;
    noticeMessage.value = null;
  }

  const pageCount = computed(() => session.value?.pages.length ?? 0);

  return {
    session,
    documentId,
    isLoading,
    loadError,
    noticeMessage,
    pageCount,
    openFile,
    clearMessages,
    closeDocument,
  };
}
