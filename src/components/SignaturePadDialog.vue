<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import SignaturePad from "signature_pad";
import type { SignatureTemplate } from "../types/signature";
import { useSignatureLibrary } from "../composables/useSignatureLibrary";

type SignatureMode = "handwriting" | "text";
type StrokeWidth = "thin" | "medium" | "thick";

interface StrokeWidthOption {
  value: StrokeWidth;
  label: string;
  minWidth: number;
  maxWidth: number;
}

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  close: [];
  saved: [template: SignatureTemplate];
}>();

const { saveTemplate, libraryError, clearLibraryError } = useSignatureLibrary();

const canvasRef = ref<HTMLCanvasElement | null>(null);

/**
 * 画布按设备像素比放大，并同步缩放上下文。
 * signature_pad 使用相对画布的 CSS 坐标，因此必须在高像素密度下保持一致的坐标空间。
 *
 * 这里必须读布局尺寸（offsetWidth/offsetHeight），不能用 getBoundingClientRect()：
 * 后者会把祖先元素上的 transform 一并算进来，而弹窗面板带 0.18s 入场动画
 * （panel-in：scale(0.98)），创建画笔时动画尚未结束，量到的是缩小 2% 的盒子，
 * 画布后备分辨率会偏小，手写区最右/最下一小条落在画布之外。
 */
function syncCanvasResolution(): void {
  const canvas = canvasRef.value;
  if (!canvas) {
    return;
  }
  const cssWidth = canvas.offsetWidth;
  const cssHeight = canvas.offsetHeight;
  if (!(cssWidth > 0) || !(cssHeight > 0)) {
    return;
  }
  const ratio = Math.max(window.devicePixelRatio || 1, 1);
  canvas.width = Math.round(cssWidth * ratio);
  canvas.height = Math.round(cssHeight * ratio);
  const context = canvas.getContext("2d");
  if (context) {
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
}

let pad: SignaturePad | null = null;

function resizeKeepingInk(): void {
  if (!pad) {
    return;
  }
  const data = pad.toData();
  syncCanvasResolution();
  pad.clear();
  if (data.length > 0) {
    pad.fromData(data);
  }
}

const DEFAULT_PEN_COLOR = "#101828";
const penColor = ref(DEFAULT_PEN_COLOR);
const strokeWidth = ref<StrokeWidth>("medium");

const STROKE_WIDTH_OPTIONS: readonly StrokeWidthOption[] = [
  { value: "thin", label: "细", minWidth: 0.6, maxWidth: 2.2 },
  { value: "medium", label: "中", minWidth: 1, maxWidth: 3.6 },
  { value: "thick", label: "粗", minWidth: 1.8, maxWidth: 5.4 },
];

const selectedStrokeWidth = computed(
  () =>
    STROKE_WIDTH_OPTIONS.find((option) => option.value === strokeWidth.value) ??
    STROKE_WIDTH_OPTIONS[1],
);

const hasInk = ref(false);

function createPad(): void {
  const canvas = canvasRef.value;
  if (!canvas) {
    return;
  }
  syncCanvasResolution();
  pad = new SignaturePad(canvas, {
    minWidth: selectedStrokeWidth.value.minWidth,
    maxWidth: selectedStrokeWidth.value.maxWidth,
    penColor: penColor.value,
    backgroundColor: "rgba(0,0,0,0)",
  });
  pad.addEventListener("endStroke", () => {
    hasInk.value = !pad?.isEmpty();
  });
}

function destroyPad(): void {
  pad?.off();
  pad = null;
}

function handleWindowResize(): void {
  resizeKeepingInk();
}

function handleWindowKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    handleClose();
  }
}

function attachLifecycle(): void {
  window.addEventListener("resize", handleWindowResize);
  window.addEventListener("keydown", handleWindowKeydown);
}

function detachLifecycle(): void {
  window.removeEventListener("resize", handleWindowResize);
  window.removeEventListener("keydown", handleWindowKeydown);
}

const formError = ref<string | null>(null);
const mode = ref<SignatureMode>("handwriting");
const typedText = ref("");

function resetState(): void {
  formError.value = null;
  hasInk.value = false;
  mode.value = "handwriting";
  penColor.value = DEFAULT_PEN_COLOR;
  strokeWidth.value = "medium";
  typedText.value = "";
  clearLibraryError();
}

watch(penColor, (color) => {
  if (pad) {
    pad.penColor = color;
  }
});

watch(selectedStrokeWidth, (width) => {
  if (!pad) {
    return;
  }
  pad.minWidth = width.minWidth;
  pad.maxWidth = width.maxWidth;
});

watch(
  () => props.open,
  async (open) => {
    if (open) {
      resetState();
      attachLifecycle();
      await nextTick();
      if (!props.open) {
        return;
      }
      createPad();
    } else {
      detachLifecycle();
      destroyPad();
    }
  },
);

/** 裁剪时在笔迹四周保留的空白，单位是画布像素。 */
const CROP_PADDING = 12;

/**
 * 把画布裁剪到笔迹边界，输出透明背景 PNG。
 * 全透明时返回 null，表示空白签名不允许保存。
 */
async function cropToInk(
  source: HTMLCanvasElement,
): Promise<{ blob: Blob; width: number; height: number } | null> {
  const context = source.getContext("2d");
  if (!context) {
    return null;
  }

  const { width, height } = source;
  const pixels = context.getImageData(0, 0, width, height).data;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3] === 0) {
        continue;
      }
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }

  const cropX = Math.max(minX - CROP_PADDING, 0);
  const cropY = Math.max(minY - CROP_PADDING, 0);
  const cropWidth = Math.min(maxX + CROP_PADDING, width - 1) - cropX + 1;
  const cropHeight = Math.min(maxY + CROP_PADDING, height - 1) - cropY + 1;

  const output = document.createElement("canvas");
  output.width = cropWidth;
  output.height = cropHeight;
  const outputContext = output.getContext("2d");
  if (!outputContext) {
    return null;
  }
  outputContext.drawImage(source, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

  const blob = await new Promise<Blob | null>((resolve) => {
    output.toBlob((result) => resolve(result), "image/png");
  });
  if (!blob) {
    return null;
  }
  return { blob, width: cropWidth, height: cropHeight };
}

function handleClear(): void {
  if (mode.value === "handwriting") {
    pad?.clear();
    hasInk.value = false;
  } else {
    typedText.value = "";
  }
  formError.value = null;
}

const isSaving = ref(false);

async function handleModeChange(nextMode: SignatureMode): Promise<void> {
  if (mode.value === nextMode || isSaving.value) {
    return;
  }
  pad?.clear();
  hasInk.value = false;
  typedText.value = "";
  formError.value = null;
  mode.value = nextMode;

  if (nextMode === "handwriting") {
    await nextTick();
    syncCanvasResolution();
  }
}

/** 文字签名使用固定字号和字重，保持预览与保存结果一致。 */
const TEXT_FONT = '500 64px system-ui, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif';

/** 把单行文字绘制到透明画布，之后沿用手写签名的裁剪和保存流程。 */
function renderTypedText(text: string): HTMLCanvasElement | null {
  const measureCanvas = document.createElement("canvas");
  const measureContext = measureCanvas.getContext("2d");
  if (!measureContext) {
    return null;
  }
  measureContext.font = TEXT_FONT;
  const metrics = measureContext.measureText(text);

  const output = document.createElement("canvas");
  output.width = Math.max(1, Math.ceil(metrics.width + CROP_PADDING * 2));
  output.height = 96;
  const context = output.getContext("2d");
  if (!context) {
    return null;
  }
  context.font = TEXT_FONT;
  context.fillStyle = penColor.value;
  context.textBaseline = "middle";
  context.fillText(text, CROP_PADDING, output.height / 2);
  return output;
}

function handleClose(): void {
  if (isSaving.value) {
    return;
  }
  emit("close");
}

async function handleSave(): Promise<void> {
  if (isSaving.value) {
    return;
  }
  formError.value = null;

  let source: HTMLCanvasElement | null = null;
  if (mode.value === "handwriting") {
    const canvas = canvasRef.value;
    if (!pad || !canvas) {
      formError.value = "签名画布尚未就绪，请重新打开窗口。";
      return;
    }
    if (pad.isEmpty()) {
      formError.value = "画布还是空白的，请先手写签名。";
      return;
    }
    source = canvas;
  } else {
    const text = typedText.value.trim();
    if (!text) {
      formError.value = "请输入签名文字。";
      return;
    }
    source = renderTypedText(text);
    if (!source) {
      formError.value = "无法生成文字签名，请重试。";
      return;
    }
  }

  // 保存闸门必须在进入第一个异步操作之前合上。cropToInk 里的 toBlob 是异步的，
  // 若等到裁剪完成才置位 isSaving，这段窗口内保存按钮仍可点击（canSave 只看 !isSaving），
  // 会启动第二次写入；取消按钮同样放行（handleClose 也只看 isSaving），
  // 于是出现「窗口已经关掉、签名却还是存进去了」。裁剪与存储一起纳入 try/finally。
  isSaving.value = true;
  try {
    const cropped = await cropToInk(source);
    if (!cropped) {
      formError.value =
        mode.value === "handwriting"
          ? "没有检测到笔迹，请重新手写签名。"
          : "无法生成文字签名，请修改后重试。";
      return;
    }

    const template = await saveTemplate({
      blob: cropped.blob,
      pixelWidth: cropped.width,
      pixelHeight: cropped.height,
    });
    if (!template) {
      // 保持窗口开启并保留手写内容，让用户可以重试。
      formError.value = libraryError.value ?? "保存签名失败，请重试。";
      return;
    }
    emit("saved", template);
  } finally {
    isSaving.value = false;
  }
}

onBeforeUnmount(() => {
  detachLifecycle();
  destroyPad();
});

const COLOR_OPTIONS = [
  { value: "#101828", label: "黑色" },
  { value: "#175cd3", label: "蓝色" },
  { value: "#d92d20", label: "红色" },
] as const;

const canSave = computed(() => !isSaving.value);
const hasContent = computed(() =>
  mode.value === "handwriting" ? hasInk.value : typedText.value.trim().length > 0,
);
</script>

<template>
  <div
    v-if="props.open"
    class="fixed inset-0 z-20 flex animate-scrim-in items-center justify-center bg-scrim p-5 motion-reduce:animate-none"
    role="dialog"
    aria-modal="true"
    aria-label="新建签名"
    data-testid="signature-pad-dialog"
    @keydown.esc="handleClose"
  >
    <div
      class="flex w-full max-h-[calc(100dvh-40px)] max-w-[600px] animate-panel-in flex-col gap-5 overflow-y-auto rounded-xl bg-surface p-6 shadow-panel motion-reduce:animate-none"
    >
      <header class="flex items-center justify-between gap-2.5">
        <h2>新建签名</h2>
        <button type="button" class="button button--ghost" @click="handleClose">关闭</button>
      </header>

      <div class="flex gap-1 rounded-lg bg-subtle p-1" role="group" aria-label="签名输入方式">
        <button
          type="button"
          class="button button--ghost flex-1"
          :class="{ 'button--toggled': mode === 'handwriting' }"
          :aria-pressed="mode === 'handwriting'"
          @click="handleModeChange('handwriting')"
        >
          手写
        </button>
        <button
          type="button"
          class="button button--ghost flex-1"
          :class="{ 'button--toggled': mode === 'text' }"
          :aria-pressed="mode === 'text'"
          @click="handleModeChange('text')"
        >
          文字
        </button>
      </div>

      <div class="flex flex-wrap items-center gap-3">
        <span class="text-meta text-ink-muted">颜色</span>
        <div class="flex items-center gap-2" role="group" aria-label="签名颜色">
          <button
            v-for="option in COLOR_OPTIONS"
            :key="option.value"
            type="button"
            class="size-8 rounded-full border-2 transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            :class="penColor === option.value ? 'border-accent' : 'border-line-strong'"
            :style="{ backgroundColor: option.value }"
            :aria-label="option.label"
            :aria-pressed="penColor === option.value"
            @click="penColor = option.value"
          ></button>
          <label class="flex items-center gap-1.5 text-meta text-ink-muted">
            自定义
            <input
              v-model="penColor"
              type="color"
              class="h-8 w-10 cursor-pointer rounded border border-line bg-surface p-0.5"
              aria-label="自定义签名颜色"
            />
          </label>
        </div>

        <template v-if="mode === 'handwriting'">
          <span class="ml-auto text-meta text-ink-muted">粗细</span>
          <div class="flex gap-1" role="group" aria-label="笔迹粗细">
            <button
              v-for="option in STROKE_WIDTH_OPTIONS"
              :key="option.value"
              type="button"
              class="button button--ghost button--small"
              :class="{ 'button--toggled': strokeWidth === option.value }"
              :aria-pressed="strokeWidth === option.value"
              @click="strokeWidth = option.value"
            >
              {{ option.label }}
            </button>
          </div>
        </template>
      </div>

      <div v-show="mode === 'handwriting'" class="flex flex-col gap-1.5">
        <canvas
          ref="canvasRef"
          class="signature-creation-surface h-[200px] w-full cursor-crosshair touch-none rounded-lg border border-dashed"
          style="background-color: #ffffff; background-image: none"
          aria-label="手写签名区域"
          data-testid="signature-pad-canvas"
        ></canvas>
      </div>

      <div v-if="mode === 'text'" class="flex flex-col gap-2">
        <label class="flex flex-col gap-1.5 text-meta text-ink-muted">
          签名文字
          <input
            v-model="typedText"
            type="text"
            class="input"
            placeholder="例如：张三、2026年9月20日"
            autocomplete="off"
            data-testid="signature-text-input"
            @input="formError = null"
          />
        </label>
        <div
          class="signature-creation-surface flex h-[140px] items-center overflow-auto rounded-lg border border-dashed px-4"
          aria-label="文字签名预览"
          data-testid="signature-text-preview"
        >
          <span
            v-if="typedText.trim()"
            class="mx-auto whitespace-pre text-[40px] font-medium"
            :style="{ color: penColor }"
          >
            {{ typedText.trim() }}
          </span>
          <span v-else class="m-auto text-meta text-[#6b7280]">输入后在此预览</span>
        </div>
      </div>

      <p v-if="formError" class="text-meta text-danger" role="alert" data-testid="pad-error">
        {{ formError }}
      </p>

      <footer class="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
        <button
          type="button"
          class="button button--ghost"
          :disabled="!hasContent"
          @click="handleClear"
        >
          {{ mode === "handwriting" ? "清空重写" : "清空输入" }}
        </button>
        <div class="flex gap-2">
          <button type="button" class="button button--ghost" @click="handleClose">取消</button>
          <button
            type="button"
            class="button button--primary"
            :disabled="!canSave"
            @click="handleSave"
          >
            {{ isSaving ? "保存中…" : "保存到签名库" }}
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>
