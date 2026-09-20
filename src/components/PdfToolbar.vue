<script setup lang="ts">
import { ref, watch } from "vue";

const props = defineProps<{
  fileName: string | null;
  pageCount: number;
  currentPage: number;
  effectiveScale: number;
  fitWidth: boolean;
  canUndo: boolean;
  canRedo: boolean;
  isExporting: boolean;
  isLoading: boolean;
  canExport: boolean;
  isPlacing: boolean;
}>();

const emit = defineEmits<{
  openFile: [file: File];
  "update:currentPage": [pageIndex: number];
  "update:fitWidth": [value: boolean];
  zoomIn: [];
  zoomOut: [];
  undo: [];
  redo: [];
  exportPdf: [];
  cancelPlacement: [];
}>();

const fileInputRef = ref<HTMLInputElement | null>(null);
const pageInput = ref("1");

watch(
  () => props.currentPage,
  (value) => {
    pageInput.value = String(value + 1);
  },
  { immediate: true },
);

function handleFileChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) {
    emit("openFile", file);
  }
}

function commitPage(): void {
  const parsed = Number.parseInt(pageInput.value, 10);
  if (!Number.isFinite(parsed)) {
    pageInput.value = String(props.currentPage + 1);
    return;
  }
  const clamped = Math.min(Math.max(parsed, 1), Math.max(props.pageCount, 1));
  pageInput.value = String(clamped);
  emit("update:currentPage", clamped - 1);
}

function toggleFitWidth(): void {
  emit("update:fitWidth", !props.fitWidth);
}
</script>

<template>
  <header
    class="flex flex-wrap items-center gap-4.5 border-b border-line bg-surface px-4 py-2.5"
    data-testid="toolbar"
  >
    <div class="flex items-center gap-1.5">
      <button
        type="button"
        class="button button--primary"
        :disabled="props.isLoading"
        @click="fileInputRef?.click()"
      >
        {{ props.isLoading ? "正在打开…" : "打开 PDF" }}
      </button>
      <input
        ref="fileInputRef"
        class="sr-only"
        data-focus-skip
        type="file"
        accept="application/pdf,.pdf"
        @change="handleFileChange"
      />
      <span
        class="max-w-[260px] truncate text-meta text-ink-muted"
        :title="props.fileName ?? ''"
        data-testid="file-name"
      >
        {{ props.fileName ?? "尚未打开文件" }}
      </span>
    </div>

    <div class="flex items-center gap-1.5">
      <label
        class="flex items-center gap-1.5 text-meta text-ink-muted"
        data-testid="page-indicator"
      >
        <span>页码</span>
        <input
          v-model="pageInput"
          class="input w-14 px-1.5 py-[5px] text-center"
          data-testid="page-input"
          type="text"
          inputmode="numeric"
          :disabled="props.pageCount === 0"
          @change="commitPage"
          @keydown.enter.prevent="commitPage"
          @blur="commitPage"
        />
        <span>/ {{ Math.max(props.pageCount, 1) }}</span>
      </label>
    </div>

    <div class="flex items-center gap-1.5">
      <button
        type="button"
        class="button button--ghost"
        :disabled="props.pageCount === 0"
        title="缩小"
        @click="emit('zoomOut')"
      >
        −
      </button>
      <span
        class="min-w-[52px] text-center text-meta text-ink-muted tabular-nums"
        data-testid="zoom-level"
      >
        {{ Math.round(props.effectiveScale * 100) }}%
      </span>
      <button
        type="button"
        class="button button--ghost"
        :disabled="props.pageCount === 0"
        title="放大"
        @click="emit('zoomIn')"
      >
        ＋
      </button>
      <button
        type="button"
        class="button button--ghost"
        :class="{ 'button--toggled': props.fitWidth }"
        :disabled="props.pageCount === 0"
        title="自适应宽度（页面宽度跟随窗口）"
        data-testid="fit-width"
        @click="toggleFitWidth"
      >
        自适应宽度
      </button>
    </div>

    <div class="flex items-center gap-1.5">
      <button
        type="button"
        class="button button--ghost"
        :disabled="!props.canUndo"
        title="撤销（⌘/Ctrl + Z）"
        @click="emit('undo')"
      >
        撤销
      </button>
      <button
        type="button"
        class="button button--ghost"
        :disabled="!props.canRedo"
        title="重做（⌘/Ctrl + Shift + Z）"
        @click="emit('redo')"
      >
        重做
      </button>
      <button
        v-if="props.isPlacing"
        type="button"
        class="button button--ghost"
        title="退出放置模式（Esc）"
        @click="emit('cancelPlacement')"
      >
        退出放置
      </button>
    </div>

    <div class="ml-auto flex items-center gap-1.5">
      <button
        type="button"
        class="button button--primary"
        :disabled="!props.canExport || props.isExporting"
        :title="props.canExport ? '导出带签名的 PDF' : '请先在页面上放置签名'"
        @click="emit('exportPdf')"
      >
        {{ props.isExporting ? "正在导出…" : "下载签名后的 PDF" }}
      </button>
    </div>
  </header>
</template>
