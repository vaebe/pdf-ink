import { ref } from "vue";
import type { SignatureTemplate } from "../types/signature";
import {
  deleteSignatureTemplate,
  listSignatureTemplates,
  putSignatureTemplate,
} from "../lib/signatureStore";

export interface NewSignatureTemplate {
  blob: Blob;
  pixelWidth: number;
  pixelHeight: number;
}

const templates = ref<SignatureTemplate[]>([]);
const isLibraryLoading = ref(false);
const libraryError = ref<string | null>(null);

function describeStoreError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

function createId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `sig-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 签名库：本地持久化、保存状态与错误展示。 */
export function useSignatureLibrary() {
  /** 从 IndexedDB 加载签名库；重复调用会以数据库内容为准。 */
  async function loadLibrary(): Promise<void> {
    isLibraryLoading.value = true;
    libraryError.value = null;
    try {
      templates.value = await listSignatureTemplates();
    } catch (error) {
      libraryError.value = describeStoreError(error, "读取本地签名库失败。");
    } finally {
      isLibraryLoading.value = false;
    }
  }

  /**
   * 保存一个新签名。只有写事务完成才返回结果，
   * 失败时调用方需要保留用户手写内容并提示错误。
   */
  async function saveTemplate(input: NewSignatureTemplate): Promise<SignatureTemplate | null> {
    const template: SignatureTemplate = {
      id: createId(),
      blob: input.blob,
      pixelWidth: input.pixelWidth,
      pixelHeight: input.pixelHeight,
      createdAt: Date.now(),
    };

    libraryError.value = null;
    try {
      await putSignatureTemplate(template);
    } catch (error) {
      libraryError.value = describeStoreError(error, "保存签名失败，请重试。");
      return null;
    }

    templates.value = [...templates.value, template];
    return template;
  }

  /** 删除签名模板。当前文档中的实例与撤销记录不受影响。 */
  async function removeTemplate(id: string): Promise<boolean> {
    libraryError.value = null;
    try {
      await deleteSignatureTemplate(id);
    } catch (error) {
      libraryError.value = describeStoreError(error, "删除签名失败，请重试。");
      return false;
    }
    templates.value = templates.value.filter((template) => template.id !== id);
    return true;
  }

  function findTemplate(id: string | null): SignatureTemplate | null {
    if (!id) {
      return null;
    }
    return templates.value.find((template) => template.id === id) ?? null;
  }

  function clearLibraryError(): void {
    libraryError.value = null;
  }

  return {
    templates,
    isLibraryLoading,
    libraryError,
    loadLibrary,
    saveTemplate,
    removeTemplate,
    findTemplate,
    clearLibraryError,
  };
}
