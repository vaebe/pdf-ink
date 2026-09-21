<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import type { PageViewport } from "pdfjs-dist";
import type { Matrix6 } from "../types/pdf";
import type { Point } from "../lib/pdfCoordinates";
import {
  applyMatrix,
  matrixExtent,
  matrixToDomPlacement,
  scaleMatrixAbout,
  translateMatrix,
  viewportDeltaToPdf,
} from "../lib/pdfCoordinates";
import { useSignatureEditor } from "../composables/useSignatureEditor";

const props = defineProps<{
  pageIndex: number;
  viewport: PageViewport | null;
}>();

const {
  placementsForPage,
  activeTemplateId,
  isPlacing,
  assetUrl,
  selectPlacement,
  placeAt,
  removePlacement,
  beginTransform,
  applyMatrix: commitMatrix,
  maxScaleFactor,
  endTransform,
  limits,
} = useSignatureEditor();

interface MoveGesture {
  kind: "move";
  placementId: string;
  originMatrix: Matrix6;
  startLocal: Point;
}

interface ResizeGesture {
  kind: "resize";
  placementId: string;
  originMatrix: Matrix6;
  anchorU: number;
  anchorV: number;
  anchorLocal: Point;
  handleLocal: Point;
  minFactor: number;
  maxFactor: number;
}

const overlayRef = ref<HTMLDivElement | null>(null);
const controlsPlacementId = ref<string | null>(null);

/** 把指针事件换算为页面内容区坐标。 */
function toLocalPoint(event: PointerEvent): Point {
  const overlay = overlayRef.value;
  if (!overlay) {
    return { x: 0, y: 0 };
  }
  const rect = overlay.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

/** 图片单位空间的角点换算为页面内容区坐标。 */
function cornerToLocal(matrix: Matrix6, u: number, v: number): Point {
  const viewport = props.viewport;
  if (!viewport) {
    return { x: 0, y: 0 };
  }
  const pdfPoint = applyMatrix(matrix, u, v);
  const [x, y] = viewport.convertToViewportPoint(pdfPoint.x, pdfPoint.y);
  return { x, y };
}

const items = computed(() => {
  const viewport = props.viewport;
  if (!viewport) {
    return [];
  }
  return placementsForPage(props.pageIndex).map((placement) => ({
    id: placement.id,
    placement,
    url: assetUrl(placement.assetId) ?? "",
    dom: matrixToDomPlacement(placement.matrix, viewport),
  }));
});

const controlsPlacement = computed(
  () => items.value.find((item) => item.id === controlsPlacementId.value)?.placement ?? null,
);

const selectedCorners = computed(() => {
  const viewport = props.viewport;
  const placement = controlsPlacement.value;
  if (!viewport || !placement || placement.pageIndex !== props.pageIndex) {
    return null;
  }
  const matrix = placement.matrix;
  return {
    topLeft: cornerToLocal(matrix, 0, 1),
    topRight: cornerToLocal(matrix, 1, 1),
    bottomLeft: cornerToLocal(matrix, 0, 0),
    bottomRight: cornerToLocal(matrix, 1, 0),
  };
});

const selectionBox = computed(() => {
  const corners = selectedCorners.value;
  if (!corners) {
    return null;
  }
  const points = [corners.topLeft, corners.topRight, corners.bottomLeft, corners.bottomRight];
  const left = Math.min(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const right = Math.max(...points.map((point) => point.x));
  const bottom = Math.max(...points.map((point) => point.y));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
});

/** 四个缩放手柄，锚点是它的对角。 */
const HANDLES = [
  { name: "topLeft", u: 0, v: 1, anchorU: 1, anchorV: 0, cursor: "nwse-resize" },
  { name: "topRight", u: 1, v: 1, anchorU: 0, anchorV: 0, cursor: "nesw-resize" },
  { name: "bottomLeft", u: 0, v: 0, anchorU: 1, anchorV: 1, cursor: "nesw-resize" },
  { name: "bottomRight", u: 1, v: 0, anchorU: 0, anchorV: 1, cursor: "nwse-resize" },
] as const;

const handlePositions = computed(() => {
  const corners = selectedCorners.value;
  if (!corners) {
    return [];
  }
  const byCorner = {
    topLeft: corners.topLeft,
    topRight: corners.topRight,
    bottomLeft: corners.bottomLeft,
    bottomRight: corners.bottomRight,
  };
  return HANDLES.map((handle) => ({ ...handle, point: byCorner[handle.name] }));
});

/** 阻止事件继续冒泡到页面编辑层。 */
function blockPointer(event: Event): void {
  event.stopPropagation();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

let gesture: MoveGesture | ResizeGesture | null = null;
let hideControlsTimer: number | null = null;

function cancelControlsHide(): void {
  if (hideControlsTimer === null) {
    return;
  }
  window.clearTimeout(hideControlsTimer);
  hideControlsTimer = null;
}

function queueControlsHide(placementId: string): void {
  cancelControlsHide();
  hideControlsTimer = window.setTimeout(() => {
    hideControlsTimer = null;
    if (gesture) {
      queueControlsHide(placementId);
      return;
    }
    if (controlsPlacementId.value === placementId) {
      controlsPlacementId.value = null;
    }
  }, 120);
}

function handleControlsPointerEnter(placementId: string): void {
  cancelControlsHide();
  controlsPlacementId.value = placementId;
}

function handleControlsPointerLeave(event: PointerEvent, placementId: string): void {
  if (event.pointerType === "mouse") {
    queueControlsHide(placementId);
  }
}

function attachGestureListeners(target: HTMLElement, onMove: (event: PointerEvent) => void): void {
  const finish = () => {
    target.removeEventListener("pointermove", onMove);
    target.removeEventListener("pointerup", finish);
    target.removeEventListener("pointercancel", finish);
    gesture = null;
    endTransform();
  };
  target.addEventListener("pointermove", onMove);
  target.addEventListener("pointerup", finish);
  target.addEventListener("pointercancel", finish);
}

/** 点击已有实例只选中，不额外添加。 */
function handleItemPointerDown(event: PointerEvent, placementId: string): void {
  if (event.pointerType === "mouse" && event.button !== 0) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  handleControlsPointerEnter(placementId);
  selectPlacement(placementId);

  const origin = items.value.find((item) => item.id === placementId)?.placement;
  const target = event.currentTarget;
  const viewport = props.viewport;
  if (!origin || !viewport || !(target instanceof HTMLElement)) {
    return;
  }

  const startLocal = toLocalPoint(event);
  const originMatrix: Matrix6 = [...origin.matrix];
  beginTransform();
  gesture = {
    kind: "move",
    placementId,
    originMatrix,
    startLocal,
  };
  target.setPointerCapture(event.pointerId);

  attachGestureListeners(target, (moveEvent) => {
    if (gesture?.kind !== "move" || gesture.placementId !== placementId) {
      return;
    }
    const current = toLocalPoint(moveEvent);
    const delta = viewportDeltaToPdf(viewport, current.x - startLocal.x, current.y - startLocal.y);
    commitMatrix(placementId, translateMatrix(originMatrix, delta.x, delta.y));
  });
}

function handleResizePointerDown(event: PointerEvent, handle: (typeof HANDLES)[number]): void {
  if (event.pointerType === "mouse" && event.button !== 0) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();

  const placement = controlsPlacement.value;
  const viewport = props.viewport;
  const target = event.currentTarget;
  if (!placement || !viewport || !(target instanceof HTMLElement)) {
    return;
  }

  const originMatrix: Matrix6 = [...placement.matrix];
  const anchorLocal = cornerToLocal(originMatrix, handle.anchorU, handle.anchorV);
  const handleLocal = cornerToLocal(originMatrix, handle.u, handle.v);
  const extent = matrixExtent(originMatrix);
  const longest = Math.max(extent.width, extent.height);

  gesture = {
    kind: "resize",
    placementId: placement.id,
    originMatrix,
    anchorU: handle.anchorU,
    anchorV: handle.anchorV,
    anchorLocal,
    handleLocal,
    minFactor: longest > 0 ? limits.minExtent / longest : 0.05,
    maxFactor:
      longest > 0
        ? Math.min(maxScaleFactor(placement.pageIndex, originMatrix), limits.maxExtent / longest)
        : 1,
  };
  beginTransform();
  target.setPointerCapture(event.pointerId);

  attachGestureListeners(target, (moveEvent) => {
    if (gesture?.kind !== "resize" || gesture.placementId !== placement.id) {
      return;
    }
    const pointer = toLocalPoint(moveEvent);
    const vectorX = gesture.handleLocal.x - gesture.anchorLocal.x;
    const vectorY = gesture.handleLocal.y - gesture.anchorLocal.y;
    const lengthSquared = vectorX * vectorX + vectorY * vectorY;
    if (!(lengthSquared > 0)) {
      return;
    }
    const projected =
      ((pointer.x - gesture.anchorLocal.x) * vectorX +
        (pointer.y - gesture.anchorLocal.y) * vectorY) /
      lengthSquared;
    const factor = clamp(projected, gesture.minFactor, gesture.maxFactor);
    commitMatrix(
      placement.id,
      scaleMatrixAbout(gesture.originMatrix, factor, gesture.anchorU, gesture.anchorV),
    );
  });
}

/** 放置模式下，点击页面空白处添加一份实例；放置一次后由编辑器退出放置模式。 */
function handleBackgroundPointerDown(event: PointerEvent): void {
  if (!isPlacing.value) {
    return;
  }
  const viewport = props.viewport;
  const templateId = activeTemplateId.value;
  if (!viewport || !templateId) {
    return;
  }
  if (event.pointerType === "mouse" && event.button !== 0) {
    return;
  }
  event.preventDefault();
  placeAt(props.pageIndex, viewport, toLocalPoint(event), templateId);
}

function handleRemovePlacement(): void {
  const placementId = controlsPlacementId.value;
  if (!placementId) {
    return;
  }
  removePlacement(placementId);
  controlsPlacementId.value = null;
  cancelControlsHide();
}

onBeforeUnmount(() => {
  cancelControlsHide();
});
</script>

<template>
  <div
    ref="overlayRef"
    class="absolute inset-0 z-3"
    :class="
      isPlacing && props.viewport ? 'pointer-events-auto cursor-crosshair' : 'pointer-events-none'
    "
    @pointerdown="handleBackgroundPointerDown"
  >
    <div
      v-for="item in items"
      :key="item.id"
      class="pointer-events-auto absolute left-0 top-0 cursor-move touch-none origin-top-left"
      data-testid="placement"
      :style="{
        width: `${item.dom.width}px`,
        height: `${item.dom.height}px`,
        transform: item.dom.transform,
      }"
      @pointerenter="handleControlsPointerEnter(item.id)"
      @pointerleave="handleControlsPointerLeave($event, item.id)"
      @pointerdown="handleItemPointerDown($event, item.id)"
    >
      <img
        class="block size-full select-none [-webkit-user-drag:none]"
        :class="controlsPlacementId === item.id ? 'outline-1 outline-accent' : ''"
        :src="item.url"
        alt="已放置的签名"
        draggable="false"
      />
    </div>

    <template v-if="selectionBox && controlsPlacementId">
      <div
        class="pointer-events-none absolute border border-dashed border-accent"
        data-testid="placement-frame"
        :style="{
          left: `${selectionBox.left}px`,
          top: `${selectionBox.top}px`,
          width: `${selectionBox.width}px`,
          height: `${selectionBox.height}px`,
        }"
      ></div>

      <button
        type="button"
        class="pointer-events-auto absolute -translate-x-1/2 cursor-pointer rounded-sm border border-accent bg-surface px-2 py-[3px] text-micro text-accent-strong"
        data-testid="placement-delete"
        :style="{
          left: `${selectionBox.left + selectionBox.width / 2}px`,
          top: `${Math.max(selectionBox.top - 30, 2)}px`,
        }"
        @pointerenter="cancelControlsHide"
        @pointerleave="handleControlsPointerLeave($event, controlsPlacementId)"
        @pointerdown="blockPointer"
        @click.stop="handleRemovePlacement"
      >
        删除签名
      </button>

      <span
        v-for="handle in handlePositions"
        :key="handle.name"
        class="pointer-events-auto absolute -ml-1.5 -mt-1.5 size-[11px] touch-none rounded-xs border border-accent bg-surface"
        data-testid="placement-handle"
        :style="{
          left: `${handle.point.x}px`,
          top: `${handle.point.y}px`,
          cursor: handle.cursor,
        }"
        @pointerenter="cancelControlsHide"
        @pointerleave="handleControlsPointerLeave($event, controlsPlacementId)"
        @pointerdown="handleResizePointerDown($event, handle)"
      ></span>
    </template>
  </div>
</template>
