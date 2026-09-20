import { computed, reactive, ref, watch } from "vue";
import type { PageViewport } from "pdfjs-dist";
import type { Matrix6, SignaturePlacement } from "../types/pdf";
import type { SignatureAsset, SignatureTemplate } from "../types/signature";
import {
  clampMatrixToViewBox,
  createPlacementMatrixAtCenter,
  defaultPlacementSize,
  maxScaleFactorWithinViewBox,
  viewportCssScale,
} from "../lib/pdfCoordinates";
import { usePdfDocument } from "./usePdfDocument";
import { useSignatureLibrary } from "./useSignatureLibrary";

/** 放置时使用的长边占页面可视宽度的比例，以及绝对上限（PDF 用户空间单位）。 */
const PLACEMENT_WIDTH_RATIO = 0.3;
const PLACEMENT_WIDTH_LIMIT = 200;
const PLACEMENT_MIN_EXTENT = 6;
const PLACEMENT_MAX_EXTENT = 600;

interface AssetEntry {
  url: string;
  pixelWidth: number;
  pixelHeight: number;
}

const placements = ref<SignaturePlacement[]>([]);
const selectedId = ref<string | null>(null);
const activeTemplateId = ref<string | null>(null);
const undoStack = ref<SignaturePlacement[][]>([]);
const redoStack = ref<SignaturePlacement[][]>([]);

/** assetId 对应的对象 URL，用于预览；会话结束或不再被引用时释放。 */
const assetEntries = reactive(new Map<string, AssetEntry>());
/** 模板在本会话中已经创建的图片，避免重复创建同一份数据。 */
const templateAssetIds = new Map<string, string>();

let gestureSnapshot: SignaturePlacement[] | null = null;
let gestureDirty = false;

function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function cloneSnapshot(list: readonly SignaturePlacement[]): SignaturePlacement[] {
  // 实例对象在编辑时整体替换、从不原地修改，因此浅拷贝数组即可作为不可变快照。
  return list.slice();
}

function sameMatrix(left: Matrix6, right: Matrix6): boolean {
  return (
    left[0] === right[0] &&
    left[1] === right[1] &&
    left[2] === right[2] &&
    left[3] === right[3] &&
    left[4] === right[4] &&
    left[5] === right[5]
  );
}

/** 会话切换时清空编辑状态，并释放上一份会话的图片资源。 */
function resetEditorState(): void {
  placements.value = [];
  selectedId.value = null;
  activeTemplateId.value = null;
  undoStack.value = [];
  redoStack.value = [];
  gestureSnapshot = null;
  gestureDirty = false;
  templateAssetIds.clear();
  releaseUnusedAssets();
}

/** 释放不再被实例或撤销/重做记录引用的图片 URL。 */
function releaseUnusedAssets(): void {
  const referenced = new Set<string>();
  const collect = (list: readonly SignaturePlacement[]) => {
    for (const placement of list) {
      referenced.add(placement.assetId);
    }
  };
  collect(placements.value);
  for (const snapshot of undoStack.value) {
    collect(snapshot);
  }
  for (const snapshot of redoStack.value) {
    collect(snapshot);
  }
  if (gestureSnapshot) {
    collect(gestureSnapshot);
  }

  for (const [assetId, entry] of assetEntries) {
    if (referenced.has(assetId)) {
      continue;
    }
    URL.revokeObjectURL(entry.url);
    assetEntries.delete(assetId);
    for (const [templateId, mappedAssetId] of templateAssetIds) {
      if (mappedAssetId === assetId) {
        templateAssetIds.delete(templateId);
      }
    }
  }
}

function pushUndo(snapshot: SignaturePlacement[]): void {
  undoStack.value = [...undoStack.value, snapshot];
  redoStack.value = [];
}

/** 页面签名实例的选择、放置、调整与撤销重做。 */
export function useSignatureEditor() {
  const { session } = usePdfDocument();
  const { findTemplate } = useSignatureLibrary();

  watch(session, () => {
    resetEditorState();
  });

  const placementsByPage = computed(() => {
    const grouped = new Map<number, SignaturePlacement[]>();
    for (const placement of placements.value) {
      const list = grouped.get(placement.pageIndex);
      if (list) {
        list.push(placement);
      } else {
        grouped.set(placement.pageIndex, [placement]);
      }
    }
    return grouped;
  });

  const isPlacing = computed(
    () => activeTemplateId.value !== null && findTemplate(activeTemplateId.value) !== null,
  );
  const canUndo = computed(() => undoStack.value.length > 0);
  const canRedo = computed(() => redoStack.value.length > 0);
  const selectedPlacement = computed(
    () => placements.value.find((placement) => placement.id === selectedId.value) ?? null,
  );

  function placementsForPage(pageIndex: number): SignaturePlacement[] {
    return placementsByPage.value.get(pageIndex) ?? [];
  }

  function assetUrl(assetId: string): string | undefined {
    return assetEntries.get(assetId)?.url;
  }

  function selectPlacement(id: string | null): void {
    selectedId.value = id;
  }

  /** 进入放置状态；再次选择同一个模板时取消放置。 */
  function beginPlacement(templateId: string): void {
    activeTemplateId.value = activeTemplateId.value === templateId ? null : templateId;
  }

  function cancelPlacement(): void {
    activeTemplateId.value = null;
  }

  /**
   * 首次使用模板时把图片数据放入当前会话。
   * 实例只引用会话图片，因此删除模板不会影响已放置的实例与撤销记录。
   */
  function ensureAsset(template: SignatureTemplate): string {
    const existing = templateAssetIds.get(template.id);
    if (existing && assetEntries.has(existing)) {
      return existing;
    }

    const currentSession = session.value;
    if (!currentSession) {
      throw new Error("当前没有已打开的文档。");
    }

    const assetId = createId("asset");
    const asset: SignatureAsset = {
      assetId,
      blob: template.blob,
      pixelWidth: template.pixelWidth,
      pixelHeight: template.pixelHeight,
    };
    currentSession.assets.set(assetId, asset);
    assetEntries.set(assetId, {
      url: URL.createObjectURL(template.blob),
      pixelWidth: template.pixelWidth,
      pixelHeight: template.pixelHeight,
    });
    templateAssetIds.set(template.id, assetId);
    return assetId;
  }

  /** 在当前页面放置一份实例，返回新实例编号。 */
  function placeAt(
    pageIndex: number,
    viewport: PageViewport,
    center: { x: number; y: number },
    templateId: string,
  ): string | null {
    const template = findTemplate(templateId);
    if (!template) {
      return null;
    }

    let assetId: string;
    try {
      assetId = ensureAsset(template);
    } catch {
      return null;
    }

    // 初始尺寸按 PDF 用户空间计算，因此不随当前缩放比例变化。
    const cssScale = viewportCssScale(viewport);
    const visualWidthPdf = viewport.width / cssScale;
    const targetWidthPdf = Math.min(PLACEMENT_WIDTH_LIMIT, visualWidthPdf * PLACEMENT_WIDTH_RATIO);
    const size = defaultPlacementSize(
      template.pixelWidth,
      template.pixelHeight,
      targetWidthPdf * cssScale,
    );

    // 点击位置可能就在页面边缘：初次放置也要收进页面可见区域内。
    // 预览层不裁剪越界部分，导出却受页面可见区域限制，不约束就会出现
    // 「预览完整、导出被切掉一角」的不一致。
    const placementMatrix = createPlacementMatrixAtCenter(
      viewport,
      center,
      size.width,
      size.height,
    );
    const geometry = session.value?.pages[pageIndex];

    const placement: SignaturePlacement = {
      id: createId("placement"),
      assetId,
      pageIndex,
      matrix: geometry ? clampMatrixToViewBox(placementMatrix, geometry.viewBox) : placementMatrix,
    };

    pushUndo(cloneSnapshot(placements.value));
    placements.value = [...placements.value, placement];
    selectedId.value = placement.id;
    releaseUnusedAssets();
    return placement.id;
  }

  function removePlacement(id: string): void {
    if (!placements.value.some((placement) => placement.id === id)) {
      return;
    }
    pushUndo(cloneSnapshot(placements.value));
    placements.value = placements.value.filter((placement) => placement.id !== id);
    if (selectedId.value === id) {
      selectedId.value = null;
    }
    releaseUnusedAssets();
  }

  /** 开始一次拖动或缩放，记录快照以便结束时只写入一条撤销记录。 */
  function beginTransform(): void {
    gestureSnapshot = cloneSnapshot(placements.value);
    gestureDirty = false;
  }

  /**
   * 应用新的实例矩阵。页面范围内的位置约束在这里统一处理，
   * 组件不直接修改共享实例数组。
   */
  function applyMatrix(id: string, matrix: Matrix6): void {
    const current = placements.value.find((placement) => placement.id === id);
    if (!current) {
      return;
    }
    const geometry = session.value?.pages[current.pageIndex];
    const next = geometry ? clampMatrixToViewBox(matrix, geometry.viewBox) : matrix;
    if (sameMatrix(current.matrix, next)) {
      return;
    }
    gestureDirty = true;
    placements.value = placements.value.map((placement) =>
      placement.id === id ? { ...placement, matrix: next } : placement,
    );
  }

  /** 当前页面允许的最大放大倍数，用于把缩放限制在可见页面区域。 */
  function maxScaleFactor(pageIndex: number, matrix: Matrix6): number {
    const geometry = session.value?.pages[pageIndex];
    return geometry ? maxScaleFactorWithinViewBox(matrix, geometry.viewBox) : 1;
  }

  /** 结束一次拖动或缩放；没有实际变化时不产生撤销记录。 */
  function endTransform(): void {
    const snapshot = gestureSnapshot;
    gestureSnapshot = null;
    if (snapshot && gestureDirty) {
      pushUndo(snapshot);
    }
    gestureDirty = false;
    releaseUnusedAssets();
  }

  function undo(): void {
    const snapshot = undoStack.value.at(-1);
    if (!snapshot) {
      return;
    }
    redoStack.value = [...redoStack.value, cloneSnapshot(placements.value)];
    undoStack.value = undoStack.value.slice(0, -1);
    placements.value = cloneSnapshot(snapshot);
    syncSelection();
    releaseUnusedAssets();
  }

  function redo(): void {
    const snapshot = redoStack.value.at(-1);
    if (!snapshot) {
      return;
    }
    undoStack.value = [...undoStack.value, cloneSnapshot(placements.value)];
    redoStack.value = redoStack.value.slice(0, -1);
    placements.value = cloneSnapshot(snapshot);
    syncSelection();
    releaseUnusedAssets();
  }

  function syncSelection(): void {
    if (selectedId.value && !placements.value.some((item) => item.id === selectedId.value)) {
      selectedId.value = null;
    }
  }

  function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    if (target.isContentEditable) {
      return true;
    }
    const tagName = target.tagName;
    return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
  }

  /**
   * 键盘快捷键入口。文本框获得焦点时，删除与撤销不作用于页面签名。
   */
  function handleKeydown(event: KeyboardEvent): boolean {
    if (event.key === "Escape") {
      if (isPlacing.value) {
        cancelPlacement();
        return true;
      }
      if (selectedId.value) {
        selectPlacement(null);
        return true;
      }
      return false;
    }
    if (isEditableTarget(event.target)) {
      return false;
    }

    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === "z") {
      if (event.shiftKey) {
        redo();
      } else {
        undo();
      }
      return true;
    }
    if (modifier && event.key.toLowerCase() === "y") {
      redo();
      return true;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && selectedId.value) {
      removePlacement(selectedId.value);
      return true;
    }
    return false;
  }

  return {
    placements,
    placementsByPage,
    placementsForPage,
    selectedId,
    selectedPlacement,
    activeTemplateId,
    isPlacing,
    canUndo,
    canRedo,
    assetUrl,
    selectPlacement,
    beginPlacement,
    cancelPlacement,
    placeAt,
    removePlacement,
    beginTransform,
    applyMatrix,
    maxScaleFactor,
    endTransform,
    undo,
    redo,
    handleKeydown,
    limits: {
      minExtent: PLACEMENT_MIN_EXTENT,
      maxExtent: PLACEMENT_MAX_EXTENT,
    },
  };
}

/** 供外部（如应用卸载）释放全部图片 URL。 */
export function releaseAllAssetUrls(): void {
  for (const entry of assetEntries.values()) {
    URL.revokeObjectURL(entry.url);
  }
  assetEntries.clear();
  templateAssetIds.clear();
}
