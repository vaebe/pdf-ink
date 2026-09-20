import { computed, shallowRef } from "vue";

/** 确认弹窗的语气：`warning` 用琥珀色警示图标，`primary` 用品牌色信息图标。 */
export type ConfirmTone = "primary" | "warning";

/** 发起确认时的调用参数。 */
export interface ConfirmDialogOptions {
  title: string;
  message: string;
  /** 补充说明，逐条列出，例如「原始文件不会被修改」。 */
  details?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
}

/** 弹窗渲染所需的完整状态，字段均已填好默认值。 */
export interface ConfirmDialogState extends Required<ConfirmDialogOptions> {
  /** 每次请求递增，供视图层用 `key` 重建组件并重置内部状态。 */
  id: number;
}

const dialog = shallowRef<ConfirmDialogState | null>(null);
const isConfirmOpen = computed(() => dialog.value !== null);

/** 当前待结算请求的 resolve；同一时刻只允许一个待决弹窗。 */
let resolvePending: ((confirmed: boolean) => void) | null = null;
let dialogId = 0;

/**
 * 确认弹窗状态。以 Promise 形式返回用户选择，便于在异步流程中直接 `await`。
 *
 * 同一时刻只保留一个弹窗：再次发起时旧请求按「取消」结算，
 * 避免调用方永远悬挂在未被处理的 Promise 上。
 */
export function useConfirmDialog() {
  function requestConfirm(options: ConfirmDialogOptions): Promise<boolean> {
    settleConfirm(false);
    return new Promise<boolean>((resolve) => {
      resolvePending = resolve;
      dialogId += 1;
      dialog.value = {
        id: dialogId,
        title: options.title,
        message: options.message,
        details: options.details ?? [],
        confirmLabel: options.confirmLabel ?? "确定",
        cancelLabel: options.cancelLabel ?? "取消",
        tone: options.tone ?? "warning",
      };
    });
  }

  /** 以用户的选择结算当前弹窗并关闭。 */
  function settleConfirm(confirmed: boolean): void {
    const resolve = resolvePending;
    resolvePending = null;
    dialog.value = null;
    resolve?.(confirmed);
  }

  return { dialog, isConfirmOpen, requestConfirm, settleConfirm };
}
