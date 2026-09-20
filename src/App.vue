<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Matrix6, SignaturePlacement } from "./types/pdf";
import { exportSignedPdf } from "./lib/pdfExport";
import { useConfirmDialog } from "./composables/useConfirmDialog";
import { usePdfDocument } from "./composables/usePdfDocument";
import {
  disposeSignatureEditor,
  initSignatureEditor,
  releaseAllAssetUrls,
  useSignatureEditor,
} from "./composables/useSignatureEditor";
import { useSignatureLibrary } from "./composables/useSignatureLibrary";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import PdfToolbar from "./components/PdfToolbar.vue";
import PdfViewer from "./components/PdfViewer.vue";
import PageThumbnails from "./components/PageThumbnails.vue";
import SignatureLibrary from "./components/SignatureLibrary.vue";
import SignaturePadDialog from "./components/SignaturePadDialog.vue";

const ZOOM_STEPS = [0.4, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4] as const;

/**
 * 固定缩放的默认倍率：关闭「自适应宽度」时用它作为初始与换文档后的倍率。
 * 三个使用点（zoom / effectiveScale 的初值、新会话重置）共用它，避免数值漂移。
 */
const DEFAULT_SCALE = 1.25;

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

// 共享编辑器的会话重置监听由本入口（应用级）安装与回收；
// 页面组件只通过 useSignatureEditor 读取状态，不决定编辑器生命周期。
initSignatureEditor();

const currentPage = ref(0);
const zoom = ref(DEFAULT_SCALE);
// 默认使用固定缩放：不自动切到「自适应宽度」，打开文档时也保持关闭。
const fitWidth = ref(false);
const effectiveScale = ref(DEFAULT_SCALE);
const emptyStateInputRef = ref<HTMLInputElement | null>(null);
const isPadOpen = ref(false);
const isExporting = ref(false);
const exportError = ref<string | null>(null);
const statusMessage = ref<string | null>(null);

let statusTimer = 0;

const fileName = computed(() => session.value?.fileName ?? null);
const canExport = computed(() => session.value !== null && placements.value.length > 0);

/** 最近一次成功导出时使用的实例快照；与当前实例不一致即视为有未导出的修改。 */
const exportBaseline = ref<SignaturePlacement[]>([]);

function sameMatrix(left: Matrix6, right: Matrix6): boolean {
  return (
    left[0] === right[0] &&
    left[1] === right[1] &&
    left[2] === right[2] &&
    left[3] === right[3] &&
    left[4] === right[4] &&
    left[5] === right[5]
  );
}

/**
 * 比较两份实例快照：顺序、实例 id、assetId、pageIndex 与六个矩阵数值
 * 全部一致才视为相同。撤销或重做到与基准一致的状态会恢复「无未导出修改」。
 */
function samePlacements(
  left: readonly SignaturePlacement[],
  right: readonly SignaturePlacement[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a.id !== b.id ||
      a.assetId !== b.assetId ||
      a.pageIndex !== b.pageIndex ||
      !sameMatrix(a.matrix, b.matrix)
    ) {
      return false;
    }
  }
  return true;
}

const hasUnsavedEdits = computed(() => !samePlacements(placements.value, exportBaseline.value));

// documentId 只在会话真正切换成功时递增，是现成的「新会话建立」信号：
// 阅读状态与导出基准都在这里重置，取消确认、读取失败或过期请求不会走到这里，
// 旧文档的页码、缩放模式与滚动位置得以保留。
watch(documentId, () => {
  currentPage.value = 0;
  // 新会话回到默认的固定缩放：既不自动切到「自适应宽度」，倍率也回到默认值
  // （关闭自适应后倍率就是实际显示比例，沿用上一次的 400% 之类会让人以为没重置）。
  fitWidth.value = false;
  zoom.value = DEFAULT_SCALE;
  // 新会话的实例列表已由编辑器重置为空，导出基准同样从空列表开始。
  exportBaseline.value = [];
});

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

/** 当前文档上还有未导出的修改时，换文件前先确认。 */
function confirmDiscardEdits(): Promise<boolean> {
  return requestConfirm({
    title: "放弃当前编辑？",
    message: "打开新文件会清空当前文档上的签名，尚未导出的修改将丢失。",
    // 导出后删除全部实例也与基准不同，按数量描述会失真，改为只描述存在性。
    details: ["当前文档存在尚未导出的修改。", "原始文件不会被修改。"],
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
  // 页码、缩放倍率与「自适应宽度」的重置推迟到会话成功切换后（watch(documentId)）：
  // 取消确认、读取失败或过期请求时，旧文档的阅读状态保持不变。
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

    // 只在仍处于同一会话时记录基准：导出期间切换了文档，
    // 旧文档的导出完成不能覆盖新会话的基准。失败路径不更新基准。
    if (session.value === currentSession) {
      exportBaseline.value = snapshot;
    }
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
  disposeSignatureEditor();
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
