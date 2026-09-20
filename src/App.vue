<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { Matrix6 } from "./types/pdf";
import { exportSignedPdf } from "./lib/pdfExport";
import { useConfirmDialog } from "./composables/useConfirmDialog";
import { usePdfDocument } from "./composables/usePdfDocument";
import { useSignatureEditor, releaseAllAssetUrls } from "./composables/useSignatureEditor";
import { useSignatureLibrary } from "./composables/useSignatureLibrary";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import PdfToolbar from "./components/PdfToolbar.vue";
import PdfViewer from "./components/PdfViewer.vue";
import PageThumbnails from "./components/PageThumbnails.vue";
import SignatureLibrary from "./components/SignatureLibrary.vue";
import SignaturePadDialog from "./components/SignaturePadDialog.vue";

const ZOOM_STEPS = [0.4, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4] as const;

const {
  session,
  documentId,
  pageCount,
  isLoading,
  loadError,
  noticeMessage,
  openFile,
  clearMessages,
} = usePdfDocument();
const { placements, canUndo, canRedo, isPlacing, cancelPlacement, undo, redo, handleKeydown } =
  useSignatureEditor();
const { templates, loadLibrary } = useSignatureLibrary();
const { dialog: confirmDialog, isConfirmOpen, requestConfirm, settleConfirm } = useConfirmDialog();

const currentPage = ref(0);
const zoom = ref(1.25);
const fitWidth = ref(true);
const effectiveScale = ref(1.25);
const emptyStateInputRef = ref<HTMLInputElement | null>(null);
const isPadOpen = ref(false);
const isExporting = ref(false);
const exportError = ref<string | null>(null);
const statusMessage = ref<string | null>(null);

let statusTimer = 0;

const fileName = computed(() => session.value?.fileName ?? null);
const canExport = computed(() => session.value !== null && placements.value.length > 0);
const hasUnsavedEdits = computed(() => placements.value.length > 0);

function flashStatus(message: string): void {
  statusMessage.value = message;
  if (statusTimer) {
    window.clearTimeout(statusTimer);
  }
  statusTimer = window.setTimeout(() => {
    statusMessage.value = null;
  }, 3200);
}

/**
 * 含有效数字签名的文档允许编辑，但必须由用户确认：继续编辑并导出会使原数字签名失效。
 * 取消则放弃打开，保持当前文档不变。
 */
function confirmSignedDocumentEdit(fileName: string): Promise<boolean> {
  return requestConfirm({
    title: "该 PDF 已包含数字签名",
    message: `「${fileName}」已包含有效的数字签名。继续编辑并导出会改变文档内容，使原有数字签名失效。`,
    details: ["原始文件不会被修改，仍完整保留在你的设备上。", "导出的结果会另存为新的 PDF 文件。"],
    confirmLabel: "仍然编辑",
    cancelLabel: "取消",
    tone: "warning",
  });
}

/** 当前文档上还有未导出的签名时，换文件前先确认。 */
function confirmDiscardEdits(): Promise<boolean> {
  const count = placements.value.length;
  return requestConfirm({
    title: "放弃当前编辑？",
    message: "打开新文件会清空当前文档上的签名，尚未导出的编辑将丢失。",
    details: [`当前页面上有 ${count} 个签名尚未导出。`, "原始文件不会被修改。"],
    confirmLabel: "放弃并打开",
    cancelLabel: "取消",
    tone: "warning",
  });
}

async function handleOpenFile(file: File): Promise<void> {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf) {
    loadError.value = "当前只支持 PDF 文件。";
    return;
  }
  if (session.value && hasUnsavedEdits.value) {
    const confirmed = await confirmDiscardEdits();
    if (!confirmed) {
      return;
    }
  }
  exportError.value = null;
  currentPage.value = 0;
  fitWidth.value = true;
  await openFile(file, { confirmSignedDocument: confirmSignedDocumentEdit });
}

function handleEmptyStateFileChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) {
    void handleOpenFile(file);
  }
}

function stepZoom(direction: 1 | -1): void {
  fitWidth.value = false;
  const current = effectiveScale.value;
  if (direction === 1) {
    const next = ZOOM_STEPS.find((step) => step > current + 0.001);
    zoom.value = next ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  } else {
    const reversed = [...ZOOM_STEPS].reverse();
    const next = reversed.find((step) => step < current - 0.001);
    zoom.value = next ?? ZOOM_STEPS[0];
  }
}

function buildOutputFileName(source: string): string {
  const base = source.replace(/\.pdf$/i, "");
  return `${base}-signed.pdf`;
}

async function handleExport(): Promise<void> {
  const currentSession = session.value;
  if (!currentSession || isExporting.value || placements.value.length === 0) {
    return;
  }

  isExporting.value = true;
  exportError.value = null;
  let downloadUrl: string | null = null;

  try {
    // 使用导出开始时的编辑快照，导出期间继续编辑不影响本次输出。
    const snapshot = placements.value.map((placement) => ({
      ...placement,
      matrix: [...placement.matrix] as Matrix6,
    }));
    const bytes = await exportSignedPdf({ session: currentSession, placements: snapshot });
    const blob = new Blob([bytes.slice()], { type: "application/pdf" });
    downloadUrl = URL.createObjectURL(blob);

    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = buildOutputFileName(currentSession.fileName);
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();

    flashStatus(`已导出 ${anchor.download}`);
  } catch (error) {
    exportError.value = error instanceof Error ? error.message : "导出失败，请重试。";
  } finally {
    isExporting.value = false;
    if (downloadUrl) {
      const url = downloadUrl;
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
  }
}

function handlePadSaved(): void {
  isPadOpen.value = false;
  flashStatus("签名已保存到本地签名库");
}

function handleDocumentKeydown(event: KeyboardEvent): void {
  // 弹窗打开时不处理文档级快捷键，避免 Esc/Delete 穿透到编辑层。
  if (isPadOpen.value || isConfirmOpen.value) {
    return;
  }
  if (handleKeydown(event)) {
    event.preventDefault();
  }
}

onMounted(() => {
  void loadLibrary();
  window.addEventListener("keydown", handleDocumentKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleDocumentKeydown);
  if (statusTimer) {
    window.clearTimeout(statusTimer);
  }
  releaseAllAssetUrls();
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <PdfToolbar
      :file-name="fileName"
      :page-count="pageCount"
      :current-page="currentPage"
      :effective-scale="effectiveScale"
      :fit-width="fitWidth"
      :can-undo="canUndo"
      :can-redo="canRedo"
      :is-exporting="isExporting"
      :is-loading="isLoading"
      :can-export="canExport"
      :is-placing="isPlacing"
      @open-file="handleOpenFile"
      @update:current-page="currentPage = $event"
      @update:fit-width="fitWidth = $event"
      @zoom-in="stepZoom(1)"
      @zoom-out="stepZoom(-1)"
      @undo="undo"
      @redo="redo"
      @cancel-placement="cancelPlacement"
      @export-pdf="handleExport"
    />

    <div
      v-if="loadError"
      class="flex items-center justify-between gap-3 border-b border-line bg-danger-soft px-4 py-2 text-meta text-danger"
      role="alert"
      data-testid="banner"
      data-tone="error"
    >
      <span>{{ loadError }}</span>
      <button type="button" class="button button--ghost button--small" @click="clearMessages">
        知道了
      </button>
    </div>
    <div
      v-else-if="noticeMessage"
      class="flex items-center justify-between gap-3 border-b border-line bg-notice-soft px-4 py-2 text-meta text-notice"
      data-testid="banner"
      data-tone="notice"
    >
      <span>{{ noticeMessage }}</span>
      <button type="button" class="button button--ghost button--small" @click="clearMessages">
        知道了
      </button>
    </div>
    <div
      v-if="exportError"
      class="flex items-center justify-between gap-3 border-b border-line bg-danger-soft px-4 py-2 text-meta text-danger"
      role="alert"
      data-testid="banner"
      data-tone="error"
    >
      <span>导出失败：{{ exportError }}</span>
      <button type="button" class="button button--ghost button--small" @click="exportError = null">
        知道了
      </button>
    </div>
    <div
      v-if="statusMessage"
      class="flex items-center justify-between gap-3 border-b border-line bg-success-soft px-4 py-2 text-meta text-success"
      data-testid="banner"
      data-tone="success"
    >
      <span>{{ statusMessage }}</span>
    </div>

    <main class="flex min-h-0 flex-1">
      <PageThumbnails v-if="session" :current-page="currentPage" @select="currentPage = $event" />

      <section class="flex min-h-0 min-w-0 flex-1 flex-col bg-viewer">
        <PdfViewer
          v-if="session"
          :key="documentId"
          v-model:current-page="currentPage"
          :fit-width="fitWidth"
          :zoom="zoom"
          @update:effective-scale="effectiveScale = $event"
        />
        <div
          v-else
          class="m-auto flex max-w-[460px] flex-col items-center gap-3 rounded-xl border border-line bg-surface p-8 text-center"
        >
          <h2>PDFInk</h2>
          <p class="text-accent-strong">保存常用签名，轻松签署 PDF。</p>
          <p class="text-ink-muted">
            打开一个本地 PDF，手写一个签名并保存到签名库，然后放置在页面上并下载结果。 PDF
            与签名都在浏览器本地处理，不会上传到服务器。
          </p>
          <button type="button" class="button button--primary" @click="emptyStateInputRef?.click()">
            选择本地 PDF
          </button>
          <input
            ref="emptyStateInputRef"
            class="sr-only"
            data-focus-skip
            type="file"
            accept="application/pdf,.pdf"
            @change="handleEmptyStateFileChange"
          />
        </div>
      </section>

      <SignatureLibrary v-if="session" @create="isPadOpen = true" />
      <aside
        v-else
        class="flex w-[248px] flex-none flex-col gap-2.5 overflow-auto border-l border-line bg-surface p-3"
        data-testid="signature-library"
      >
        <header class="flex items-center justify-between gap-2">
          <h2 class="text-body">签名库</h2>
        </header>
        <p class="text-meta text-ink-muted">
          本地已保存 {{ templates.length }} 个签名。打开 PDF 后即可放置签名。
        </p>
        <footer class="mt-auto">
          <button
            type="button"
            class="button button--ghost button--small"
            @click="isPadOpen = true"
          >
            新建签名
          </button>
        </footer>
      </aside>
    </main>

    <SignaturePadDialog :open="isPadOpen" @close="isPadOpen = false" @saved="handlePadSaved" />

    <ConfirmDialog
      v-if="confirmDialog"
      :key="confirmDialog.id"
      :title="confirmDialog.title"
      :message="confirmDialog.message"
      :details="confirmDialog.details"
      :confirm-label="confirmDialog.confirmLabel"
      :cancel-label="confirmDialog.cancelLabel"
      :tone="confirmDialog.tone"
      @confirm="settleConfirm(true)"
      @cancel="settleConfirm(false)"
    />
  </div>
</template>
