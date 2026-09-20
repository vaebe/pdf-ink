<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from "vue";
import { RenderingCancelledException } from "pdfjs-dist";
import type { RenderTask } from "pdfjs-dist";
import type { ComponentPublicInstance } from "vue";
import { usePdfDocument } from "../composables/usePdfDocument";

const props = defineProps<{
  currentPage: number;
}>();

const emit = defineEmits<{
  select: [pageIndex: number];
}>();

/** 缩略图宽度上限，实际宽度按页面比例缩放。 */
const THUMBNAIL_WIDTH = 108;

const { session, documentId } = usePdfDocument();

const pages = computed(() => session.value?.pages ?? []);

/** 所有缩略图共用同一个缩放比例，页面之间的尺寸关系保持可辨认。 */
const thumbnailScale = computed(() => {
  let widest = 0;
  for (const page of pages.value) {
    const width = (page.viewBox[2] - page.viewBox[0]) * page.userUnit;
    const height = (page.viewBox[3] - page.viewBox[1]) * page.userUnit;
    const visualWidth = page.rotation % 180 === 0 ? width : height;
    widest = Math.max(widest, visualWidth);
  }
  return widest > 0 ? THUMBNAIL_WIDTH / widest : 0;
});

const itemRefs = new Map<number, HTMLLIElement>();
const canvasRefs = new Map<number, HTMLCanvasElement>();
const renderTasks = new Map<number, RenderTask>();
const renderedKeys = new Set<string>();

let observer: IntersectionObserver | null = null;

function cancelThumbnail(pageIndex: number): void {
  const task = renderTasks.get(pageIndex);
  if (task) {
    task.cancel();
    renderTasks.delete(pageIndex);
  }
}

function cancelAll(): void {
  for (const pageIndex of renderTasks.keys()) {
    cancelThumbnail(pageIndex);
  }
}

async function renderThumbnail(pageIndex: number): Promise<void> {
  const currentSession = session.value;
  const canvas = canvasRefs.get(pageIndex);
  const scale = thumbnailScale.value;
  if (!currentSession || !canvas || !(scale > 0)) {
    return;
  }
  const key = `${documentId.value}-${pageIndex}`;
  if (renderedKeys.has(key)) {
    return;
  }

  cancelThumbnail(pageIndex);
  let task: RenderTask | null = null;
  try {
    const page = await currentSession.pdfDocument.getPage(pageIndex + 1);
    // 等待期间文档可能已切换、画布节点也可能已被新文档的节点替换。此时这次渲染
    // 的产物无处可去：画布已从 DOM 移除。若照旧写入 renderedKeys，真正的新画布
    // 之后会因缓存命中而跳过渲染，永久空白。这里核对会话与画布身份，不符则放弃，
    // 并把工作交还给出新画布触发的观察回调。
    if (currentSession !== session.value || canvasRefs.get(pageIndex) !== canvas) {
      return;
    }
    const viewport = page.getViewport({ scale });
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = Math.max(Math.round(viewport.width * ratio), 1);
    canvas.height = Math.max(Math.round(viewport.height * ratio), 1);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    task = page.render({
      canvas,
      viewport,
      transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
    });
    renderTasks.set(pageIndex, task);
    await task.promise;
    renderedKeys.add(key);
  } catch (error) {
    // 取消旧任务属于正常流程；缩略图失败不影响主视图，静默跳过。
    // 「失败不再重试」也只对仍然有效的目标记录：画布已被换掉时记进去，会让新画布
    // 因缓存命中而跳过渲染，问题从「报错」变成「静默空白」。
    if (!(error instanceof RenderingCancelledException) && canvasRefs.get(pageIndex) === canvas) {
      renderedKeys.add(key);
    }
  } finally {
    // 只回收自己登记的任务：切换文档时可能已有新任务顶替了同一个页码。
    if (task !== null && renderTasks.get(pageIndex) === task) {
      renderTasks.delete(pageIndex);
    }
  }
}

function handleIntersect(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    const element = entry.target as HTMLElement;
    const pageIndex = Number(element.dataset.thumbIndex ?? "-1");
    if (pageIndex < 0) {
      continue;
    }
    if (entry.isIntersecting) {
      void renderThumbnail(pageIndex);
    } else {
      cancelThumbnail(pageIndex);
    }
  }
}

function setItemRef(pageIndex: number, element: Element | ComponentPublicInstance | null): void {
  const previous = itemRefs.get(pageIndex);
  if (previous) {
    observer?.unobserve(previous);
  }
  if (element instanceof HTMLLIElement) {
    itemRefs.set(pageIndex, element);
    observer?.observe(element);
  } else {
    itemRefs.delete(pageIndex);
  }
}

function setCanvasRef(pageIndex: number, element: Element | ComponentPublicInstance | null): void {
  if (element instanceof HTMLCanvasElement) {
    canvasRefs.set(pageIndex, element);
  } else {
    canvasRefs.delete(pageIndex);
  }
}

onMounted(() => {
  observer = new IntersectionObserver(handleIntersect, {
    root: null,
    rootMargin: "240px 0px",
    threshold: 0,
  });
  for (const element of itemRefs.values()) {
    observer.observe(element);
  }
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  cancelAll();
  itemRefs.clear();
  canvasRefs.clear();
  renderedKeys.clear();
});

/**
 * 切换文档时只作废缓存，不在这里主动渲染。
 *
 * 这个 watcher 的 flush 是 `pre`：它在 DOM 更新之前运行，此刻 `canvasRefs` 里还是
 * 旧文档的画布节点，而 `documentId` 已经是新值。若在这里直接遍历渲染，就会出现
 * 「用新文档编号把内容画进旧画布」——任务完成即标记新页面已渲染，随后挂载的新画布
 * 因缓存命中而永远跳过渲染，尤其表现为当时离屏的缩略图滚动进来是一片空白。
 *
 * 交给新节点的 IntersectionObserver 触发即可：`itemRefs` 的 ref 回调负责把新 `<li>`
 * 重新 observe，观察器对新目标会立即投递一次初始回调。
 */
watch(documentId, () => {
  cancelAll();
  renderedKeys.clear();
});
</script>

<template>
  <aside
    class="flex w-[172px] flex-none flex-col gap-2.5 overflow-auto border-r border-line bg-surface p-3"
  >
    <header class="flex items-center justify-between gap-2">
      <h2 class="text-body">页面</h2>
      <span class="text-micro text-ink-muted">{{ pages.length }} 页</span>
    </header>
    <ol class="flex flex-col gap-2">
      <li
        v-for="page in pages"
        :key="`${documentId}-${page.pageIndex}`"
        :ref="(element) => setItemRef(page.pageIndex, element)"
        :data-thumb-index="page.pageIndex"
        data-testid="thumb-item"
      >
        <button
          type="button"
          class="flex w-full cursor-pointer flex-col items-center gap-1 rounded-md border p-1.5"
          :class="
            props.currentPage === page.pageIndex
              ? 'border-accent bg-subtle ring-2 ring-accent-soft'
              : 'border-line bg-subtle'
          "
          @click="emit('select', page.pageIndex)"
        >
          <canvas
            :ref="(element) => setCanvasRef(page.pageIndex, element)"
            class="block h-auto max-w-full bg-white"
            data-testid="thumb-canvas"
          ></canvas>
          <span class="text-micro text-ink-muted">{{ page.pageIndex + 1 }}</span>
        </button>
      </li>
    </ol>
  </aside>
</template>
