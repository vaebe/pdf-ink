# PDFInk 已实证缺陷清单（子代理验证轮）

- **日期**：2026-09-20
- **说明**：本清单只收录经独立子代理用真实浏览器 / Node 探针**实证可触发**的缺陷；每个候选在写入前都做了触发验证。被证伪的候选（撤销/重做回收资产 URL）不在此列。
- **验证基线**：`verify:geometry` 全绿、`vue-tsc` 零错误、全套浏览器验收 47/47。以下问题均不被现有验收覆盖。
- **复现环境**：dev server `http://localhost:5199/`，探针与夹具在 `/private/tmp/pdf-ink-fixtures/`。（2026-09-20 补记：该目录已迁入 `tests/acceptance/`，见 `tests/acceptance/README.md`；本文为当日记录，未随迁移改写。）

---

## I-1【Important】打开失败 / 确认取消时，旧文档视图被静默重置

- **位置**：`src/App.vue:100-101`（`handleOpenFile` 在 `await openFile(...)` 之前无条件执行 `currentPage.value = 0; fitWidth.value = true;`）
- **触发条件**：
  1. 当前文档停在中后页并处于固定缩放；
  2. 打开一个会失败的文件（`broken.pdf`），或在「签名会失效」确认框点「取消」。
- **实测证据**（1600×950，`book-100p.pdf` 第 30 页 / 125% / scrollTop≈29178）：

  | 操作                   | page-input | zoom-level       | scrollTop | file-name          |
  | ---------------------- | ---------- | ---------------- | --------- | ------------------ |
  | 打开 broken.pdf 报错后 | 1          | 188%（适合宽度） | 4         | 仍为 book-100p.pdf |
  | 签名确认框点取消后     | 1          | 188%             | 4         | 仍为 book-100p.pdf |

  重置在确认框出现的瞬间就已发生；取消路径**无任何错误提示**，用户无感知为何视图丢失。

- **影响**：文档未切换但视图跳回第 1 页、缩放模式被改；不丢数据，但位置/缩放状态静默丢失。
- **建议修法**：把两行重置移到会话成功切换之后（`performOpen` 成功路径，或监听 `documentId` 变化时执行）；成功打开新文档时保持现有「从第 1 页开始」的预期行为不变。

## I-2【Important】读取页几何失败时泄漏整个 PDF.js worker

- **位置**：`src/composables/usePdfDocument.ts:134`（`readPageGeometries` 抛错时异常直达 `openFile` 的 catch，只设置 `loadError`；新建的 `loadingTask` 不经过任何一处 `destroy()`）
- **触发条件**：打开一个 PDF.js 能加载、但某一页 `getPage` 会抛错的损坏 PDF。已证实有效的构造：**页树 `/Kids` 元素指向非字典对象**（PDFNumber / PDFNull）。`/Count` 大于 Kids 数、缺 `/Contents`、缺 `/MediaBox` 等变异会被 PDF.js 容错，不触发。
- **实测证据**（`page.workers()` 计数序列）：

  ```
  baseline=0  fail#1=1  success#1=2  fail#2=3  success#2=3  fail#3=4  success#3=4
  ```

  每次失败打开 +1 个 worker 且**后续成功打开不会回收**（泄漏的 task 从未进入 session，只增不减）。

- **影响**：真实用户打开邮件/传输中损坏的 PDF 即可反复触发；worker 是重量级资源，长会话下只累加不释放。
- **建议修法**：`readPageGeometries` 外层包 try/finally，失败时 `await loadingTask.destroy()`；或在 `openFile` 的 catch 中、若 `session.value` 未被本轮替换则补一次销毁。

## I-3【Important】签名确认对话框孤立残留，按钮变成静默 no-op

- **位置**：`src/composables/usePdfDocument.ts` performOpen 的 confirm 等待（ isLoading 提前置 false，确认期间「打开 PDF」按钮可点）+ `src/composables/useConfirmDialog.ts` 单例（没有新确认请求时，挂起的对话框无人结算）
- **触发条件**：打开已签名 PDF 弹出「该 PDF 已包含数字签名」确认框后，**不关对话框**，直接通过工具栏再打开另一个文件。
- **实测证据**：第二个文件正常加载（file-name、缩放、签名库均到位），但确认框仍浮在新会话之上；点击「仍然编辑」或「取消」均无任何效果（`requestId` 已过期直接 return），遮罩同时锁死整页交互。场景对照：先开普通文件再开签名文件的两段式确认、以及确认框挂起时再开另一个签名文件（A 被静默结算、平稳切换）均正常。
- **影响**：对话框指向已被放弃的文件却压在新文档上；用户会误以为点了「仍然编辑」却什么都没发生，属功能性误导 + 交互锁死。
- **建议修法**：`handleOpenFile` 开始新打开时主动作废挂起的确认（如 useConfirmDialog 暴露 `cancelPendingConfirm()` 并在此调用），或让对话框生命周期跟随 `latestRequest` 自动关闭。

## M-1【Minor】stepZoom 在极端缩放下方向反转

- **位置**：`src/App.vue:114-125`（`ZOOM_STEPS` 找不到更大/更小档时回退到固定边界 4 / 0.4）
- **触发条件与实测**：

  | 视口      | 适合宽度算出 | 操作       | 结果                                |
  | --------- | ------------ | ---------- | ----------------------------------- |
  | 3600×1000 | 514%         | 点「放大」 | **400%（反而缩小）**，再点卡在 400% |
  | 480×900   | 5%           | 点「缩小」 | **40%（反而放大）**                 |

  常规尺寸（1280 / 2560 宽）行为正常；触发阈值约为视口宽 ≳2900px（如 4K 全屏）或 ≲700px。点「适合宽度」可自行恢复。

- **建议修法**：找不到下一档时保持当前缩放不动（空操作），或按当前值等比动态生成下一档。

---

## 不在本清单的项

- **撤销/重做与资产 URL 生命周期**：经实证**证伪**——`releaseUnusedAssets` 引用计数正确，删除→撤销→恢复图片完好，连放 5 个删 5 个再连撤 5 次无一裂开。
- **静态观察（非缺陷，供参考）**：`PdfViewer.vue:151-154` 的 `watch(documentId, …)` 是死代码（组件被 `:key="documentId"` 重挂载，永不触发）；`useSignatureEditor()` 被每页 overlay 各调用一次，100 页文档每次切换会话会跑 102 次 `resetEditorState`。
