<script setup lang="ts">
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { Alert, AlertDescription } from "./ui/alert";
import { Separator } from "./ui/separator";
import { Spinner } from "./ui/spinner";
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
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
  fontWeight: number;
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
 * 后者会把祖先元素上的 transform 一并算进来，弹窗入场动画也会缩放面板。
 * 创建画笔时动画尚未结束，测得的边界会随动画缩小，
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
  { value: "thin", label: "细", minWidth: 0.6, maxWidth: 2.2, fontWeight: 400 },
  { value: "medium", label: "中", minWidth: 1, maxWidth: 3.6, fontWeight: 500 },
  { value: "thick", label: "粗", minWidth: 1.8, maxWidth: 5.4, fontWeight: 700 },
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

function attachLifecycle(): void {
  window.addEventListener("resize", handleWindowResize);
}

function detachLifecycle(): void {
  window.removeEventListener("resize", handleWindowResize);
}

const formError = ref<string | null>(null);
const mode = ref<SignatureMode>("handwriting");
const typedText = ref("");
const textFontWeight = computed(() => selectedStrokeWidth.value.fontWeight);

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
  (open) => {
    if (open) {
      resetState();
      attachLifecycle();
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

/** 预览和画布共用字体与字重，画布使用更大字号生成签名图片。 */
const TEXT_FONT_FAMILY = 'system-ui, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif';
const textFont = computed(() => `${textFontWeight.value} 64px ${TEXT_FONT_FAMILY}`);

/** 把单行文字绘制到透明画布，之后沿用手写签名的裁剪和保存流程。 */
function renderTypedText(text: string): HTMLCanvasElement | null {
  const measureCanvas = document.createElement("canvas");
  const measureContext = measureCanvas.getContext("2d");
  if (!measureContext) {
    return null;
  }
  measureContext.font = textFont.value;
  const metrics = measureContext.measureText(text);

  const output = document.createElement("canvas");
  output.width = Math.max(1, Math.ceil(metrics.width + CROP_PADDING * 2));
  output.height = 96;
  const context = output.getContext("2d");
  if (!context) {
    return null;
  }
  context.font = textFont.value;
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

const textInputId = useId();
const colorInputId = useId();

// Portal 内容挂载后才能读取画布尺寸。
function handleDialogOpen(): void {
  createPad();
}

function handleDialogOpenChange(open: boolean): void {
  if (!open) {
    handleClose();
  }
}

function handleModeSelection(value: unknown): void {
  if (value === "handwriting" || value === "text") {
    void handleModeChange(value);
  }
}

function handleStrokeSelection(value: unknown): void {
  if (value === "thin" || value === "medium" || value === "thick") {
    strokeWidth.value = value;
  }
}

function handleColorSelection(value: unknown): void {
  if (typeof value === "string" && value !== "") {
    penColor.value = value;
  }
}

const canSave = computed(() => !isSaving.value);
const hasContent = computed(() =>
  mode.value === "handwriting" ? hasInk.value : typedText.value.trim().length > 0,
);
</script>

<template>
  <Dialog :open="props.open" @update:open="handleDialogOpenChange">
    <DialogContent
      class="flex max-h-[calc(100dvh-40px)] flex-col gap-5 overflow-y-auto sm:max-w-[600px]"
      :show-close-button="false"
      :aria-describedby="undefined"
      data-testid="signature-pad-dialog"
      @open-auto-focus="handleDialogOpen"
      @interact-outside.prevent
      @escape-key-down.stop
    >
      <DialogHeader class="flex-row items-center justify-between">
        <DialogTitle>新建签名</DialogTitle>
        <Button type="button" variant="ghost" :disabled="isSaving" @click="handleClose"
          >关闭</Button
        >
      </DialogHeader>

      <ToggleGroup
        type="single"
        variant="outline"
        class="w-full"
        :model-value="mode"
        :disabled="isSaving"
        aria-label="签名输入方式"
        @update:model-value="handleModeSelection"
      >
        <ToggleGroupItem value="handwriting" class="flex-1">手写</ToggleGroupItem>
        <ToggleGroupItem value="text" class="flex-1">文字</ToggleGroupItem>
      </ToggleGroup>

      <div class="flex flex-wrap items-center gap-3">
        <span class="text-meta text-ink-muted">颜色</span>
        <ToggleGroup
          type="single"
          variant="outline"
          :model-value="penColor"
          aria-label="签名颜色"
          @update:model-value="handleColorSelection"
        >
          <ToggleGroupItem
            v-for="option in COLOR_OPTIONS"
            :key="option.value"
            :value="option.value"
            :aria-label="option.label"
          >
            <span
              class="size-4 rounded-full"
              :style="{ backgroundColor: option.value }"
              aria-hidden="true"
            ></span>
          </ToggleGroupItem>
        </ToggleGroup>
        <Label :for="colorInputId">自定义</Label>
        <Input
          :id="colorInputId"
          v-model="penColor"
          type="color"
          class="w-10 p-0.5"
          aria-label="自定义签名颜色"
        />

        <span class="ml-auto text-meta text-ink-muted">粗细</span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          :model-value="strokeWidth"
          :disabled="isSaving"
          aria-label="签名粗细"
          @update:model-value="handleStrokeSelection"
        >
          <ToggleGroupItem
            v-for="option in STROKE_WIDTH_OPTIONS"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </ToggleGroupItem>
        </ToggleGroup>
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
        <Label :for="textInputId">签名文字</Label>
        <Input
          :id="textInputId"
          v-model="typedText"
          type="text"
          placeholder="例如：张三、2026年9月20日"
          autocomplete="off"
          :aria-invalid="Boolean(formError)"
          data-testid="signature-text-input"
          @input="formError = null"
        />
        <div
          class="signature-creation-surface flex h-[140px] items-center overflow-auto rounded-lg border border-dashed px-4"
          aria-label="文字签名预览"
          data-testid="signature-text-preview"
        >
          <span
            v-if="typedText.trim()"
            class="mx-auto whitespace-pre text-[40px]"
            :style="{
              color: penColor,
              fontFamily: TEXT_FONT_FAMILY,
              fontWeight: textFontWeight,
            }"
          >
            {{ typedText.trim() }}
          </span>
          <span v-else class="m-auto text-meta text-[#6b7280]">输入后在此预览</span>
        </div>
      </div>

      <Alert v-if="formError" variant="destructive" data-testid="pad-error">
        <AlertDescription>{{ formError }}</AlertDescription>
      </Alert>

      <Separator />
      <DialogFooter
        class="flex-row flex-wrap items-center justify-between gap-3 sm:justify-between"
      >
        <Button type="button" variant="ghost" :disabled="!hasContent" @click="handleClear">
          {{ mode === "handwriting" ? "清空重写" : "清空输入" }}
        </Button>
        <div class="flex gap-2">
          <Button type="button" variant="ghost" :disabled="isSaving" @click="handleClose"
            >取消</Button
          >
          <Button type="button" variant="default" :disabled="!canSave" @click="handleSave">
            <Spinner v-if="isSaving" data-icon="inline-start" aria-label="正在保存" />
            {{ isSaving ? "保存中…" : "保存到签名库" }}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
