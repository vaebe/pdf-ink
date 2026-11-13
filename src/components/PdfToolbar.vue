<script setup lang="ts">
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Toggle } from "./ui/toggle";
import { Separator } from "./ui/separator";
import { Spinner } from "./ui/spinner";
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

const fileInputRef = ref<HTMLInputElement | null>(null);
</script>

<template>
  <header class="editor-toolbar border-b border-line bg-surface" data-testid="toolbar">
    <div class="toolbar-file flex min-w-0 items-center gap-3">
      <span
        class="min-w-0 truncate text-body font-medium text-ink"
        :title="props.fileName ?? ''"
        data-testid="file-name"
      >
        {{ props.fileName ?? "尚未打开文件" }}
      </span>
    </div>

    <div class="toolbar-tools">
      <Separator orientation="vertical" class="self-stretch" />
      <div class="flex items-center gap-1.5">
        <Label class="flex items-center gap-1.5" data-testid="page-indicator">
          <span>页码</span>
          <Input
            v-model="pageInput"
            class="w-14 px-1.5 text-center"
            data-testid="page-input"
            type="text"
            inputmode="numeric"
            :disabled="props.pageCount === 0"
            @change="commitPage"
            @keydown.enter.prevent="commitPage"
            @blur="commitPage"
          />
          <span>/ {{ Math.max(props.pageCount, 1) }}</span>
        </Label>
      </div>

      <Separator orientation="vertical" class="self-stretch" />
      <div class="flex items-center gap-1.5">
        <Button
          type="button"
          variant="ghost"
          :disabled="props.pageCount === 0"
          aria-label="缩小"
          title="缩小"
          @click="emit('zoomOut')"
        >
          −
        </Button>
        <span
          class="min-w-[52px] text-center text-meta text-ink-muted tabular-nums"
          data-testid="zoom-level"
        >
          {{ Math.round(props.effectiveScale * 100) }}%
        </span>
        <Button
          type="button"
          variant="ghost"
          :disabled="props.pageCount === 0"
          aria-label="放大"
          title="放大"
          @click="emit('zoomIn')"
        >
          ＋
        </Button>
        <Toggle
          type="button"
          :model-value="props.fitWidth"
          :disabled="props.pageCount === 0"
          title="自适应宽度（页面宽度跟随窗口）"
          data-testid="fit-width"
          @update:model-value="emit('update:fitWidth', $event)"
        >
          自适应宽度
        </Toggle>
      </div>

      <Separator orientation="vertical" class="self-stretch" />
      <div class="flex items-center gap-1.5">
        <Button
          type="button"
          variant="ghost"
          :disabled="!props.canUndo"
          title="撤销（⌘/Ctrl + Z）"
          @click="emit('undo')"
        >
          撤销
        </Button>
        <Button
          type="button"
          variant="ghost"
          :disabled="!props.canRedo"
          title="重做（⌘/Ctrl + Shift + Z）"
          @click="emit('redo')"
        >
          重做
        </Button>
        <Button
          v-if="props.isPlacing"
          type="button"
          variant="ghost"
          title="退出放置模式（Esc）"
          @click="emit('cancelPlacement')"
        >
          退出放置
        </Button>
      </div>
    </div>
    <div class="toolbar-export flex items-center justify-end gap-1.5">
      <Button
        type="button"
        variant="default"
        :disabled="!props.canExport || props.isExporting"
        :title="props.canExport ? '导出带签名的 PDF' : '请先在页面上放置签名'"
        @click="emit('exportPdf')"
      >
        <Spinner v-if="props.isExporting" data-icon="inline-start" aria-label="正在导出" />
        {{ props.isExporting ? "正在导出…" : "下载签名后的 PDF" }}
      </Button>
      <Button
        type="button"
        variant="ghost"
        data-testid="open-pdf"
        :disabled="props.isLoading"
        @click="fileInputRef?.click()"
      >
        <Spinner v-if="props.isLoading" data-icon="inline-start" aria-label="正在打开" />
        {{ props.isLoading ? "正在打开…" : "打开 PDF" }}
      </Button>
      <input
        ref="fileInputRef"
        class="sr-only"
        data-focus-skip
        tabindex="-1"
        aria-label="打开 PDF"
        type="file"
        accept="application/pdf,.pdf"
        @change="handleFileChange"
      />
    </div>
  </header>
</template>

<style scoped>
.editor-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
  padding: 8px 16px;
  overflow-x: auto;
  white-space: nowrap;
}
.toolbar-file {
  flex: 1 0 170px;
  max-width: 320px;
}
.toolbar-export {
  flex-shrink: 0;
  margin-left: auto;
}
.toolbar-tools {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 12px;
}
</style>
