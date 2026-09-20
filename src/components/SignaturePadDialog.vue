<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import SignaturePad from "signature_pad";
import type { SignatureTemplate } from "../types/signature";
import { useSignatureLibrary } from "../composables/useSignatureLibrary";

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  close: [];
  saved: [template: SignatureTemplate];
}>();

/** 裁剪时在笔迹四周保留的空白，单位是画布像素。 */
const CROP_PADDING = 12;

const { saveTemplate, libraryError, clearLibraryError } = useSignatureLibrary();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const nameInputRef = ref<HTMLInputElement | null>(null);
const signerName = ref("");
const formError = ref<string | null>(null);
const isSaving = ref(false);
const hasInk = ref(false);

let pad: SignaturePad | null = null;

const canSave = computed(() => signerName.value.trim().length > 0 && !isSaving.value);

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

function createPad(): void {
  const canvas = canvasRef.value;
  if (!canvas) {
    return;
  }
  syncCanvasResolution();
  pad = new SignaturePad(canvas, {
    minWidth: 1,
    maxWidth: 3.6,
    penColor: "#101828",
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

function resetState(): void {
  signerName.value = "";
  formError.value = null;
  hasInk.value = false;
  clearLibraryError();
}

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
      nameInputRef.value?.focus();
    } else {
      detachLifecycle();
      destroyPad();
    }
  },
);

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
  pad?.clear();
  hasInk.value = false;
  formError.value = null;
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

  if (!signerName.value.trim()) {
    formError.value = "请先填写签名名称。";
    return;
  }

  const canvas = canvasRef.value;
  if (!pad || !canvas) {
    formError.value = "签名画布尚未就绪，请重新打开窗口。";
    return;
  }
  if (pad.isEmpty()) {
    formError.value = "画布还是空白的，请先手写签名。";
    return;
  }

  // 保存闸门必须在进入第一个异步操作之前合上。cropToInk 里的 toBlob 是异步的，
  // 若等到裁剪完成才置位 isSaving，这段窗口内保存按钮仍可点击（canSave 只看 !isSaving），
  // 会启动第二次写入；取消按钮同样放行（handleClose 也只看 isSaving），
  // 于是出现「窗口已经关掉、签名却还是存进去了」。裁剪与存储一起纳入 try/finally。
  isSaving.value = true;
  try {
    const cropped = await cropToInk(canvas);
    if (!cropped) {
      formError.value = "没有检测到笔迹，请重新手写签名。";
      return;
    }

    const template = await saveTemplate({
      name: signerName.value,
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
      class="flex w-full max-w-[560px] animate-panel-in flex-col gap-3.5 rounded-[10px] bg-surface p-4.5 shadow-panel motion-reduce:animate-none"
    >
      <header class="flex items-center justify-between gap-2.5">
        <h2>新建签名</h2>
        <button type="button" class="button button--ghost" @click="handleClose">关闭</button>
      </header>

      <label class="flex flex-col gap-1.5">
        <span class="text-meta text-ink-muted">签名名称</span>
        <input
          ref="nameInputRef"
          v-model="signerName"
          class="input"
          data-testid="pad-name-input"
          type="text"
          maxlength="40"
          placeholder="例如：我的签名"
          @keydown.enter.prevent="handleSave"
        />
      </label>

      <div class="flex flex-col gap-1.5">
        <canvas
          ref="canvasRef"
          class="hatch h-[200px] w-full cursor-crosshair touch-none rounded-lg border border-dashed border-line-strong"
          aria-label="手写签名区域"
          data-testid="signature-pad-canvas"
        ></canvas>
        <p class="text-micro text-ink-muted">
          按住鼠标（或触控笔）在虚线框内书写，支持高像素密度屏幕。
        </p>
      </div>

      <p v-if="formError" class="text-meta text-danger" role="alert" data-testid="pad-error">
        {{ formError }}
      </p>

      <footer class="flex items-center justify-between gap-2.5">
        <button type="button" class="button button--ghost" :disabled="!hasInk" @click="handleClear">
          清空重写
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
