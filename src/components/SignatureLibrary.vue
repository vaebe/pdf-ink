<script setup lang="ts">
import { Button } from "./ui/button";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Empty, EmptyHeader, EmptyDescription } from "./ui/empty";
import { Spinner } from "./ui/spinner";
import { onBeforeUnmount, ref, watch } from "vue";
import { useConfirmDialog } from "../composables/useConfirmDialog";
import { useSignatureLibrary } from "../composables/useSignatureLibrary";
import { useSignatureEditor } from "../composables/useSignatureEditor";

const emit = defineEmits<{
  create: [];
}>();

const { templates, isLibraryLoading, libraryError, loadLibrary, removeTemplate } =
  useSignatureLibrary();
const { activeTemplateId, isPlacing, beginPlacement } = useSignatureEditor();
const { requestConfirm } = useConfirmDialog();

const previewUrls = ref(new Map<string, string>());

function syncPreviewUrls(): void {
  const next = new Map<string, string>();
  for (const template of templates.value) {
    const cached = previewUrls.value.get(template.id);
    // blob 是同一份数据时复用已有 URL，不会重新生成预览。
    next.set(template.id, cached ?? URL.createObjectURL(template.blob));
  }
  for (const [id, url] of previewUrls.value) {
    if (!next.has(id)) {
      URL.revokeObjectURL(url);
    }
  }
  previewUrls.value = next;
}

watch(templates, syncPreviewUrls, { immediate: true });

onBeforeUnmount(() => {
  for (const url of previewUrls.value.values()) {
    URL.revokeObjectURL(url);
  }
  previewUrls.value = new Map();
});

function previewUrl(id: string): string | undefined {
  return previewUrls.value.get(id);
}

const busyId = ref<string | null>(null);

async function confirmRemove(id: string): Promise<void> {
  const confirmed = await requestConfirm({
    title: "删除这个签名？",
    message: "该签名将从本地签名库中移除，此操作无法撤销。",
    details: ["已经放置在当前文档中的实例不会消失。"],
    confirmLabel: "删除",
    cancelLabel: "取消",
    tone: "warning",
  });
  if (!confirmed) {
    return;
  }
  busyId.value = id;
  await removeTemplate(id);
  busyId.value = null;
}

function useTemplate(id: string): void {
  beginPlacement(id);
}
</script>

<template>
  <aside
    class="flex w-[264px] flex-none flex-col gap-4 overflow-auto border-l border-line bg-surface p-4"
    data-testid="signature-library"
  >
    <header class="flex flex-col items-stretch gap-4">
      <div class="flex items-center justify-between">
        <h2 class="text-body">签名库</h2>
        <Badge variant="secondary">{{ templates.length }} 个签名</Badge>
      </div>
      <div class="flex items-center gap-2">
        <Button type="button" class="flex-1" variant="default" @click="emit('create')">
          新建签名
        </Button>
        <Button type="button" variant="ghost" title="重新加载签名库" @click="loadLibrary">
          重新加载
        </Button>
      </div>
    </header>

    <p
      v-if="isLibraryLoading"
      class="flex items-center gap-2 text-sm text-muted-foreground"
      role="status"
    >
      <Spinner aria-label="正在读取" />正在读取本地签名库…
    </p>
    <Alert v-else-if="libraryError" variant="destructive">
      <AlertDescription>{{ libraryError }}</AlertDescription>
    </Alert>

    <Alert v-if="isPlacing" role="status">
      <AlertDescription>
        放置模式已开启：在页面上单击放置签名，放置一次后自动退出；按 Esc 可提前取消。
      </AlertDescription>
    </Alert>

    <ul v-if="templates.length > 0" class="flex flex-col gap-3">
      <li
        v-for="template in templates"
        :key="template.id"
        class="flex flex-col gap-2 rounded-lg border p-2.5"
        :class="
          activeTemplateId === template.id
            ? 'border-accent bg-accent-soft'
            : 'border-line bg-surface'
        "
        :data-active="activeTemplateId === template.id"
        data-testid="library-item"
      >
        <Button
          type="button"
          variant="outline"
          class="h-auto min-h-[88px] p-0"
          :aria-label="`使用签名 ${templates.indexOf(template) + 1}`"
          :aria-pressed="activeTemplateId === template.id"
          data-testid="library-item-pick"
          title="使用签名"
          @click="useTemplate(template.id)"
        >
          <img
            v-if="previewUrl(template.id)"
            class="h-[88px] w-full rounded-sm bg-white object-contain p-2"
            data-testid="library-item-preview"
            :src="previewUrl(template.id)"
            alt="签名笔迹"
          />
        </Button>

        <div class="flex items-center justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            :disabled="busyId === template.id"
            @click="confirmRemove(template.id)"
          >
            <Spinner v-if="busyId === template.id" data-icon="inline-start" aria-label="正在删除" />
            删除
          </Button>
        </div>
      </li>
    </ul>

    <Empty v-else-if="!isLibraryLoading" class="flex-none px-0 md:px-0">
      <EmptyHeader>
        <EmptyDescription>
          还没有保存的签名。点击“新建签名”手写一个，之后可以重复使用。
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  </aside>
</template>
