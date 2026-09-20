<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { usePdfDocument } from "../composables/usePdfDocument";
import PdfPage from "./PdfPage.vue";

const props = defineProps<{
  fitWidth: boolean;
  zoom: number;
  currentPage: number;
}>();

const emit = defineEmits<{
  "update:currentPage": [pageIndex: number];
  "update:effectiveScale": [scale: number];
}>();

/** 页面两侧的留白，参与「自适应宽度」的计算。 */
const VIEWER_PADDING = 32;

const { session, documentId } = usePdfDocument();

const scrollerRef = ref<HTMLDivElement | null>(null);
const scrollerWidth = ref(0);
const effectiveScale = ref(props.zoom);

const pages = computed(() => session.value?.pages ?? []);

/** 以第一页的宽度作为「自适应宽度」的基准，缩放比例不会随滚动跳变。 */
const referenceBaseWidth = computed(() => {
  const first = pages.value[0];
  if (!first) {
    return 0;
  }
  const width = (first.viewBox[2] - first.viewBox[0]) * first.userUnit;
  const height = (first.viewBox[3] - first.viewBox[1]) * first.userUnit;
  return first.rotation % 180 === 0 ? width : height;
});

function computeEffectiveScale(): number {
  if (props.fitWidth && referenceBaseWidth.value > 0 && scrollerWidth.value > 0) {
    return (scrollerWidth.value - VIEWER_PADDING) / referenceBaseWidth.value;
  }
  return props.zoom;
}

function syncEffectiveScale(): void {
  const next = computeEffectiveScale();
  if (next > 0 && Number.isFinite(next)) {
    effectiveScale.value = next;
    emit("update:effectiveScale", next);
  }
}

function scrollToPage(pageIndex: number): void {
  const scroller = scrollerRef.value;
  if (!scroller) {
    return;
  }
  const target = scroller.querySelector<HTMLElement>(`[data-page-index="${pageIndex}"]`);
  if (!target) {
    return;
  }
  scroller.scrollTo({ top: Math.max(target.offsetTop - 12, 0), behavior: "auto" });
}

let frameHandle = 0;
/** 视图内部记录的当前页，用于区分“用户滚动”与“外部指定页码”。 */
let reportedPage = 0;

/** 根据各页相对滚动容器的位置判断当前页，取最靠近顶部的一页。 */
function detectCurrentPage(): void {
  const scroller = scrollerRef.value;
  if (!scroller) {
    return;
  }
  const elements = scroller.querySelectorAll<HTMLElement>("[data-page-index]");
  if (elements.length === 0) {
    return;
  }
  const containerTop = scroller.getBoundingClientRect().top;
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  elements.forEach((element) => {
    const rect = element.getBoundingClientRect();
    const distance = Math.abs(rect.top - containerTop);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = Number(element.dataset.pageIndex ?? "0");
    }
  });
  if (bestIndex !== reportedPage) {
    reportedPage = bestIndex;
    emit("update:currentPage", bestIndex);
  }
}

function handleScroll(): void {
  if (frameHandle) {
    return;
  }
  frameHandle = window.requestAnimationFrame(() => {
    frameHandle = 0;
    detectCurrentPage();
  });
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  const scroller = scrollerRef.value;
  if (!scroller) {
    return;
  }
  scrollerWidth.value = scroller.clientWidth;
  resizeObserver = new ResizeObserver(() => {
    scrollerWidth.value = scroller.clientWidth;
  });
  resizeObserver.observe(scroller);
  syncEffectiveScale();
});

onBeforeUnmount(() => {
  if (frameHandle) {
    window.cancelAnimationFrame(frameHandle);
    frameHandle = 0;
  }
  resizeObserver?.disconnect();
  resizeObserver = null;
});

watch([() => props.fitWidth, () => props.zoom, scrollerWidth], () => {
  syncEffectiveScale();
});

watch(
  () => props.currentPage,
  (value) => {
    if (value !== reportedPage) {
      reportedPage = value;
      scrollToPage(value);
    }
  },
);

// 缩放后页面高度变化，重新对齐到当前页，避免滚动位置漂移。
watch(effectiveScale, async () => {
  await nextTick();
  scrollToPage(reportedPage);
});

watch(documentId, () => {
  reportedPage = 0;
  syncEffectiveScale();
});
</script>

<template>
  <!--
    data-scroll-root 是给页面组件用的锚点：它们要拿这一个元素当 IntersectionObserver 的 root。
    只有把 root 指定为滚动容器本身，rootMargin 的预渲染余量才作数——root 是视口时，
    中间滚动容器的可视区会把交叉矩形裁掉，余量实际等于 0。详见 PdfPage.vue 的 onMounted。
  -->
  <div
    ref="scrollerRef"
    class="relative min-h-0 flex-1 overflow-auto overscroll-contain"
    data-testid="pdf-scroller"
    data-scroll-root
    @scroll.passive="handleScroll"
  >
    <!--
      min-w-max 让内容层随最宽页面撑开，是本层不可省的一环：
      items-center 在内容比容器宽时会把两侧溢出量均分，左侧那一半落进
      scrollLeft 最小值 0 之外，放大后页面左边缘永远滚不到。
      内容比容器窄时 min-width 不生效，仍按容器宽度居中。
    -->
    <div class="flex min-w-max flex-col items-center gap-4 p-4">
      <PdfPage
        v-for="page in pages"
        :key="`${documentId}-${page.pageIndex}`"
        :page-index="page.pageIndex"
        :geometry="page"
        :scale="effectiveScale"
        @jump="scrollToPage"
      />
      <p v-if="pages.length === 0" class="text-ink-muted">尚未打开 PDF。</p>
    </div>
  </div>
</template>
