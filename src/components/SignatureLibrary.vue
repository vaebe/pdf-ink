<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { useConfirmDialog } from "../composables/useConfirmDialog";
import { useSignatureLibrary } from "../composables/useSignatureLibrary";
import { useSignatureEditor } from "../composables/useSignatureEditor";

const emit = defineEmits<{
  create: [];
}>();

const { templates, isLibraryLoading, libraryError, loadLibrary, renameTemplate, removeTemplate } =
  useSignatureLibrary();
const { activeTemplateId, isPlacing, beginPlacement } = useSignatureEditor();
const { requestConfirm } = useConfirmDialog();

const previewUrls = ref(new Map<string, string>());
const editingId = ref<string | null>(null);
const editingName = ref("");
const busyId = ref<string | null>(null);

function syncPreviewUrls(): void {
  const next = new Map<string, string>();
  for (const template of templates.value) {
    const cached = previewUrls.value.get(template.id);
    // blob 是同一份数据时复用已有 URL，重命名不会重新生成预览。
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

function startRename(id: string, name: string): void {
  editingId.value = id;
  editingName.value = name;
}

function cancelRename(): void {
  editingId.value = null;
  editingName.value = "";
}

async function confirmRename(): Promise<void> {
  const id = editingId.value;
  if (!id) {
    return;
  }
  const name = editingName.value;
  if (!name.trim()) {
    return;
  }
  busyId.value = id;
  const ok = await renameTemplate(id, name);
  busyId.value = null;
  if (ok) {
    cancelRename();
  }
}

async function confirmRemove(id: string, name: string): Promise<void> {
  const confirmed = await requestConfirm({
    title: `删除签名「${name}」？`,
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
  if (editingId.value === id) {
    cancelRename();
  }
}

function useTemplate(id: string): void {
  beginPlacement(id);
}
</script>

<template>
  <aside
    class="flex w-[248px] flex-none flex-col gap-2.5 overflow-auto border-l border-line bg-surface p-3"
    data-testid="signature-library"
  >
    <header class="flex items-center justify-between gap-2">
      <h2 class="text-body">签名库</h2>
      <button type="button" class="button button--primary button--small" @click="emit('create')">
        新建签名
      </button>
    </header>

    <p v-if="isLibraryLoading" class="text-meta text-ink-muted">正在读取本地签名库…</p>
    <p v-else-if="libraryError" class="text-meta text-danger" role="alert">
      {{ libraryError }}
    </p>

    <p v-if="isPlacing" class="rounded-md bg-accent-soft px-2.5 py-2 text-meta text-accent-strong">
      放置模式已开启：在页面上单击即可放置签名，按 Esc 退出。
    </p>

    <ul v-if="templates.length > 0" class="flex flex-col gap-2">
      <li
        v-for="template in templates"
        :key="template.id"
        class="flex flex-col gap-1.5 rounded-lg border p-2"
        :class="
          activeTemplateId === template.id
            ? 'border-accent bg-accent-soft'
            : 'border-line bg-subtle'
        "
        :data-active="activeTemplateId === template.id"
        data-testid="library-item"
      >
        <button
          type="button"
          class="flex cursor-pointer flex-col gap-1.5 text-left text-inherit"
          data-testid="library-item-pick"
          :title="`使用签名：${template.name}`"
          @click="useTemplate(template.id)"
        >
          <img
            v-if="previewUrl(template.id)"
            class="max-h-[62px] w-full rounded-sm border border-line bg-white object-contain"
            data-testid="library-item-preview"
            :src="previewUrl(template.id)"
            :alt="template.name"
          />
          <span class="text-meta break-all" data-testid="library-item-name">{{
            template.name
          }}</span>
        </button>

        <div v-if="editingId === template.id" class="flex items-center gap-1.5">
          <input
            v-model="editingName"
            class="input px-2 py-1 text-meta"
            type="text"
            maxlength="40"
            @keydown.enter.prevent="confirmRename"
            @keydown.esc.prevent="cancelRename"
          />
          <button
            type="button"
            class="button button--primary button--small"
            :disabled="busyId === template.id"
            @click="confirmRename"
          >
            保存
          </button>
          <button type="button" class="button button--ghost button--small" @click="cancelRename">
            取消
          </button>
        </div>

        <div v-else class="flex items-center gap-1.5">
          <button
            type="button"
            class="button button--ghost button--small"
            @click="startRename(template.id, template.name)"
          >
            重命名
          </button>
          <button
            type="button"
            class="button button--ghost button--small"
            :disabled="busyId === template.id"
            @click="confirmRemove(template.id, template.name)"
          >
            删除
          </button>
        </div>
      </li>
    </ul>

    <p v-else-if="!isLibraryLoading" class="text-meta text-ink-muted">
      还没有保存的签名。点击“新建签名”手写一个，之后可以重复使用。
    </p>

    <footer class="mt-auto">
      <button type="button" class="button button--ghost button--small" @click="loadLibrary">
        重新加载签名库
      </button>
    </footer>
  </aside>
</template>
