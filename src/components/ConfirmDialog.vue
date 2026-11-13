<script setup lang="ts">
import { InfoIcon, TriangleAlertIcon } from "@lucide/vue";
import type { ConfirmTone } from "../composables/useConfirmDialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";

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

const previouslyFocused =
  document.activeElement instanceof HTMLElement ? document.activeElement : null;

function restoreFocus(event: Event): void {
  event.preventDefault();
  // 文件选择器的隐藏 input 不接收返回焦点，避免回车再次打开文件选择器。
  if (previouslyFocused?.isConnected && !previouslyFocused.hasAttribute("data-focus-skip")) {
    previouslyFocused.focus();
  }
}
</script>

<template>
  <AlertDialog :open="true">
    <AlertDialogContent
      class="max-h-[calc(100dvh-40px)] overflow-y-auto sm:max-w-[440px]"
      data-testid="confirm-dialog"
      @escape-key-down.prevent.stop="emit('cancel')"
      @pointer-down-outside="emit('cancel')"
      @close-auto-focus="restoreFocus"
    >
      <AlertDialogHeader>
        <TriangleAlertIcon v-if="props.tone === 'warning'" class="text-notice" aria-hidden="true" />
        <InfoIcon v-else class="text-muted-foreground" aria-hidden="true" />
        <AlertDialogTitle data-testid="confirm-title">{{ props.title }}</AlertDialogTitle>
        <AlertDialogDescription class="[overflow-wrap:anywhere]" data-testid="confirm-message">
          {{ props.message }}
        </AlertDialogDescription>
      </AlertDialogHeader>

      <ul
        v-if="props.details.length > 0"
        class="flex list-disc flex-col gap-1 rounded-lg bg-muted py-2.5 pr-3 pl-7 text-sm text-muted-foreground"
        data-testid="confirm-details"
      >
        <li v-for="detail in props.details" :key="detail">{{ detail }}</li>
      </ul>

      <AlertDialogFooter data-testid="confirm-actions">
        <AlertDialogCancel type="button" @click="emit('cancel')">
          {{ props.cancelLabel }}
        </AlertDialogCancel>
        <AlertDialogAction type="button" @click="emit('confirm')">
          {{ props.confirmLabel }}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
