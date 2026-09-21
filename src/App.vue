<script setup lang="ts">
import { onBeforeUnmount } from "vue";
import { RouterView } from "vue-router";
import {
  initSignatureEditor,
  disposeSignatureEditor,
  releaseAllAssetUrls,
} from "./composables/useSignatureEditor";

// 编辑器的共享会话监听跨页面存活；路由页面只负责自己的界面与文档。
initSignatureEditor();
onBeforeUnmount(() => {
  disposeSignatureEditor();
  releaseAllAssetUrls();
});
</script>

<template>
  <RouterView />
</template>
