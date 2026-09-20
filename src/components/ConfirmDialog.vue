<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId } from "vue";
import type { ConfirmTone } from "../composables/useConfirmDialog";

const props = withDefaults(
  defineProps<{
    title: string;
    message: string;
    details?: string[];
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: ConfirmTone;
  }>(),
  {
    details: () => [],
    confirmLabel: "确定",
    cancelLabel: "取消",
    tone: "warning",
  },
);

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();

/** 每个实例独立 id，供 `aria-labelledby` / `aria-describedby` 关联标题与正文。 */
const dialogId = useId();
const titleId = `${dialogId}-title`;
const messageId = `${dialogId}-message`;

const panelRef = ref<HTMLElement | null>(null);
const cancelButtonRef = ref<HTMLButtonElement | null>(null);

/** 弹窗打开前的焦点位置，关闭后归还。 */
let previouslyFocused: HTMLElement | null = null;

function focusableElements(): HTMLElement[] {
  const panel = panelRef.value;
  if (!panel) {
    return [];
  }
  return Array.from(
    panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

function canRestoreFocus(element: HTMLElement | null): element is HTMLElement {
  // 打开文件的 input 是 sr-only 的（带 data-focus-skip），把焦点还给它可能让回车误触发文件选择。
  return Boolean(
    element && document.body.contains(element) && !element.hasAttribute("data-focus-skip"),
  );
}

function handleCancel(): void {
  emit("cancel");
}

/**
 * Esc 取消；Tab 在弹窗内循环，避免焦点跑到被遮罩的背景内容上。
 */
function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    handleCancel();
    return;
  }
  if (event.key !== "Tab") {
    return;
  }
  const items = focusableElements();
  if (items.length === 0) {
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  const inside = panelRef.value?.contains(active) ?? false;
  if (event.shiftKey && (active === first || !inside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

onMounted(async () => {
  previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  await nextTick();
  // 两类确认都会带来不可逆的结果，默认聚焦「取消」，避免顺手回车造成误确认。
  cancelButtonRef.value?.focus();
});

onBeforeUnmount(() => {
  if (canRestoreFocus(previouslyFocused)) {
    previouslyFocused.focus();
  }
});
</script>

<template>
  <div
    class="fixed inset-0 z-20 flex animate-scrim-in items-center justify-center bg-scrim p-5 motion-reduce:animate-none"
    data-testid="confirm-dialog"
    @click.self="handleCancel"
    @keydown="handleKeydown"
  >
    <div
      ref="panelRef"
      class="flex w-full max-w-[440px] animate-panel-in flex-col gap-4 rounded-xl bg-surface p-5 shadow-panel motion-reduce:animate-none"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      :aria-describedby="messageId"
    >
      <div class="flex items-start gap-3">
        <span
          class="grid size-[34px] flex-none place-items-center rounded-full"
          :class="
            props.tone === 'warning' ? 'bg-notice-soft text-notice' : 'bg-accent-soft text-accent'
          "
          aria-hidden="true"
        >
          <svg
            class="size-[19px]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <template v-if="props.tone === 'warning'">
              <path d="M12 4 2.8 20.2h18.4L12 4Z" />
              <path d="M12 10.2v4.4" />
              <path d="M12 17.4h.01" />
            </template>
            <template v-else>
              <circle cx="12" cy="12" r="8.6" />
              <path d="M12 11v5.4" />
              <path d="M12 7.8h.01" />
            </template>
          </svg>
        </span>
        <div class="flex min-w-0 flex-col gap-1.5">
          <h2 :id="titleId" class="text-lead" data-testid="confirm-title">{{ props.title }}</h2>
          <p
            :id="messageId"
            class="text-ink-muted [overflow-wrap:anywhere]"
            data-testid="confirm-message"
          >
            {{ props.message }}
          </p>
        </div>
      </div>

      <ul
        v-if="props.details.length > 0"
        class="flex list-disc flex-col gap-1 rounded-lg bg-subtle py-2.5 pr-3 pl-7 text-meta text-ink-muted"
        data-testid="confirm-details"
      >
        <li v-for="detail in props.details" :key="detail">{{ detail }}</li>
      </ul>

      <div class="flex justify-end gap-2" data-testid="confirm-actions">
        <button
          ref="cancelButtonRef"
          type="button"
          class="button button--ghost"
          @click="handleCancel"
        >
          {{ props.cancelLabel }}
        </button>
        <button
          type="button"
          class="button"
          :class="props.tone === 'warning' ? 'button--warning' : 'button--primary'"
          @click="emit('confirm')"
        >
          {{ props.confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
