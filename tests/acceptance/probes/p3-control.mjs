/**
 * 区分力对照工具：把 P2-4 / P2-5 的**根因**回退成旧写法，再跑一遍 p3-verify.mjs。
 *
 * 只回退「声称的根因」，不动其它任何地方——如果断言真的测的是这个根因，回退后必须变红；
 * 如果回退后依然全绿，说明断言恒真、或者根因判断错了。
 *
 *   node p3-control.mjs apply     # 备份修复版 → 写入缺陷版
 *   node p3-control.mjs restore   # 从备份还原并校验 sha256
 *   node p3-control.mjs status
 *
 * 注意 P2-4 必须**整段**回退 renderThumbnail 与 watcher：
 * 只回退 watcher 里的遍历、保留「异步返回后核对画布身份」是不足以复现的——
 * DOM 补丁总在同一个 flush 内、先于任何 await 后续步骤完成，所以身份核对一定先命中并
 * 放弃渲染，缓存不会被写脏。这条正是修复里真正承重的那一半（见 docs/code-review 第八节）。
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { REPO_ROOT, CONTROL_BACKUP } from "../harness.mjs";
import { join } from "node:path";

const ROOT = join(REPO_ROOT, "src", "components");
// 备份的是 src/ 下的源码，必须留在仓库之外：留仓库里既会被 dev server 当写入源
// 触发整页重载，也有被误提交的风险。位置可用 PDFINK_OUT 覆盖。
const BACKUP = CONTROL_BACKUP;

/** 每个文件一组替换，按顺序在文件文本上链式执行。 */
const FILES = [
  {
    target: "PageThumbnails.vue",
    patches: [
      {
        name: "去掉「异步返回后核对画布身份」",
        from: `    // 等待期间文档可能已切换、画布节点也可能已被新文档的节点替换。此时这次渲染
    // 的产物无处可去：画布已从 DOM 移除。若照旧写入 renderedKeys，真正的新画布
    // 之后会因缓存命中而跳过渲染，永久空白。这里核对会话与画布身份，不符则放弃，
    // 并把工作交还给出新画布触发的观察回调。
    if (currentSession !== session.value || canvasRefs.get(pageIndex) !== canvas) {
      return;
    }`,
        to: `    if (currentSession !== session.value) {
      return;
    }`,
      },
      {
        name: "恢复「失败即缓存 / 无条件回收任务」",
        from: `    // 「失败不再重试」也只对仍然有效的目标记录：画布已被换掉时记进去，会让新画布
    // 因缓存命中而跳过渲染，问题从「报错」变成「静默空白」。
    if (!(error instanceof RenderingCancelledException) && canvasRefs.get(pageIndex) === canvas) {
      renderedKeys.add(key);
    }
  } finally {
    // 只回收自己登记的任务：切换文档时可能已有新任务顶替了同一个页码。
    if (task !== null && renderTasks.get(pageIndex) === task) {
      renderTasks.delete(pageIndex);
    }
  }`,
        to: `    if (!(error instanceof RenderingCancelledException)) {
      renderedKeys.add(key);
    }
  } finally {
    renderTasks.delete(pageIndex);
  }`,
      },
      {
        name: "恢复局部 task 变量写法",
        from: `  cancelThumbnail(pageIndex);
  let task: RenderTask | null = null;
  try {`,
        to: `  cancelThumbnail(pageIndex);
  try {`,
      },
      {
        name: "恢复 task 为 const 局部量",
        from: `    task = page.render({`,
        to: `    const task = page.render({`,
      },
      {
        name: "恢复「切换文档时在 pre-flush 里主动遍历渲染」",
        from: `watch(documentId, () => {
  cancelAll();
  renderedKeys.clear();
});`,
        to: `watch(documentId, () => {
  cancelAll();
  renderedKeys.clear();
  for (const element of itemRefs.values()) {
    const pageIndex = Number(element.dataset.thumbIndex ?? "-1");
    if (pageIndex >= 0) {
      void renderThumbnail(pageIndex);
    }
  }
});`,
      },
    ],
  },
  {
    target: "SignaturePadDialog.vue",
    patches: [
      {
        name: "恢复「保存锁等到 cropToInk 之后才置位」",
        from: `  isSaving.value = true;
  try {
    const cropped = await cropToInk(canvas);
    if (!cropped) {
      formError.value = "没有检测到笔迹，请重新手写签名。";
      return;
    }

    const template = await saveTemplate({`,
        to: `  const cropped = await cropToInk(canvas);
  if (!cropped) {
    formError.value = "没有检测到笔迹，请重新手写签名。";
    return;
  }

  isSaving.value = true;
  try {
    const template = await saveTemplate({`,
      },
    ],
  },
];

const sha = (text) => createHash("sha256").update(text).digest("hex").slice(0, 12);

for (const group of FILES) {
  group.file = `${ROOT}/${group.target}`;
  group.backup = `${BACKUP}/${group.target}`;
}

const mode = process.argv[2] ?? "status";

if (mode === "apply") {
  await mkdir(BACKUP, { recursive: true });
  for (const group of FILES) {
    const original = await readFile(group.file, "utf8");
    let next = original;
    for (const patch of group.patches) {
      if (!next.includes(patch.from)) {
        console.error(`✗ ${group.target}：找不到片段「${patch.name}」，已中止（尚未写盘）`);
        process.exit(2);
      }
      next = next.replace(patch.from, patch.to);
      console.log(`· 已回退 ${group.target} → ${patch.name}`);
    }
    await copyFile(group.file, group.backup);
    await writeFile(group.file, next);
  }
  console.log("已写入缺陷版，可以运行 p3-verify.mjs 对照。");
} else if (mode === "restore") {
  for (const group of FILES) {
    const fixed = await readFile(group.backup, "utf8");
    await writeFile(group.file, fixed);
    const restored = await readFile(group.file, "utf8");
    const ok = sha(restored) === sha(fixed);
    console.log(`${ok ? "✓" : "✗"} 已还原 ${group.target} sha256=${sha(restored)}`);
    if (!ok) {
      process.exit(3);
    }
  }
  console.log("修复版已按备份原样还原。");
} else {
  for (const group of FILES) {
    const current = await readFile(group.file, "utf8");
    const reverted = group.patches.filter((patch) => current.includes(patch.to)).length;
    const state = reverted === 0 ? "修复版" : reverted === group.patches.length ? "缺陷版" : "混合";
    console.log(`${group.target}: ${state}（已回退片段 ${reverted}/${group.patches.length}）`);
  }
}
