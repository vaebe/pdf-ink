<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { RenderingCancelledException, TextLayer } from "pdfjs-dist";
import type { PDFPageProxy, PageViewport, RenderTask } from "pdfjs-dist";
import type { PageGeometry } from "../types/pdf";
import { usePdfDocument } from "../composables/usePdfDocument";
import SignatureOverlay from "./SignatureOverlay.vue";

const props = defineProps<{
  pageIndex: number;
  geometry: PageGeometry;
  scale: number;
}>();

const emit = defineEmits<{
  jump: [pageIndex: number];
}>();

interface PageLink {
  id: string;
  href: string | null;
  targetPageIndex: number | null;
  rect: [number, number, number, number];
}

const { session } = usePdfDocument();

const viewport = shallowRef<PageViewport | null>(null);
const links = ref<PageLink[]>([]);

/**
 * 页面在屏幕上的尺寸。
 * 公式与 PDF.js 的 PageViewport 保持一致：CropBox 尺寸 × scale × UserUnit，
 * 页面自带的 90/270 度旋转会交换宽高。
 */
const pageSize = computed(() => {
  const { viewBox, rotation, userUnit } = props.geometry;
  const width = (viewBox[2] - viewBox[0]) * userUnit * props.scale;
  const height = (viewBox[3] - viewBox[1]) * userUnit * props.scale;
  return rotation % 180 === 0
    ? { width: Math.max(width, 1), height: Math.max(height, 1) }
    : { width: Math.max(height, 1), height: Math.max(width, 1) };
});

const linkBoxes = computed(() => {
  const currentViewport = viewport.value;
  if (!currentViewport) {
    return [];
  }
  return links.value.map((link) => {
    const [x0, y0] = currentViewport.convertToViewportPoint(link.rect[0], link.rect[1]);
    const [x1, y1] = currentViewport.convertToViewportPoint(link.rect[2], link.rect[3]);
    return {
      ...link,
      left: Math.min(x0, x1),
      top: Math.min(y0, y1),
      width: Math.abs(x1 - x0),
      height: Math.abs(y1 - y0),
    };
  });
});

let renderTask: RenderTask | null = null;

function cancelRender(): void {
  renderTask?.cancel();
  renderTask = null;
}

const textLayerRef = ref<HTMLDivElement | null>(null);
let textLayerInstance: TextLayer | null = null;

function destroyTextLayer(): void {
  textLayerInstance?.cancel();
  textLayerInstance = null;
  textLayerRef.value?.replaceChildren();
}

async function resolveTargetPage(dest: unknown): Promise<number | null> {
  const currentSession = session.value;
  if (!currentSession || dest === undefined || dest === null) {
    return null;
  }
  try {
    const resolved =
      typeof dest === "string" ? await currentSession.pdfDocument.getDestination(dest) : dest;
    if (!Array.isArray(resolved) || resolved.length === 0) {
      return null;
    }
    const target = resolved[0];
    if (typeof target === "number") {
      return target;
    }
    if (target && typeof target === "object") {
      const index = await currentSession.pdfDocument.getPageIndex(
        target as { num: number; gen: number },
      );
      return index;
    }
    return null;
  } catch {
    return null;
  }
}

let linksLoaded = false;

/** 读取链接注解，用于保留基础链接交互；只处理 PDF 链接注解。 */
async function loadLinks(): Promise<void> {
  const currentSession = session.value;
  if (!currentSession || linksLoaded) {
    return;
  }
  linksLoaded = true;
  try {
    const page = await currentSession.pdfDocument.getPage(props.pageIndex + 1);
    const annotations = (await page.getAnnotations({ intent: "display" })) as Array<
      Record<string, unknown>
    >;
    const collected: PageLink[] = [];
    for (const annotation of annotations) {
      if (annotation.subtype !== "Link") {
        continue;
      }
      const rect = annotation.rect as number[] | undefined;
      if (!rect || rect.length < 4) {
        continue;
      }
      const href = typeof annotation.url === "string" ? annotation.url : null;
      const dest = annotation.dest;
      const targetPageIndex = href ? null : await resolveTargetPage(dest);
      if (!href && targetPageIndex === null) {
        continue;
      }
      collected.push({
        id: typeof annotation.id === "string" ? annotation.id : `link-${collected.length}`,
        href,
        targetPageIndex,
        rect: [rect[0] ?? 0, rect[1] ?? 0, rect[2] ?? 0, rect[3] ?? 0],
      });
    }
    links.value = collected;
  } catch {
    links.value = [];
  }
}

let renderToken = 0;

async function renderTextLayer(viewportForPage: PageViewport, token: number): Promise<void> {
  const container = textLayerRef.value;
  const currentSession = session.value;
  if (!container || !currentSession) {
    return;
  }
  const page = await currentSession.pdfDocument.getPage(props.pageIndex + 1);
  if (token !== renderToken || container !== textLayerRef.value) {
    return;
  }
  destroyTextLayer();
  const layer = new TextLayer({
    textContentSource: page.streamTextContent(),
    container,
    viewport: viewportForPage,
  });
  textLayerInstance = layer;

  // 自己写入尺寸，避免依赖 PDF.js 生成的 CSS round() 表达式。
  const dims = viewportForPage.rawDims as { pageWidth: number; pageHeight: number };
  const cssScale = viewportForPage.scale * viewportForPage.userUnit;
  container.style.width = `${dims.pageWidth * cssScale}px`;
  container.style.height = `${dims.pageHeight * cssScale}px`;

  try {
    await layer.render();
  } catch {
    // 取消旧的文本层属于正常流程，不作为业务错误展示。
  }

  if (token !== renderToken && textLayerInstance === layer) {
    // 渲染期间页面离开了视野：丢弃这个刚建好的文本层。
    // clearPage 只会清理它执行那一刻已存在的实例，晚到的这一份要由自己收尾，
    // 否则离屏页面会悄悄留下一份文本层与它的 DOM，逐页浏览时不断累积。
    destroyTextLayer();
  }
}

const canvasRef = ref<HTMLCanvasElement | null>(null);
const renderError = ref<string | null>(null);

async function renderPage(): Promise<void> {
  const token = ++renderToken;
  const currentSession = session.value;
  const canvas = canvasRef.value;
  if (!currentSession || !canvas) {
    return;
  }

  renderError.value = null;
  let page: PDFPageProxy;
  try {
    page = await currentSession.pdfDocument.getPage(props.pageIndex + 1);
  } catch {
    if (token === renderToken) {
      renderError.value = "页面内容读取失败。";
    }
    return;
  }
  if (token !== renderToken || currentSession !== session.value) {
    return;
  }

  const nextViewport = page.getViewport({ scale: props.scale });
  viewport.value = nextViewport;

  // 同一 canvas 上的旧渲染先取消并结束，再启动新渲染。
  cancelRender();

  const ratio = Math.max(window.devicePixelRatio || 1, 1);
  canvas.width = Math.max(Math.round(nextViewport.width * ratio), 1);
  canvas.height = Math.max(Math.round(nextViewport.height * ratio), 1);
  canvas.style.width = `${nextViewport.width}px`;
  canvas.style.height = `${nextViewport.height}px`;

  const task = page.render({
    canvas,
    viewport: nextViewport,
    transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
  });
  renderTask = task;

  try {
    await task.promise;
  } catch (error) {
    if (!(error instanceof RenderingCancelledException) && token === renderToken) {
      renderError.value = "页面渲染失败。";
    }
  } finally {
    if (renderTask === task) {
      renderTask = null;
    }
  }

  if (token !== renderToken || currentSession !== session.value) {
    return;
  }

  await renderTextLayer(nextViewport, token);
  if (token !== renderToken) {
    return;
  }
  await loadLinks();
}

const isVisible = ref(false);

function scheduleRender(): void {
  if (!isVisible.value) {
    return;
  }
  void renderPage();
}

/**
 * 释放本页已渲染的产物：取消进行中的渲染，丢弃 canvas 像素缓冲与文本层。
 * 刻意保留 viewport 与链接——两者都很轻（一个对象和几条注解），
 * 而签名层要靠 viewport 把实例还原到页面上，丢了它页面一离屏签名就整体消失。
 *
 * 页面占位尺寸由 `pageSize` 现算，实例数据存在编辑器里，都不受影响；
 * 重新进入视野时走一遍完整渲染即可恢复。
 */
function releaseRenderOutputs(): void {
  renderToken += 1;
  cancelRender();
  destroyTextLayer();
  const canvas = canvasRef.value;
  if (canvas) {
    canvas.width = 1;
    canvas.height = 1;
  }
}

/** 换文档或卸载时的彻底清空：在释放渲染产物之上，再丢弃 viewport 与链接。 */
function clearPage(): void {
  releaseRenderOutputs();
  viewport.value = null;
  links.value = [];
  linksLoaded = false;
}

function followInternalLink(link: PageLink): void {
  if (link.targetPageIndex !== null) {
    emit("jump", link.targetPageIndex);
  }
}

const pageRef = ref<HTMLDivElement | null>(null);
let observer: IntersectionObserver | null = null;

onMounted(() => {
  const element = pageRef.value;
  if (element) {
    // root 必须显式指向滚动容器（模板上的 data-scroll-root），不能用默认的视口。
    //
    // rootMargin 只扩大 root 的矩形，而交叉矩形还要经过中间每个滚动祖先的可视区裁剪。
    // root 为视口时，滚动容器自己的可视区会把扩大出来的部分整块裁掉，900px 的
    // 预渲染余量实际等于 0——页面要等真正露出来才开始渲染。
    // 这也会让「离开视野即释放缓冲」变成负优化：滚回去的页面得从头渲染一遍。
    // 以滚动容器为 root，余量才真正生效：进入视野前 900px 开始渲染，离开 900px 后才释放。
    const root = element.closest<HTMLElement>("[data-scroll-root]");
    observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) {
          return;
        }
        isVisible.value = entry.isIntersecting;
        if (entry.isIntersecting) {
          scheduleRender();
        } else {
          // 离开视野后释放渲染产物（像素缓冲 + 文本层），而不是只取消渲染任务：
          // 所有页面组件始终挂载，只取消任务的话已完成的缓冲会一直留着，
          // 逐页浏览长文档时占用随已浏览页数增长。
          releaseRenderOutputs();
        }
      },
      { root, rootMargin: "900px 0px", threshold: 0 },
    );
    observer.observe(element);
  }
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  clearPage();
});

watch(
  () => props.scale,
  () => {
    if (viewport.value || isVisible.value) {
      scheduleRender();
    }
  },
);

watch(session, () => {
  clearPage();
  scheduleRender();
});
</script>

<template>
  <div
    ref="pageRef"
    class="pdf-page relative flex-none bg-white shadow-panel"
    :data-page-index="props.pageIndex"
    :style="{
      width: `${pageSize.width}px`,
      height: `${pageSize.height}px`,
      '--scale-factor': props.scale,
      '--user-unit': props.geometry.userUnit,
    }"
  >
    <canvas ref="canvasRef" class="absolute left-0 top-0 block"></canvas>

    <div ref="textLayerRef" class="pdf-text-layer"></div>

    <div class="pointer-events-none absolute inset-0">
      <span
        v-for="box in linkBoxes"
        :key="box.id"
        class="pointer-events-auto absolute block"
        :style="{
          left: `${box.left}px`,
          top: `${box.top}px`,
          width: `${box.width}px`,
          height: `${box.height}px`,
        }"
      >
        <a
          v-if="box.href"
          :href="box.href"
          target="_blank"
          rel="noopener noreferrer"
          :title="box.href"
          class="block size-full rounded-xs hover:bg-accent/15 hover:outline-1 hover:outline-accent/50"
        ></a>
        <a
          v-else
          href="#"
          title="跳转到文档内目标"
          class="block size-full rounded-xs hover:bg-accent/15 hover:outline-1 hover:outline-accent/50"
          @click.prevent="followInternalLink(box)"
        ></a>
      </span>
    </div>

    <SignatureOverlay :page-index="props.pageIndex" :viewport="viewport" />

    <p
      v-if="renderError"
      class="absolute left-2 top-2 rounded-sm bg-danger-soft px-2 py-1 text-micro text-danger"
      role="alert"
    >
      {{ renderError }}
    </p>
  </div>
</template>
