<script setup lang="ts">
import { ref } from "vue";
import { onBeforeRouteLeave, useRouter } from "vue-router";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { useConfirmDialog } from "../composables/useConfirmDialog";
import { usePdfDocument } from "../composables/usePdfDocument";
import { useSignedDocumentConfirm } from "../composables/useSignedDocumentConfirm";

const router = useRouter();
const { session, isLoading, loadError, openFile } = usePdfDocument();
const { dialog, isConfirmOpen, settleConfirm } = useConfirmDialog();
const { confirmSignedDocumentEdit } = useSignedDocumentConfirm();
const fileInputRef = ref<HTMLInputElement | null>(null);

/** 复用文档校验和数字签名确认，成功建立会话后才进入操作页。 */
async function handleFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
    loadError.value = "当前只支持 PDF 文件。";
    return;
  }
  await openFile(file, { confirmSignedDocument: confirmSignedDocumentEdit });
  if (session.value) await router.push({ name: "editor" });
}

// 避免加载或确认尚未完成时离开首页，遗留不可见的待处理文件。
onBeforeRouteLeave(() => !isLoading.value && !isConfirmOpen.value);
</script>

<template>
  <main class="home">
    <header class="home-header">
      <a class="wordmark" href="#/" aria-label="PDFInk 首页"
        >pdf<span>ink</span><span class="brand-dot">.</span></a
      >
      <span class="header-note">让签名，回到简单。</span>
    </header>

    <section class="home-intro" aria-labelledby="home-title">
      <h1 id="home-title">签好 PDF，<br /><span>就是这么简单。</span></h1>
      <p class="intro-copy">
        打开文档，添加手写签名，下载签好的 PDF。<br />常用签名保存一次，下次继续使用。
      </p>
      <div class="file-action">
        <button
          class="select-file"
          type="button"
          :disabled="isLoading || isConfirmOpen"
          @click="fileInputRef?.click()"
        >
          <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            aria-hidden="true"
          >
            <path d="M12 16V4m-4 4 4-4 4 4M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" />
          </svg>
          {{ isLoading ? "正在打开 PDF…" : "选择 PDF 文件" }}
        </button>
        <input
          ref="fileInputRef"
          class="sr-only"
          data-focus-skip
          tabindex="-1"
          aria-label="选择 PDF 文件"
          type="file"
          accept="application/pdf,.pdf"
          :disabled="isLoading || isConfirmOpen"
          @change="handleFileChange"
        />
        <p class="action-note" role="status">
          {{ isLoading ? "正在本地处理，请稍候。" : "仅在浏览器本地处理，无需上传" }}
        </p>
        <p v-if="loadError" class="load-error" role="alert">{{ loadError }} 请重新选择文件。</p>
      </div>

      <figure class="signature-sample" aria-label="手写签名示例">
        <div class="signature-sheet">
          <span class="sample-label">签名</span>
          <svg class="sample-ink" viewBox="0 0 320 100" fill="none" aria-hidden="true">
            <g
              stroke="currentColor"
              stroke-width="1.65"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path
                class="ink-stroke"
                pathLength="1"
                d="M34 70C54 43 78 14 86 21C93 29 57 81 49 81C43 80 53 50 77 49C90 50 74 65 75 70C77 75 91 57 98 55C107 52 96 69 105 67C122 63 139 33 139 19C139 9 126 20 120 39C110 68 112 77 123 70L145 52C152 48 143 63 149 65C154 68 165 51 170 51C175 53 163 67 169 69C179 73 197 49 197 46C194 36 174 57 182 62C188 66 207 50 216 46C223 42 202 77 209 79C217 82 238 43 248 36C259 27 247 61 249 65C253 72 273 50 286 55"
              />
              <path
                class="ink-stroke ink-underline"
                pathLength="1"
                d="M67 87C129 75 218 73 277 78"
              />
            </g>
          </svg>
          <span class="signature-rule" aria-hidden="true"></span>
          <span class="sample-caption">你的笔迹，自然落在文档上。</span>
        </div>
        <figcaption>手写笔迹示例</figcaption>
      </figure>
    </section>

    <footer class="home-footer">
      <p>
        免费使用<span aria-hidden="true"> / </span>保存常用签名<span aria-hidden="true"> / </span
        >自由调整位置<span aria-hidden="true"> / </span>下载新的 PDF
      </p>
      <p class="privacy-note">
        <svg
          viewBox="0 0 20 20"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
          aria-hidden="true"
        >
          <rect x="4.5" y="8" width="11" height="8.5" rx="2" />
          <path d="M7 8V5.5a3 3 0 0 1 6 0V8m-3 3v2.5" /></svg
        >文件留在本地，原件保持不变。
      </p>
    </footer>

    <ConfirmDialog
      v-if="dialog"
      :key="dialog.id"
      :title="dialog.title"
      :message="dialog.message"
      :details="dialog.details"
      :confirm-label="dialog.confirmLabel"
      :cancel-label="dialog.cancelLabel"
      :tone="dialog.tone"
      @confirm="settleConfirm(true)"
      @cancel="settleConfirm(false)"
    />
  </main>
</template>

<style scoped>
.home {
  --home-paper: #fafaf9;
  --home-ink: #252527;
  --home-muted: #6d6d72;
  --home-line: #dededc;
  height: 100%;
  overflow-y: auto;
  color: var(--home-ink);
  background: var(--home-paper);
  color-scheme: light;
  display: flex;
  flex-direction: column;
  padding: 0 clamp(24px, 5vw, 80px);
  scrollbar-color: #b8b8b5 var(--home-paper);
}
.home ::selection {
  background: #dadad5;
  color: #202022;
}
.home-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 92px;
  flex-shrink: 0;
}
.wordmark {
  color: inherit;
  text-decoration: none;
  font-size: 29px;
  font-weight: 650;
  letter-spacing: -1px;
}
.wordmark span {
  font-weight: 350;
}
.wordmark .brand-dot {
  font-weight: 700;
}
.header-note {
  color: var(--home-muted);
  font-size: 12px;
}
.home-intro {
  flex: 1;
  width: 100%;
  max-width: 880px;
  margin: 0 auto;
  padding: clamp(28px, 5vh, 64px) 0 30px;
  text-align: center;
}
h1 {
  font-family: "Songti SC", "Noto Serif CJK SC", "SimSun", serif;
  font-size: clamp(38px, 4.4vw, 62px);
  font-weight: 500;
  line-height: 1.35;
  letter-spacing: -0.035em;
}
h1 span {
  color: #565659;
}
.intro-copy {
  margin-top: 23px;
  color: var(--home-muted);
  font-size: 15px;
  line-height: 1.9;
}
.file-action {
  margin-top: 30px;
}
.select-file {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 54px;
  padding: 0 28px;
  border: 1px solid var(--home-ink);
  border-radius: 7px;
  background: var(--home-ink);
  color: #fff;
  font-size: 15px;
  cursor: pointer;
  transition:
    background 0.18s,
    transform 0.18s;
}
.select-file:hover:enabled {
  background: #424246;
  transform: translateY(-1px);
}
.select-file:active:enabled {
  transform: translateY(0);
}
.select-file:disabled {
  opacity: 0.6;
  cursor: wait;
}
.select-file:focus-visible,
.wordmark:focus-visible {
  outline: 2px solid #68686d;
  outline-offset: 5px;
}
.action-note {
  margin-top: 13px;
  font-size: 12px;
  color: var(--home-muted);
  min-height: 18px;
}
.load-error {
  margin: 12px auto 0;
  max-width: 480px;
  color: #a33129;
  font-size: 13px;
}
.signature-sample {
  width: min(100%, 380px);
  margin: 44px auto 0;
}
.signature-sheet {
  position: relative;
  text-align: left;
  padding: 20px 28px 18px;
  background: #fff;
  box-shadow: 0 6px 24px -12px #25252726;
}
.sample-label,
.sample-caption {
  display: block;
  color: var(--home-muted);
  font-size: 10px;
}
.sample-ink {
  display: block;
  width: 100%;
  height: 88px;
  color: #343b4c;
}
.signature-rule {
  display: block;
  height: 1px;
  background: var(--home-line);
}
.sample-caption {
  margin-top: 10px;
}
figcaption {
  margin-top: 12px;
  color: var(--home-muted);
  font-size: 10px;
}
.ink-stroke {
  stroke-dasharray: 1;
  stroke-dashoffset: 0;
  animation: ink-write 1.5s cubic-bezier(0.16, 1, 0.3, 1) both;
}
.ink-underline {
  animation-delay: 0.3s;
}
@keyframes ink-write {
  from {
    stroke-dashoffset: 1;
  }
  to {
    stroke-dashoffset: 0;
  }
}
.home-footer {
  flex-shrink: 0;
  border-top: 1px solid var(--home-line);
  padding: 23px 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  color: var(--home-muted);
  font-size: 11px;
}
.home-footer span {
  padding: 0 10px;
  color: #96969a;
}
.privacy-note {
  display: flex;
  align-items: center;
  gap: 7px;
}
@media (max-width: 600px) {
  .home-header {
    min-height: 72px;
  }
  .header-note {
    font-size: 10px;
  }
  .home-intro {
    padding-top: 30px;
  }
  .signature-sample {
    margin-top: 34px;
  }
  .home-footer {
    flex-direction: column;
    text-align: center;
    gap: 12px;
    padding: 20px 0;
  }
  .home-footer span {
    padding: 0 5px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .ink-stroke {
    animation: none;
  }
  .select-file {
    transition: none;
  }
}
</style>
