# PDFInk 实现报告

本文记录 PDFInk 的实现交付、实际执行的命令与结果、未验证项和已知问题。
对应方案为 `docs/implementation-plan.md`，产品背景为 `docs/product-plan.md`。

**本文是执行记录，不替代最终验收。** 静态检查通过、构建通过和 Node 数值验证通过都不等于浏览器端功能验收通过，
第 6 节列出了尚未执行的验收项。

## 1. 基准与授权

| 项目               | 值                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------ |
| 工作分支           | `develop`（由 `main` 的 `c8e02baab7a767fe9b319052cf8fb6093a70179c` 创建）                  |
| 基准提交           | `c8e02ba` — `chore: 初始化项目`                                                            |
| 本次是否提交／推送 | 否（按要求未提交、未合并、未推送）                                                         |
| 依赖授权           | 用户指示「全部执行」该方案，据此确认新增 `pdfjs-dist`、`pdf-lib`、`signature_pad` 三个依赖 |
| 构建／检查授权     | 同上，按 S5 要求执行了 `vp check`（未加 `--fix`）与 `vp run build`                         |
| 运行验证授权       | 实现完成后用户指示「执行测试」，据此执行 A1—A12 浏览器交互验收（第 6 节）                  |
| 修复授权           | 用户同时指示「执行修复」，据此执行 `vp check --fix`（见第 4 节与第 7 节）                  |

### 已确认的首版边界

以下取方案第 2 节给出的首版建议，按「全部执行」的指示作为首版范围实现：

- PC 优先，手机／平板专门适配暂缓。
- 无账号；签名保存在当前站点的 IndexedDB；PDF 与编辑状态仅在会话中保存。
- 仅现场手写，不支持导入签名图片。
- 签名库备份、PWA、云端同步、加密 PDF 暂缓。
- 已有数字签名的 PDF 允许编辑，但打开前提示用户「继续编辑并导出会使原有数字签名失效」，
  由用户确认后才打开；含未填写的数字签名字段时同样允许打开并给出提示。
  （首版曾按「拒绝编辑」实现，后按用户要求改为「先提示、确认后允许」，见第 6.3 节。）
- 损坏文件归入加载失败路径，不新增修复功能。

## 2. 依赖与许可

使用 `vp add` 引入，未手改版本，版本已锁定在 `pnpm-lock.yaml`。

| 依赖            | 版本    | 许可       | 用途                                       |
| --------------- | ------- | ---------- | ------------------------------------------ |
| `pdfjs-dist`    | 6.3.289 | Apache-2.0 | PDF 解析、渲染、文字层、页面几何与坐标变换 |
| `pdf-lib`       | 1.17.1  | MIT        | 读取原始字节、嵌入 PNG 签名、写出新 PDF    |
| `signature_pad` | 5.1.4   | MIT        | 手写输入、空白判断与画布 PNG 输出          |

未引入其他框架、路由、状态管理库、后端或 UI 框架。

### worker 与本地资源

- worker：`pdfjs-dist/build/pdf.worker.min.mjs` 通过 `?url` 由构建工具产出为本地资源，
  版本与主库一致，`GlobalWorkerOptions.workerSrc` 指向该本地地址。
- CMap／标准字体／WASM／ICC：`scripts/sync-pdfjs-assets.mjs` 把 PDF.js 包内的
  `cmaps`、`standard_fonts`、`wasm`、`iccs` 复制到 `public/pdfjs/`（约 3.9 MB），
  加载时通过 `${import.meta.env.BASE_URL}pdfjs/...` 引用，构建产物中同时包含 `dist/pdfjs/`。
- 未从任何 CDN 加载资源：构建后的 `dist/assets/index-*.js` 中检索不到指向远端主机的资源地址。

## 3. 分阶段交付

### S0 范围与依赖

范围按上文确认；依赖、版本与许可见第 2 节；worker 与本地资源的落实方式见第 2 节。

### S1 最小预览与导出几何路径

- `src/types/pdf.ts`：`Matrix6`、`PageGeometry`、`SignaturePlacement`、`DocumentSession`、`DigitalSignatureInfo`。
- `src/lib/pdfCoordinates.ts`：矩阵构造／求值／平移／等比缩放、`matrixToDrawParams` 分解、
  `isDecomposableMatrix` 校验、`matrixToDomPlacement` 预览还原、页面范围约束。
- `src/lib/pdfExport.ts`：`inspectDigitalSignatures`（读取 AcroForm 中 Sig 字段及 `/V`）与
  `exportSignedPdf`（始终从原始字节重新生成，同一 assetId 复用同一份嵌入图片）。
- `src/composables/usePdfDocument.ts`：两阶段 pending 加载、按页读取几何信息、错误映射。
- `src/components/PdfPage.vue`：画布渲染、文字层、链接层、编辑层对齐。
- 未创建「临时开发签名图片」入口：S1 的几何贯通改由 `scripts/verify-pdf-geometry.mjs`
  在 Node 中用真实库完成（见第 4 节），因此正式代码中不存在需要事后删除的临时入口。

### S2 手写签名与本地签名库

- `src/types/signature.ts`：`SignatureTemplate`、`SignatureAsset`。
- `src/lib/signatureStore.ts`：IndexedDB `pdf-ink/signatures`，以事务完成作为保存成功条件。
- `src/components/SignaturePadDialog.vue`：画布按 `devicePixelRatio` 放大并同步缩放上下文，
  扫描 alpha 通道裁剪到笔迹边界（留 12px 边距）后输出透明 PNG；空画布拒绝保存；
  保存失败时保留手写内容与窗口并提示错误。
- `src/components/SignatureLibrary.vue`：模板列表、预览、选择、重命名、删除、重新加载。
- `src/composables/useSignatureLibrary.ts`：列表加载、保存／重命名／删除与错误状态，
  只在写事务完成后才更新列表。

### S3 页面放置与编辑

- `src/composables/useSignatureEditor.ts`：模块级单一状态入口。
  `placements` 只在模块内以整体替换的方式更新，组件不直接修改共享数组。
- 放置：选择模板后进入放置模式，点击页面按点击点居中放置；模板保持选中以便连续放置；`Esc` 退出。
  点击已有实例只选中，不额外添加。
- 变换：拖动只平移矩阵；四角手柄以对角为锚点等比缩放；位移与缩放在 viewport 上计算，
  因此页面旋转、缩放与 CropBox 原点均被正确处理。
- 历史：手势开始记录快照，手势结束且矩阵确实变化时才写入一条撤销记录；新编辑清空重做栈。
- 快捷键：`Delete`/`Backspace` 与撤销／重做在输入框或可编辑元素获得焦点时不生效。
- 删除模板不影响会话图片、已放置实例与撤销记录：实例只引用 `assetId`，
  图片 URL 在不再被实例或撤销／重做快照引用时才回收。

### S4 阅读体验与正式下载

- `src/components/PdfToolbar.vue`：打开、文件名、页码、缩放、自适应宽度、撤销／重做、下载。
- `src/components/PdfViewer.vue`：多页连续阅读、滚动检测当前页、页码跳转、自适应宽度基准。
- `src/components/PageThumbnails.vue`：缩略图按需渲染，离开视野取消渲染任务。
- `PdfPage.vue`：以 IntersectionObserver 只渲染可见页及相邻预取范围（`rootMargin: 900px`），
  离开视野时取消渲染任务；同一画布的新渲染前先取消旧任务。
- 导出：导出开始时取编辑快照；同一图片只嵌入一次；从原始字节重新导出，
  连续下载不会叠加；导出中禁用重复触发，失败后可重试并提示原因；
  输出文件名为原名加 `-signed.pdf`；替换有未导出编辑的文档前先确认。
- 文字选择与链接：编辑层默认 `pointer-events: none`，只有放置模式才接管整页点击；
  链接层只覆盖注解矩形，不使用整页截图。

### S5 交接

- `README.md`：产品说明、启动方式、支持范围、本地存储与隐私说明、实现结构、坐标契约要点。
- 移除模板遗留引用：`src/components/HelloWorld.vue`、`src/assets/{hero.png,vite.svg,vue.svg}`、
  `public/icons.svg`（`public/favicon.svg` 仍被 `index.html` 引用，保留）。
- `index.html`：标题与语言改为 `PDFInk · PDF 手写签名工具` / `lang="zh-CN"`。
- 本文。

## 4. 实际执行的命令与结果

| 命令                                                                                          | 结果                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vp add pdfjs-dist pdf-lib signature_pad`                                                     | 退出码 0，安装 `pdfjs-dist@6.3.289`、`pdf-lib@1.17.1`、`signature_pad@5.1.4`                                                                                                                                                                      |
| `node scripts/sync-pdfjs-assets.mjs`                                                          | 退出码 0，同步 4 个资源目录，`public/pdfjs` 约 3.9 MB                                                                                                                                                                                             |
| `vp run build`（`vue-tsc -b && vp build`）                                                    | 退出码 0。`vue-tsc -b` 无错误；产物 `dist/index.html` 0.63 kB、`dist/assets/index-*.css` 10.37 kB、`dist/assets/index-*.js` 974.80 kB（gzip 349.11 kB）、`dist/assets/pdf.worker.min-*.mjs` 1265.41 kB；含 `dist/pdfjs/`。仅有一条 chunk 体积提示 |
| `vp check src/App.vue src/style.css src/types src/lib src/composables src/components scripts` | 退出码非 0：**只报告 12 个文件的格式差异，无类型／lint 错误**。按方案第 5 节当时未执行批量 `--fix`，见第 7 节                                                                                                                                     |
| `git diff --check`                                                                            | 退出码 0，无空白错误。新增未跟踪文件不在该命令范围内                                                                                                                                                                                              |
| `node scripts/verify-pdf-geometry.mjs`                                                        | 退出码 0，**86 项检查全部通过、0 项失败**，详见下文                                                                                                                                                                                               |
| `vp dev --host 127.0.0.1 --port 5199` + `curl`                                                | 首页 200；`/pdfjs/cmaps/Adobe-GB1-UCS2.bcmap` 200，本地资源可访问。验证后已停止服务                                                                                                                                                               |
| `vp check`（全仓，修复前）                                                                    | 报告 21 个文件存在格式差异，其中含 `public/pdfjs/wasm/*.js`（PDF.js 随包资源）与既有文档；据此改为按改动范围修复                                                                                                                                  |
| `vp check --fix src scripts README.md index.html package.json docs/implementation-report.md`  | 退出码 0，格式化 20 个文件；同时暴露 1 条 lint 警告 `unicorn(no-useless-spread)`                                                                                                                                                                  |
| `vp check`（修复后，同一范围）                                                                | 退出码 0：**25 个文件格式正确；20 个文件 0 warning、0 lint error、0 type error**                                                                                                                                                                  |
| `vp test`                                                                                     | 退出码 1，`No test files found`——项目当前没有测试文件，属已知状态（第 7 节第 2 条）                                                                                                                                                               |
| `vp run build`（修复后回归）                                                                  | 退出码 0，`vue-tsc -b` 无错误，产物正常                                                                                                                                                                                                           |
| `node scripts/verify-pdf-geometry.mjs`（修复后回归）                                          | 退出码 0，86 项仍全部通过                                                                                                                                                                                                                         |
| 浏览器验收脚本（Playwright + Chromium）                                                       | 首轮 **34/34 项通过**，连续多次运行结果一致，详见第 6 节                                                                                                                                                                                          |
| 确认弹窗改造后回归                                                                            | `vp check` 26 文件格式正确、22 文件 0 error/warning/type error；86 项数值契约通过；`vp run build` 通过；浏览器验收 **37/37 项通过**（见 6.4 节）                                                                                                  |
| 证伪检查（临时副本注入「导出原地改写字节」）                                                  | 断言如预期报 `FAIL 导出未改写原始字节`，证明修正后的断言确实能发现问题；临时副本已删除                                                                                                                                                            |

### 格式化与 lint 修复的实际内容

`vp check --fix` 对 11 个源文件共改动约 113 行，**全部为换行与换行位置调整**（参数拆行、属性折行），
逐文件 `diff` 已核对，未改变任何标识符、表达式或控制流。

唯一的语义改动是按项目自身 lint 规则修掉的一处警告：

- `src/components/PageThumbnails.vue` 的 `cancelAll()` 原为
  `for (const pageIndex of [...renderTasks.keys()])`；`cancelThumbnail` 只删除当前已访问的键，
  直接迭代 Map 与快照迭代等价，故改为 `for (const pageIndex of renderTasks.keys())`。

修复后重新执行了数值契约验证、构建与整轮浏览器验收，结论与修复前一致。

### 坐标与导出契约的数值验证

`scripts/verify-pdf-geometry.mjs` 在 Node 中调用真实的 `pdfjs-dist`（legacy 构建）与 `pdf-lib`，
样本为脚本自行生成的 4 页 PDF：`595×842 / rotation 0`、`595×842 / rotation 90`、
`420×595 / rotation 180`、`500×500 / rotation 270 且 CropBox 原点为 [50, 60, 450, 460]`；
每页在 `scale = 1 / 1.7 / 2.35` 三种缩放下各检查一次。

已通过的关键结论：

- **数字签名识别**：普通文档判定为「无签名字段、未签名」且不抛错；
  含未填写的 `Sig` 字段时 `hasSignatureField = true / isSigned = false`（打开并提示）；
  字段已填写签名值 `/V` 时 `isSigned = true`（打开前提示失效风险，用户确认后允许编辑）。
  三种情形均已实测。识别结果只决定「提示哪一条」，不再决定「是否打开」。
- **预览与 PDF 矩阵一致**：把 DOM 变换反推回 PDF 用户空间后，图片左上／右上／左下／右下四个角点
  与实例矩阵的最大偏差 ≤ `6.4e-14` PDF 用户单位（要求 ≤ 1）。
- **点击中心一致**：按点击位置居中放置后，实例中心回投到页面的坐标偏差 ≤ `1.7e-13` CSS px。
- **拖动换算一致**：把屏幕位移换算为 PDF 位移后，实例中心到达的位置与直接拖动的屏幕位置一致，
  偏差 ≤ `1.7e-13` CSS px。
- **缩放不变式**：以角点等比缩放后锚点漂移 ≤ `2.9e-14`，长宽比保持不变。
- **导出读回一致**：调用真实的 `exportSignedPdf` 写入 PDF，再用 `pdf.js` 的
  `getOperatorList()` 还原每个图片绘制点处的变换矩阵，与实例矩阵的最大角点偏差 ≤ `5.7e-14`
  PDF 用户单位；每页恰好一个图片绘制操作。
- **导出可重复**：同一原始字节连续导出两次结果字节完全相同（2088 bytes）；
  原始字节未被改写；输出页数不变。
- 参考性能：4 页 / 4 个实例的完整导出约 5–8 ms（不含图片解码与下载）。

该脚本在第一次运行时发现了实现中的一个真实缺陷：`isDecomposableMatrix` 最初额外要求矩阵两列
等长，导致非正方形签名（宽高不等）会被误判为「不可分解」，导出直接抛出异常。已修正为只校验
「两列正交」与「行列式为正」（这正是 pdf-lib `translate → rotate → scale` 结果矩阵的等价条件），
修正后同一批样本全部通过。这属于契约层缺陷，若非该脚本会一直留在代码里。

该脚本覆盖方案中风险最高的坐标与导出契约，**不覆盖**浏览器 UI、IndexedDB、手写输入与
文件下载等浏览器行为。

**该脚本自身的一处缺陷（已修正）**：「导出未改写原始字节」最初比较的是
`originalBytes` 与**重新调用 `createSamplePdf()` 生成的另一份样本**。pdf-lib 在
`PDFDocument.create()` 时会把创建时间写入文档，因此两次生成只有在同一秒内才会字节相同——
该断言实际上偶发失败（实测跨秒生成确实产生不同字节，长度相同、内容不同），
测的是「样本生成是否可复现」而不是「导出是否改写了输入」。
现已改为：导出前对同一份 `originalBytes` 做快照，导出后与原对象逐字节比对。
为确认新断言不是恒真，用临时副本注入了一次「导出前原地改写一个字节」，
断言如预期报 `FAIL`，随后删除该副本。跨秒连续运行 4 次，86 项稳定全过。

## 5. 改动文件

由于尚未提交，以下以 `git status` 分类给出。

**修改（8）**：`README.md`、`index.html`、`package.json`、`pnpm-lock.yaml`、`.gitignore`、
`vite.config.ts`、`src/App.vue`、`src/style.css`。
其中 `App.vue`、`style.css` 与 8 个组件在 6.4 节的弹窗改造、6.5 节的 Tailwind 改造中再次修改
（组件模板的类名全部重写，`style.css` 由 867 行降为 204 行）；6.6 节的缺陷修复又改动了
`src/style.css`、`src/styles/pdfjs-text-layer.css`、`src/components/SignaturePadDialog.vue`、
`src/composables/usePdfDocument.ts`、`src/composables/useSignatureLibrary.ts`、
`src/composables/useSignatureEditor.ts`、`src/lib/pdfCoordinates.ts`；
6.7 节的 P2 修复改动 `README.md`（末尾空行）、`src/components/PdfViewer.vue`、
`src/components/PdfPage.vue`、`src/composables/useSignatureEditor.ts`；
6.8 节的 P2 修复改动 `src/components/PageThumbnails.vue`、`src/components/SignaturePadDialog.vue`
（两者都是方案内的既有新增文件，本轮只修改其内部逻辑）。
未新增源文件——6.7 节新增的 `heavy-text-40p.pdf` 与其生成脚本属于项目外的验收夹具，
与验收脚本放在同一目录，不进仓库（见 `docs/acceptance/README.md`）。

**新增（方案第 3.2 节文件 + 支撑文件）**：

- `src/types/pdf.ts`、`src/types/signature.ts`
- `src/lib/pdfCoordinates.ts`、`src/lib/pdfExport.ts`、`src/lib/signatureStore.ts`
- `src/composables/usePdfDocument.ts`、`src/composables/useSignatureLibrary.ts`、
  `src/composables/useSignatureEditor.ts`
- `src/components/PdfToolbar.vue`、`PdfViewer.vue`、`PdfPage.vue`、`PageThumbnails.vue`、
  `SignatureLibrary.vue`、`SignaturePadDialog.vue`、`SignatureOverlay.vue`
- （6.4 节新增）`src/components/ConfirmDialog.vue`、`src/composables/useConfirmDialog.ts`
- （6.5 节新增）`src/styles/pdfjs-text-layer.css`（PDF.js 文本层的接口契约样式）
- `scripts/sync-pdfjs-assets.mjs`、`scripts/verify-pdf-geometry.mjs`
- `docs/implementation-report.md`（本文）、`docs/acceptance/**`（验收证据与索引）

**新增依赖（均为 `devDependencies`）**：`tailwindcss@4.3.3`、`@tailwindcss/vite@4.3.3`（见 6.5 节）。

**不进版本控制的生成物**：`public/pdfjs/**`（PDF.js 运行期静态资源镜像，约 3.9 MB / 200 个文件）
与 `.workbuddy/**`（本地工作区状态）已写入 `.gitignore`。前者由
`scripts/sync-pdfjs-assets.mjs` 从 `node_modules/pdfjs-dist` 复制而来，属于依赖的镜像副本，
提交它会造成版本漂移与仓库膨胀。为保证忽略后仍能一键跑通，安装、启动与构建都会自动重建它：

| 触发点           | 机制                                                         |
| ---------------- | ------------------------------------------------------------ |
| 全新克隆后安装   | `postinstall` → `scripts/sync-pdfjs-assets.mjs`              |
| `pnpm dev`       | `dev` 前置同步                                               |
| `pnpm run build` | `build` 前置同步                                             |
| 手动             | `pnpm sync:pdfjs`（脚本先删后建，可重复执行，耗时约 0.24 s） |

已验证重建结果与原目录**逐字节一致**（200 个文件校验和全等），因此忽略该目录不影响构建与运行。

**删除（5）**：`src/components/HelloWorld.vue`、`src/assets/hero.png`、`src/assets/vite.svg`、
`src/assets/vue.svg`、`public/icons.svg`。

### 与方案的偏差说明

1. 方案第 3.2 节未列出 `scripts/` 目录。为了让本地资源可重现、让坐标契约可被数值验证，
   新增了两个脚本（同步资源、契约验证）。它们不参与应用运行时。
2. 方案 S1 要求「使用临时开发签名图片贯通坐标→显示→写入→输出字节，交付正式功能前删除临时入口」。
   本次改由第 4 节的 Node 验证脚本贯通该路径，正式代码中从未加入临时签名入口，因此无需删除动作。
3. `src/components/PdfPage.vue` 的链接层自行渲染链接注解矩形，未使用 PDF.js 的
   `AnnotationLayer`（该 API 需要 `PDFLinkService` 等查看器级依赖）。只处理 `Link` 注解的
   外链与站内跳转，其他注解类型不渲染。
4. 方案第 3.2 节未列出验收证据目录。为了给第 6 节的结论留下可复核的证据，
   新增 `docs/acceptance/`（截图、导出样本、逐项结果 JSON 与索引说明）。
   验收脚本本身依赖 Playwright 与 Python 侧的 pypdf／pypdfium2，不属于项目运行时，
   因此未提交到仓库，索引中记录了复现方式。

## 6. 验收结果（A1—A16）

授权后在真实浏览器中逐项执行。首轮 **34/34 项通过**（连续多次运行结果一致）；随后按用户要求把
「已含有效数字签名」的文档改为「先提示、确认后允许编辑」（见 6.3 节），第三轮又把确认交互从
原生 `window.confirm` 换成应用内 dialog（见 6.4 节），第四轮按用户要求改用 Tailwind CSS 组织样式
（见 6.5 节），第五轮修复代码审查发现的 3 处缺陷并为每处补一条断言（见 6.6 节），
第六轮修复第二轮审查的 3 项 P2 并新增 A13 段（见 6.7 节，该轮 **47/47 项通过**），
第七轮修复第三轮审查的 2 项 P2 并新增 A14 段（见 6.8 节，该轮 **54/54 项通过**），
第八轮补齐第四轮审查指出的 2 项「新行为缺断言」并新增 A15 / A16 段（见 6.9 节），
每次都重跑整套验收，**最新一轮 59/59 项通过，且连续两轮逐项结论一致**。
逐条明细（含每项实测数值）见 `docs/acceptance/acceptance-report.json`
（已更新为最新一轮），证据文件与复现方式见 `docs/acceptance/README.md`。

下表 A1—A12 的数值取自首轮完整验收（该轮 B2 还是「拒绝编辑」实现）。各轮的手写笔迹都是随机
生成的，因此个别尺寸与矩阵数值与下表略有差异，结论与断言完全一致。

环境：macOS / Apple Silicon / Chromium 151.0.7922.34；主视口 1600×950（DPR 1），
DPR 2 复验使用 1280×820；对照工具为 pypdf 6.19.0 与 PDFium（pypdfium2），二者与
应用使用的 PDF.js／pdf-lib 是相互独立的实现。

| 编号 | 结论 | 实测证据（摘要）                                                                                                                                                                                                                                                                       |
| ---- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | 通过 | 两份手写签名分别裁剪为 295×170 / 188×98，不透明像素 2493 / 727；刷新页面后名称与裁剪尺寸完全一致；IndexedDB 中 2 条记录，blob 4696 B / 1246 B                                                                                                                                          |
| A2   | 通过 | 空白画布保存被拒（提示「画布还是空白的，请先手写签名。」，窗口保持打开，库内仍 2 项）；拦截 `IDBObjectStore.put` 抛错后提示「模拟写入失败」、笔迹保留、库内仍 2 项、未出现成功横幅；恢复写入后同一笔迹保存成功并自动关闭弹窗                                                           |
| A3   | 通过 | 第 1 页 2 个实例 + 第 2 页 1 个实例；拖动首位实例 90×−60 px 后偏差 0.000 px，另一实例坐标未变；角点手柄缩放 344.4 → 268.7 px 且长宽比保持 1.7353；可单独删除任一实例                                                                                                                   |
| A4   | 通过 | 删除模板先弹确认框「删除签名「验收乙」？」，确认后页面上 2 个实例仍在，导出文件中仍有 2 个图片对象；第 2 页实例数 撤销前 0 → 撤销后 1 → 重做后 0，历史记录完整                                                                                                                         |
| A5   | 通过 | 5 页（rotation 0/90/180/270、非零 CropBox [50,60,450,460]、混合尺寸）各写入恰好 1 个图片对象；全部变换行列式为正（20036.8 / 23776.2 / 8559.4 / 8559.4 / 23776.2），无镜像无斜切；每页图片四角均落在该页 CropBox 内；**PDFium 渲染结果与应用预览逐页一致**（见 `docs/acceptance/A5-*`） |
| A6   | 通过 | devicePixelRatio = 2 下，适合宽度 135% / 缩小 50% / 放大 400% 三档拖动偏差均为 0.00 px；显示长宽比 1.7421 / 1.7423 / 1.7421 对原始笔迹 1.7420；拖动全程滚动位移为 0，实例完整位于视口内                                                                                                |
| A7   | 通过 | 一次拖动（Δx = 80 px）后按一次撤销即回到原位（偏差 0.000 px），重做回到拖动后位置（偏差 0.000 px）；撤销后新建实例，「重做」按钮随即变为不可用，旧重做分支被清空                                                                                                                       |
| A8   | 通过 | 连续两次下载各含 3 个图片对象，两份文件字节完全一致（4862 B）；源文件 sha256 在前后不变                                                                                                                                                                                                |
| A9   | 通过 | 导出后仍可提取 183 个字符，含 `ALPHA-BRAVO-CHARLIE` 与 `searchable needle 0123456789`；外链注解 `https://example.com/pdfink-a9` 与矩形完整保留；签名图片面积仅占页面 4.1%，不是整页截图                                                                                                |
| A10  | 通过 | 连续切换 3 个文档并在加载期间连续缩放，最终稳定显示 `rotations.pdf` / 5 页；无未捕获异常，控制台错误 0 条                                                                                                                                                                              |
| A11  | 通过 | 100 页样本首屏渲染 262 ms、跳转至第 100 页 19 ms；任何时刻持有像素缓冲的画布只有 2 个（远小于 100，由 900px 预渲染余量带界定）；可在第 100 页放置签名并导出（该页 1 个图片对象）                                                                                                       |
| A12  | 通过 | 全部请求来自 `http://localhost:5199` 与 `blob:`，外部来源 0 个、PDF 上传请求 0 个；worker 请求 10 个全部为本地地址；CDN 类请求 0 个；独立探针确认 `/pdfjs/cmaps/Adobe-Japan1-0.bcmap` 由本地返回 200 / 225 B                                                                           |

### 6.1 范围门槛项的附加验收

| 编号 | 结论 | 实测证据（摘要）                                                                                                                                                                                                                                                                  |
| ---- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1   | 通过 | 含未填写 `Sig` 字段的文档可正常打开，并提示「该 PDF 包含尚未填写的数字签名字段，导出的文件不会改动这些字段。」                                                                                                                                                                    |
| B2   | 通过 | 已含签名值的文档先弹出确认框：标题「该 PDF 已包含数字签名」、正文含「失效」、按钮为「取消／仍然编辑」、**默认焦点落在「取消」**、弹窗期间工具栏显示「打开 PDF」而非「正在打开…」；**Esc 与点击「取消」两条路径**都不打开文档、会话停留在 `plain.pdf`（页数仍为 2）、错误横幅 0 条 |
| B2b  | 通过 | 同一文档在**点击「仍然编辑」后**正常打开（文件名 `sig-field-signed.pdf`），补充说明列出「原始文件不会被修改……」「导出结果会另存为新的 PDF」，并保留提示条「该 PDF 已包含有效的数字签名：继续编辑并导出会使原有数字签名失效……」                                                    |
| B3   | 通过 | 损坏文件提示「该文件不是有效的 PDF，或文件已损坏，无法打开。」，且既有会话（`sig-field-signed.pdf`）未被破坏                                                                                                                                                                      |
| B4   | 通过 | 损坏文件之后重新打开正常 PDF 成功                                                                                                                                                                                                                                                 |
| B5   | 通过 | 已放置 1 个实例时换文件，弹框「放弃当前编辑？」并列出「当前页面上有 1 个签名尚未导出。」；**取消**后会话仍为 `plain.pdf` 且实例仍在（1 个）；再次触发并**确认**后才切换到 `text-links.pdf`，实例数归 0                                                                            |
| B6   | 通过 | 全程未出现原生 `alert`/`confirm`（`page.on("dialog")` 记录到 0 次），所有确认交互都由页面内 dialog 完成                                                                                                                                                                           |

### 6.2 仍未覆盖的部分

- A11 的性能数字来自单台设备（macOS / Apple Silicon）单次运行，方案要求「先记录实测数据，不凭空承诺跨设备固定时间」，未做跨设备对照。
- A12 的网络审计覆盖了本次全流程；未构造「上传类」恶意实现做反向验证（该类实现并不存在，故无从触发）。
- 加密 PDF：本次未构造加密样本，`PasswordException` 分支仅有代码路径，无实测证据。
- 键盘快捷键、触屏/触控笔输入、超长文档下切换会话的开销未纳入本次实测。

### 6.3 验收后的行为变更：数字签名文档改为「先提示、确认后允许编辑」

**变更原因**：用户明确要求「该 PDF 已包含有效的数字签名」这一类文档允许编辑，但必须先提示用户。
方案第 2 节原本就把这一项列为「处理边界仍需明确决定」，首版实现按「拒绝编辑」处理，本次按用户
指示确定为「允许编辑 + 打开前确认」。

**行为对比**：

| 维度           | 变更前                           | 变更后                                                       |
| -------------- | -------------------------------- | ------------------------------------------------------------ |
| 已含有效签名   | 直接拒绝，红色错误横幅，不打开   | 弹出确认框；确认则打开，取消则保持当前文档不变               |
| 提示文案       | 「当前版本不予编辑。」（错误态） | 「继续编辑并导出会使原有数字签名失效。原始文件不会被修改……」 |
| 编辑过程中     | —（无法进入）                    | 常驻琥珀色提示条，可手动关闭                                 |
| 未填写签名字段 | 允许打开 + 提示                  | 不变                                                         |

**改动文件**：`src/composables/usePdfDocument.ts`（`openFile` 增加 `OpenFileOptions.confirmSignedDocument`
钩子，签名识别只决定「提示哪一条」，不再决定「是否打开」）、`src/App.vue`（确认弹窗与文案，
该弹窗随后在 6.4 节由原生 `window.confirm` 换成应用内 dialog）、`README.md`（支持范围表与说明）。

**复验**：改动后重跑整套浏览器验收，**35/35 项通过**（B2 拆分为「取消」与「确认」两条），
A1—A12 结论未变。逐项结果与最新数值见 `docs/acceptance/acceptance-report.json`。

### 6.4 验收后的行为变更：确认交互改为应用内 dialog

**变更原因**：用户指出原先用 `window.confirm` 呈现的弹窗「太原始」，要求改为正常的对话框。
改造后 `src/` 内原生弹窗数量为 0（原为 3 处）。

| 场景                       | 变更前           | 变更后                                                   |
| -------------------------- | ---------------- | -------------------------------------------------------- |
| 打开已含有效数字签名的 PDF | `window.confirm` | dialog「该 PDF 已包含数字签名」，按钮「取消 / 仍然编辑」 |
| 有未导出编辑时换文件       | `window.confirm` | dialog「放弃当前编辑？」，按钮「取消 / 放弃并打开」      |
| 删除签名模板               | `window.confirm` | dialog「删除签名「验收乙」？」，按钮「取消 / 删除」      |

**实现**：

- 新增 `src/components/ConfirmDialog.vue`：`role="dialog"` + `aria-modal` +
  `aria-labelledby`/`aria-describedby`；Esc 与点击遮罩取消；Tab 焦点陷阱；
  打开时记录焦点、关闭时归还（跳过 `visually-hidden` 的文件输入框，避免回车误触发文件选择）；
  默认焦点落在「取消」（三处确认都有不可逆后果，避免顺手回车直接确认）；
  支持 `warning` / `primary` 两种语气（图标与确认按钮样式随语气变化）与 `prefers-reduced-motion`。
- 新增 `src/composables/useConfirmDialog.ts`：模块级单例，`requestConfirm(options)` 返回
  `Promise<boolean>`，调用处直接 `await`；同一时刻只保留一个弹窗，新请求把旧请求按「取消」结算，
  避免 Promise 悬挂。状态在模块级，因此 `App.vue` 与 `SignatureLibrary.vue` 共用同一个弹窗实例，
  后者不必自己渲染组件。
- **等待用户确认期间不再显示加载态**：签名识别发生在真正的加载之前，而 `isLoading` 原先在
  `openFile` 入口就置为 `true`，导致确认框弹出时工具栏仍停在「正在打开…」。现改为在
  `await confirmSignedDocument(...)` 之前把 `isLoading` 置回 `false`、确认通过后再置 `true`。
- 弹窗打开期间文档级快捷键（撤销/重做/Delete/Esc）不再生效，避免穿透到编辑层。

**复验**：`vp check` 26 文件格式正确、22 文件 0 error / 0 warning / 0 type error；
`pnpm verify:geometry` 86 项通过；`vp run build` 通过（`vue-tsc -b` 无错误）；
浏览器验收 **37/37 项通过**。弹窗截图见 `docs/acceptance/B2-dialog-signed-pdf.png`（浅色）、
`B2-dialog-signed-pdf-dark.png`（深色）与 `B5-dialog-discard-edits.png`。

**验收脚本的同步调整（否则会产生假通过）**：脚本原先依赖 `page.on("dialog")` 自动接受原生弹窗，
改造后该钩子不再触发——若不同步修改，确认框会静默跳过而断言依旧「通过」。现在脚本显式驱动 DOM 弹窗，
并把「原生弹窗出现次数为 0」本身作为一条断言（B6），使这类回归变成可检出的失败。另有两处连带调整：
`openPdf` 与 A10 的快速换文件必须先处理「放弃当前编辑？」弹窗才能继续；
A11 的计时改从「确认之后」开始，避免把用户确认所花的时间算进首屏加载耗时。

### 6.5 验收后的样式变更：改用 Tailwind CSS 组织样式

**变更原因**：用户要求按
[Tailwind CSS 官方 Vite 接入文档](https://tailwindcss.com/docs/installation/using-vite)
用 Tailwind 组织样式。改造前 `src/style.css` 是 867 行手写 BEM 样式表，组件的类名只描述结构
（`.panel__header`、`.library-item__pick`），视觉规则分散在另一个文件里。

**接入方式**（`tailwindcss` + `@tailwindcss/vite` 4.3.3，Vite 插件形式）：

```ts
// vite.config.ts
import tailwindcss from "@tailwindcss/vite";
plugins: lazyPlugins(() => [vue(), tailwindcss()]),
```

```css
/* src/style.css */
@import "tailwindcss";
```

**令牌层**：原有 CSS 变量保留为唯一的深色模式开关，再由 `@theme inline` 映射成语义工具类。
用 `inline` 是关键——工具类会直接内联成 `var(--surface)` 而不是再包一层 `--color-surface`，
因此深色主题下所有工具类自动跟随系统，模板里**不需要写任何 `dark:` 变体**。

| 原生变量（`:root`，深色时覆盖） | Tailwind 工具类                         | 典型用法             |
| ------------------------------- | --------------------------------------- | -------------------- |
| `--surface` / `--surface-muted` | `bg-surface` / `bg-subtle`              | 面板、卡片、次级填充 |
| `--border` / `--border-strong`  | `border-line` / `border-line-strong`    | 描边                 |
| `--text` / `--text-muted`       | `text-ink` / `text-ink-muted`           | 正文与次要文字       |
| `--accent` / `--accent-soft`    | `accent` / `accent-soft`                | 主色与浅底           |
| `--scrim`、`--shadow`、`--sans` | `bg-scrim`、`shadow-panel`、`font-sans` | 遮罩、阴影、字体     |

字号另外补了 Tailwind 默认档位缺的一档：`--text-meta`（13px，原设计里承担大部分次要信息），
与 `--text-micro` / `--text-body` / `--text-lead` 构成 12/13/14/15px 四档。

**外观下沉到模板**，`src/style.css` 从 867 行降到 204 行，只保留三样东西：

1. 设计令牌（上表）；
2. 两个在 5 个组件里重复出现的原语 `@layer components { .button / .input }`，
   用 `@apply` 由工具类组合而成，放在 components 层因此模板上的工具类永远可以覆盖它们；
3. 手写区「稿纸」底纹 `@utility hatch`（自定义工具类，可参与变体组合）。

**明确保留为 CSS 的部分**：`src/styles/pdfjs-text-layer.css`。PDF.js 的 `TextLayer` 在运行时
注入 `<span>` 并依赖 `--scale-factor` / `--text-scale-factor` / `data-main-rotation` 等一组
接口契约，改写成工具类会直接破坏文字定位，因此这一层单独成文件并注明是第三方契约。
运行期数值（缩放后的宽高、仿射矩阵、指针坐标）继续走行内 `style`，这是数据不是样式。

**改造中发现并修掉的两个真实缺陷**：把内联工具类改成「静态 + 动态类名并存」之后，
高亮与放置模式全部失效。根因是**工具类优先级相同，胜负由样式表顺序决定，而不是类名书写顺序**——
`border-line` 在 CSS 中排在 `border-accent` 之后，于是激活态永远被基础态盖住；
`pointer-events-none` / `pointer-events-auto` 同理，导致编辑层始终不接管点击、签名根本放不下去。

```html
<!-- 反例：两个类都在，谁生效取决于样式表顺序 -->
<li class="border-line" :class="active ? 'border-accent' : ''">
  <!-- 正例：互相排斥的取值只输出一个 -->
</li>

<li :class="active ? 'border-accent bg-accent-soft' : 'border-line bg-subtle'"></li>
```

这类缺陷**不会被类型检查、lint 或构建发现**，构建与单元级断言都是绿的，
只有在真实浏览器里读计算样式才会暴露。三处（签名卡激活态、缩略图当前页、编辑层放置模式）已全部改为三元表达式。

**验收脚本的同步调整**：脚本原先按 BEM 类名定位元素，而工具类改造后这些类名不再存在。
本次把测试钩子统一换成 `data-testid`（共 30 类选择器、约 60 处）——这比绑定视觉类名更稳，
后续再调整样式不会波及验收。`data-testid` 只加在被脚本依赖的元素上：`toolbar`、`file-name`、
`page-input`、`zoom-level`、`signature-library`、`library-item(-pick/-name/-preview)`、
`signature-pad-dialog(-canvas)`、`pad-name-input`、`pad-error`、`confirm-dialog` 及其
`confirm-title/-message/-details/-actions`、`banner` + `data-tone`、`pdf-scroller`、
`placement(-handle/-frame/-delete)`。签名卡的激活态改用 `data-active` 而不是类名判断。

**复验**：

| 检查项                            | 结果                                               |
| --------------------------------- | -------------------------------------------------- |
| `vp check`                        | 23 文件格式正确 / 0 error、0 warning、0 type error |
| `vp run build`（含 `vue-tsc -b`） | 通过，CSS 产物约 20.8 kB（gzip 5.4 kB）            |
| `pnpm verify:geometry`            | 86 项通过                                          |
| 浏览器验收                        | **连续两轮 37/37 项通过**，报告逐项结论一致        |
| 迁移前后计算样式比对              | 55 项断言通过（见下），浅色与深色各复验一次        |

样式比对不是「看起来一样」，而是把迁移**前** `style.css` 里的声明值硬编码成预期值，
在真实浏览器里逐项读取 `getComputedStyle` 比对：工具栏内边距 10px 16px、按钮 7px 12px / 圆角 6px、
页码输入框宽 56px、缩放显示 `tabular-nums`、缩略图栏 172px、签名库 248px、页面容器 gap/padding 16px、
文本层 `overflow: clip` + `line-height: 1`、手写区 200px / 虚线 8px 圆角、弹窗 18px 内边距等。
其中三条初次「失败」经核查是断言本身写错而非实现问题，已在脚本注释中写明原因：
flex 子元素的 `inline-flex` 会被块化为 `flex`；`line-height: 1` 的计算值按当前字号折算成 `14px`；
Tailwind v4 的 `rounded-full` 是 `calc(infinity * 1px)`，在 34px 方框上按规范夹到 17px，
与原 `border-radius: 50%` 渲染一致。

**一处有意的视觉变更**：手写签名弹窗现在与确认弹窗一样带 0.18s 入场动画（原实现只有确认弹窗有动画）。
验收脚本因此在打开手写弹窗后等待动画结束再量画布包围盒，避免取到缩放中的尺寸。
动画同时受 `prefers-reduced-motion` 保护。

### 6.6 审查后的缺陷修复（3 处缺陷 + 3 处清理）

6.5 节的样式迁移完成后做了一次完整代码审查（报告见 `docs/code-review-2026-09-20.md`）。
审查结论是「需要修改后通过」：迁移目标达成，但发现 1 处由本次迁移**引入**的缺陷、
2 处**既有**缺陷首次被证实。三处已全部修复，并各补一条验收断言。

| 编号 | 缺陷                                                                           | 根因                                                                                                                                           | 修法                                                                                      |
| ---- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| I-1  | 手写弹窗画布后备分辨率按「动画中的缩放盒子」计算（`backing=514` 而应为 `524`） | 6.5 节给面板新增的 `panel-in` 动画含 `scale(0.98)`，而 `syncCanvasResolution()` 用 `getBoundingClientRect()`，会把祖先 transform 一并算进去    | 改用 `offsetWidth/offsetHeight`（布局尺寸，不受 transform 影响），并把原因写进函数注释    |
| I-2  | **PDF 内链接点不动**（页面上链接区域无响应）                                   | 移植文本层样式时丢了 pdfjs 参考实现的 `z-index: 0`，容器因此不是层叠上下文，内部 `z-index: 1` 的**透明**文字 span 压在链接层之上并吞掉指针事件 | `src/styles/pdfjs-text-layer.css` 补 `z-index: 0`（该文件本就是 PDF.js 契约层，放入正当） |
| I-3  | 工具栏「适合宽度」激活后，鼠标悬停反而掉回普通按钮配色                         | `.button--ghost:enabled:hover` 特异性 (0,3,0) 高于 `.button--toggled` (0,1,0)，**特异性高于顺序**                                              | 给 `.button--toggled` 补同层 `enabled:hover` 规则，(0,3,0) 且写在后面 → 胜出              |

I-2 与 I-3 在迁移前就存在（旧 BEM 样式同样缺这两条），只是从未被验证过；
I-1 是 6.5 节新增动画引入的。三处都**不会被类型检查、lint、构建或原有验收发现**——
I-2 与 I-3 甚至能在功能测试全绿的同时让链接完全点不动，只有在真实浏览器里读计算样式、
做命中测试才能抓到。

**验收脚本新增 4 条断言**（37 → 41 项）：

| 新断言 | 验证内容                                                                    |
| ------ | --------------------------------------------------------------------------- |
| A1-6   | 弹窗入场动画**进行中**取样的画布后备尺寸 = `offsetWidth × DPR`              |
| A6-3   | 切换态按钮静止与 hover 配色一致；同时对照普通 ghost 按钮 hover 仍会变色     |
| A9-4   | 链接矩形内 5 个采样点 `elementFromPoint` 全部命中 `<a>`，且不在文本层内     |
| A9-5   | 真实点击链接会打开指向目标 URL 的标签页（导航由本地 stub 接管，无外发流量） |

A9-5 刻意用 `context.route` 精确 stub 掉那一条外链的导航，并在 A12-1
「全流程未向远端发送 PDF 或签名」中按**完整 URL**（而非整个域名）排除，
既拿到端到端的点击证据，又不放过任何真实外发。

**同时清理的 3 处 Minor**：给按钮原语区块补顺序约束注释（M-1）；删除 5 处零引用导出
`templateCount`、`hasLoadedLibrary`、`closeDocument`、`assetSize`、`IDENTITY_MATRIX`（M-2，
其中 `closeDocument` 等于「关闭当前文档」只有 API 没有入口，已一并移除——如将来需要该能力，
应连同 UI 入口一起加回）；把 `usePdfDocument.ts` 里一条悬空注释改写成指向 `performOpen` 的说明（M-4）。

**两处按审查建议留待单独确认**：深色模式主按钮白字对比度 2.70:1（低于 WCAG AA 4.5:1，旧配色一致，
改动会影响既有深色视觉）与 `PdfPage.vue` 两处 `getPage()` 未 `cleanup()`（属性能细节，
且 `cleanup()` 作用在共享页代理上有副作用风险，未做实测不贸然改）。

**复验**（详细命令见 `docs/acceptance/README.md`）：

| 检查                              | 结果                                               |
| --------------------------------- | -------------------------------------------------- |
| 修复验证探针 `fix-verify.mjs`     | 6/6 通过（含 2 条「断言有区分力」的对照）          |
| 浏览器验收 `acceptance.mjs`       | **连续三轮 41/41 通过**，id 顺序与逐项结论完全一致 |
| 计算样式比对 `tw-check.mjs`       | 55 项 0 失败                                       |
| 样式复验 `tw-visual.mjs`          | 0 失败                                             |
| `vp check`                        | 29 文件格式正确 / 0 error、0 warning、0 type error |
| `vp run build`（含 `vue-tsc -b`） | 通过，CSS 产物 20.90 kB（gzip 5.36 kB）            |
| `pnpm verify:geometry`            | 86 项通过                                          |

**一个中途踩到的坑，值得写下来**：验收期间有两次运行在 A2-2 崩掉（30 秒点击超时）。
查下来不是产品缺陷，而是**我在跑验收的同时编辑了 `docs/*.md`**——
`vp dev` 对项目根目录下任何文件的写入都会触发整页重载（实测确认，含不在模块图里的 `docs/*.md`
与根 `README.md`；只有点目录 `.workbuddy/` 被忽略）。重载冲掉了 A2-2 给
`IDBObjectStore.prototype.put` 打的补丁，「模拟存储失败」于是变成真的写入成功，弹窗被关闭，
后续点击定位不到元素而超时。
处理方式不是放宽断言，而是把它变成可诊断的失败：A2-2 现在记录并断言「用例期间整页重载 0 次」，
一旦被干扰立即给出明确原因，而不是让人误以为是实现坏了。改动项目目录之外的文件（如 `/tmp`）不受影响。

A1-6 的实测明细值得单独记一笔：`backing=524x200，预期=524x200，getBoundingClientRect 折算=516~518`。
同一时刻两种测法给出不同数值（差值正是入场动画那 2% 缩放），说明这条断言**能真正区分新旧实现**——
若退回旧写法它必然失败，而不是恰好通过。

### 6.7 第二轮审查后的修复（3 项 P2 + 1 处空白字符）

6.6 节之后又做了一次审查（结论 `REQUEST_CHANGES`，3 项 P2）。三处都是**真实浏览器里的
布局几何与画布后备尺寸**才能看见的问题，构建、类型检查、lint、以及此前全部 41 项断言都不受影响。

| 编号 | 问题                                                           | 根因                                                                                                                               | 修法                                                                                                        |
| ---- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| P2-1 | **放大后页面左侧无法滚动到达**，看不到也放不了签名             | 内容层只有 `items-center`：页面比容器宽时，两侧溢出量被均分，左侧那一半落进 `scrollLeft` 最小值 0 之外（负向滚动区）               | 内容层加 `min-w-max`（`min-width: max-content`），容器随最宽页面撑开；内容较窄时该值不生效，居中不变        |
| P2-2 | **贴边放置的签名导出会被裁掉越界部分**（预览完整、导出缺一角） | `placeAt()` 初次放置直接按点击中心生成矩阵，没有走拖动时已有的 `clampMatrixToViewBox` 约束；预览层不裁剪，导出却受页面可见区域限制 | 初次放置同样先 `clampMatrixToViewBox`，与 `applyMatrix` 的约束路径一致                                      |
| P2-3 | **逐页浏览长文档后，已看过的页面持续占用像素缓冲与文本层**     | 所有页面组件始终挂载，离开视野只 `cancelRender()`，已完成的 canvas 后备缓冲与文本层一直留着                                        | 离开视野改为释放渲染产物（取消渲染 + `canvas.width/height = 1` + `destroyTextLayer`），重新进入时完整重渲染 |

**修 P2-3 时发现一个更上游的根因，必须一并修掉，否则「离屏即释放」会把滚动变成白页**：
`IntersectionObserver` 原本用 `{ root: null, rootMargin: "900px 0px" }`，
但 **`rootMargin` 只扩大 root 的矩形，交叉矩形还要经过中间每个滚动祖先可视区的裁剪**。
root 为视口时，滚动容器自己的可视区把扩大出来的部分整块裁掉，900px 预渲染余量**实际等于 0**。
实测证据：第 13 页在视口中时，第 14 页 `top=1154`（落在扩大后的视口底边 1800 以内）却
`canvas.width=1`、从未渲染——余量带完全没生效。

修法是把 root 显式指向滚动容器（模板上新增 `data-scroll-root` 锚点）。改后同样位置
第 12、13、14 页都持有缓冲，进入视野前 900px 开始渲染、离开 900px 后才释放。
这条同时解释了 A11 原先为什么「一次只渲染 1 页」——不是设计如此，而是余量配置被静默忽略了。

**离屏释放刻意保留 `viewport` 与链接**：两者都很轻（一个几何对象和几条注解），
而签名层要靠 `viewport` 把实例还原到页面上。丢掉它，页面一离屏签名 DOM 就整体消失——
A3-1「同页两个实例 + 第二页一个实例」与 A4-1 都要跨页统计实例数，会被这一条静默打破。

**验收脚本新增 A13 段共 6 条断言**（41 → 47 项）：

| 新断言        | 验证内容                                                                      |
| ------------- | ----------------------------------------------------------------------------- |
| A13-1         | 放大到横向溢出后，`scrollLeft = 0` 时页面左边缘仍在滚动原点右侧（可达）       |
| A13-2 / A13-3 | 贴左边缘 6px、下边缘 6px 放置的实例被收进页面内；导出后图片包围盒四边余量非负 |
| A13-4         | 逐页浏览 12 页后，离屏页面不保留像素缓冲与文本层                              |
| A13-5         | 反向断言预渲染余量生效（折叠线以下的相邻页已提前渲染）                        |
| A13-6         | 回到已看过的页面：画面与文本层重建、签名实例仍在                              |

A13 用的长文档是新夹具 `heavy-text-40p.pdf`（40 页 × 约 3300 字符，由
`tests/acceptance/fixtures/make-heavy-text.mjs` 生成；脚本缺夹具时自动补齐）。
原先的 `book-100p.pdf` 每页只有 53 个字符，文本层泄漏只剩个位数节点，看不出实现差异。

**另外修掉 `README.md` 末尾多余空行**（`git diff --check` 从 `README.md:134: new blank line at EOF`
变为无输出）。同时把检查范围扩到全部 45 个已跟踪与新增文本文件（`git diff --check` 不覆盖未跟踪文件，
而本轮审查覆盖的是「未提交代码及新增文件」）：行尾空白、末尾多余空行、CRLF、缺结尾换行 **0 处**。

**复验**：

| 检查                               | 结果                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------- |
| P2 专项探针 `p2-verify.mjs`        | 15/15 通过（每条断言都附「区分力对照」，见 `docs/acceptance/README.md`）  |
| 浏览器验收 `acceptance.mjs`        | **连续两轮 47/47 通过**，id 顺序与逐项结论完全一致（A13 明细逐字相同）    |
| 计算样式比对 `tw-check.mjs`        | 55 项 0 失败                                                              |
| 样式复验 `tw-visual.mjs`           | 0 失败                                                                    |
| `vp check src vite.config.ts docs` | 29 文件格式正确 / 0 error、0 warning、0 type error                        |
| `vp run build`（含 `vue-tsc -b`）  | 通过，CSS 产物 20.93 kB（gzip 5.37 kB，+0.03 kB 即 `min-w-max` 单条规则） |
| `pnpm verify:geometry`             | 86 项通过                                                                 |
| 空白字符（45 个文本文件）          | 0 处问题                                                                  |

三处修复的区分力对照（都在 `p2-verify.mjs` 里）：

- **P2-1**：运行时注入 `min-width: 0` 复现修复前行为，页面左边缘立刻从 `+16px` 变成 `−488px`（300% 缩放，1280px 视口）。断言不是恒真。
- **P2-2**：报告「若按点击中心直接摆放则应为 −118.2px / −23.2px」——这两个数本身就是越界量；实际落在 `0.00px`（被平移收边），导出侧四边余量 `0.0 / 0.0`。
- **P2-3**：报告「渲染过的页面数」与「仍持有缓冲的页面数」。旧实现下二者同步增长；实测 26 页时 `26 → 3` 个缓冲、`40.61MB` vs 旧实现约 `351.99MB`；200% 缩放 + DPR 2 下 `88.75MB` vs `636.8MB`。离屏文本节点 `0` 个（当前页仍持有 141 个，证明文本层确实在渲染）。

### 6.8 第三轮审查后的修复（2 项 P2）

6.7 节之后又做了一次审查（结论 `REQUEST_CHANGES`，2 项 P2）。两处都是**异步竞态**：
一条在「切换文档」的 DOM 更新与渲染回调之间，一条在「保存签名」的 `toBlob` 异步窗口里。
静态检查与全部 47 项断言都不受影响。

| 编号 | 问题                                          | 根因                                                                                                                                                                                                                                                            | 修法                                                                                                                                                                      |
| ---- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-4 | **切换 PDF 后部分缩略图持续空白**，且不会自愈 | `watch(documentId)` 的 `flush` 是 `pre`，在 DOM 更新**之前**运行；此刻 `canvasRefs` 仍是旧文档的画布而 `documentId` 已是新值。按旧路径就是「用新文档编号把内容画进已移除的画布」，任务完成即把新页面写进 `renderedKeys`，随后挂载的新画布因缓存命中永久跳过渲染 | 切换时只作废缓存（`cancelAll()` + `renderedKeys.clear()`），渲染交给新节点的观察器回调；`renderThumbnail` 在 `await` 之后核对**会话与画布双重身份**，不符即放弃且不写缓存 |
| P2-5 | **保存签名可重复提交，或取消后仍保存**        | `cropToInk()` 内含 `await toBlob()`，而 `isSaving` 在裁剪**完成之后**才置位；这段窗口里保存按钮（`canSave` 只看 `!isSaving`）与「取消」（`handleClose` 也只看 `isSaving`）都放行，于是可并发第二次写入，或关掉窗口后首个任务继续落库                            | 进入异步之前即置位 `isSaving`，把裁剪与存储一起纳入 `try/finally`                                                                                                         |

**P2-4 的复现难点**：直接按「打开 A → 打开 B」执行复现不出来——观察器的首次回调在实践中
只比 DOM 更新晚几毫秒，`getPage()` 还没来得及返回，stale 分支就已经被会话身份检查挡住。
为把这条竞态变成**确定性复现**，验收脚本在页面里替换 `IntersectionObserver`，给命中缩略图的
回调**投递**加 400ms 延迟（只延迟投递，不改回调内容），让 stale 渲染有机会跑完。同一扰动下
旧实现稳定 8 项全空白、新实现稳定 0 项空白，区分力因此可证。

**顺带核查**：缩略图观察器另有 `rootMargin: "240px 0px"`（`root: null`）。因 6.7 节已确认这类
组合可能被滚动容器可视区裁掉，本轮一并实测——初次加载时面板内 5 项全部已绘制，且紧邻底部、
落在 240px 余量内的第 6 项也已提前渲染，**余量在缩略图上确实生效**，不存在与 P2-3 同源的
失效，故未改动。

**验收脚本新增 A14 段共 7 条断言**（47 → 54 项）：

| 新断言        | 验证内容                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------ |
| A14-1 / A14-2 | 切换文档后可视缩略图全部已绘制、无画布停在默认 300×150；滚到面板底部后新入视野的缩略图同样已绘制 |
| A14-3 / A14-4 | 注入「回调投递推迟 400ms」扰动下：旧画布被改写 0 次、detached 0；可视缩略图依然全部已绘制        |
| A14-5 / A14-6 | `toBlob` 窗口期内按钮已禁用、点「取消」不放行；重复点击只写入 1 项，保存成功后弹窗正常关闭       |
| A14-7         | 反向对照：保存成功后闸门已复位，重开弹窗按钮不再停在「保存中…」且可正常取消                      |

**复验**：

| 检查                              | 结果                                                                  |
| --------------------------------- | --------------------------------------------------------------------- |
| P2 专项探针 `p3-verify.mjs`       | 13/13 通过（每条断言都附「区分力对照」）                              |
| 反向对照 `p3-control.mjs`         | 逐片段回退根因后同一探针按预期转红（P2-4：8 空白 + 80 次 stale 改写） |
| 浏览器验收 `acceptance.mjs`       | **连续三轮 54/54 通过**（A1—A14）                                     |
| `vp check src vite.config.ts`     | 23 文件格式正确 / 0 error、0 warning、0 type error                    |
| `vp run build`（含 `vue-tsc -b`） | 通过，CSS 产物 20.93 kB（gzip 5.37 kB，与第二轮持平）                 |
| `pnpm verify:geometry`            | 86 项通过                                                             |
| `git diff --check`                | 通过，无输出                                                          |

> A14-3 的明细里含墙钟量测（实测投递延迟 401—403ms，注入值固定 400ms），逐轮会差几毫秒；
> 其余每条断言的状态量（改写次数、detached 数、空白项、库内新增项数）逐轮完全一致。

**本轮未处理的存量项**：`public/favicon.svg` 缺结尾换行（`HEAD` 版本即如此，与本轮变更无关，
未改动以免产生无关 diff）；`docs/code-review-2026-09-20-verified-issues.md` 与
`docs/deepseek-optimization-task.md` 由另一条并行工作流产出，存在纯排版级别的格式漂移，
为免改写他人正在编写的文件，未代为格式化。

### 6.9 第四轮审查后的修复（2 项 P2 均为「新行为缺断言」+ 1 项修复自身引入的 P3）

第四轮审查的结论是 `REQUEST_CHANGES`，但两条都不是代码写错了 —— 是**新行为没有断言守住**，
属于审查标准里的「缺少验证」类 P2。修复以补断言为主，并为焦点契约补上显式的面板聚焦处理；
同时保留由 `tabindex="-1"` 引入的 Tab 循环副作用修复。

| 编号 | 断言的缺口                                           | 补齐方式                                                                                                                                      |
| ---- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-1 | 新增的「加密文档拒绝导出」在 `tests/` 里没有任何引用 | 入库夹具 `fixtures/encrypted-owner-password.pdf`（空用户口令 + 非空所有者密码，pypdf 一次性生成）+ `geometry` 新增 4 个用例 + 验收新增 A15 段 |
| P2-2 | `tabindex="-1"` 修复无断言能区分新旧实现             | 面板增加显式正文点击聚焦；验收新增 A16 段 3 条，按「机制 → 可感知结果 → 反向对照」分层                                                        |

**A15：加密文档能打开、但导出必须被拒绝。** 这类文档（只设所有者密码）PDF.js 不要求输入密码就能
渲染，因此用户确实能打开它；而 pdf-lib 不解密内容流，照写就是**静默产出坏文件**。
四条断言覆盖两侧引擎：

| 断言                        | 验证内容                                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `geometry` 夹具自证（2 条） | 默认加载被拒（证明「加密」是文档自身属性）+ `ignoreEncryption` 下 `isEncrypted === true`、页数 2                                          |
| `geometry` 导出拒绝 + 反向  | `exportSignedPdf` 抛统一文案且源字节未变；同一装配下非加密文档仍导出成功                                                                  |
| `geometry` 区分力对照       | 显式忽略 pdf-lib 加密检查并摘掉导出守卫时，同一份输入**成功返回字节** —— 仅作为守卫效果对照，不代表 HEAD 旧流程                           |
| A15-1 / A15-2               | 浏览器里无需密码即可打开并真实渲染（不透明像素占比 1.00）；导出后出现「已加密 / 暂不支持」提示、**下载事件 0 次**、实例与成功提示未被污染 |

实测对照（回退守卫、其余不变，整套验收 58/59）：

| 断言  | 回退后实测                                                                                                                         |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- |
| A15-2 | 在“忽略加密检查且删除守卫”的对照流程中，提示为空、**下载 1 次**（`encrypted-owner-password-signed.pdf`）——展示静默产出坏文件的后果 |
| 对照  | `geometry` 的「导出被拒」用例转红，失败输出里能直接看到被产出的字节数组                                                            |

**A16：确认弹窗点击正文后的键盘可用性。** 把断言分成两层，避免落进 A-5「恒真断言」：

| 断言  | 层次       | 验证内容                                                                                                        | 回退 `tabindex` 后    |
| ----- | ---------- | --------------------------------------------------------------------------------------------------------------- | --------------------- |
| A16-1 | 机制       | 点击正文后 `activeElement` 是弹窗面板而不是 `document.body`                                                     | 转红（实测 `<BODY>`） |
| A16-2 | 可感知结果 | 此后 Esc 仍能关闭弹窗且不切换文档                                                                               | 转红（弹窗留在原地）  |
| A16-3 | 反向对照   | 点击正文后立即从 dialog 面板执行 `Shift+Tab`，再验证 Tab / Shift+Tab 循环全程收在弹窗内（按运行时按钮名判顺序） | 见下面的 P3           |

> 最初我还写了一条「点击正文后按 Tab，焦点仍在弹窗内」，回退 `tabindex` 后它**照样通过**：
> Chrome 把点击位置当作顺序焦点导航的起点，从 body 出发的 Tab 仍会落回弹窗内的按钮。
> 这条按项目标准属于恒真断言，已删除，改为把焦点走向写成 `note` 留档。

**顺带修掉修复自身引入的 P3（一行）。** 探针实测发现：加了 `tabindex="-1"` 之后焦点会落在面板
**自身**，而 `handleKeydown` 的 Shift+Tab 分支只判断 `active === first || !inside` —— 面板既不是
`first` 也算 `inside`，于是走浏览器默认行为，把焦点交给遮罩背后的工具栏：

| 状态                                     | 点击正文后按 Shift+Tab 的实测落点        |
| ---------------------------------------- | ---------------------------------------- |
| 加 `tabindex` 但不处理面板自身（中间态） | `<BUTTON>`「新建签名」，在弹窗内 `false` |
| 加上 `active === panelRef.value` 之后    | `<BUTTON>`「取消」，在弹窗内 `true`      |

这条守的不是原来的 bug（旧实现里焦点在 body，反而留在弹窗内），而是修复的副作用，与 A14-7
同类。契约已登记为 C-18 / C-19（见 `docs/code-review-guidelines.md` 5.1 节）。

**复验（历史记录）**：

以下通过结果对应已归档的旧脚本运行。`acceptance-report.json` 中 A16-3 的实际顺序仍为
`Tab → Tab → Shift+Tab → Shift+Tab`；当前脚本已改为从面板首先执行 `Shift+Tab`，
调整后的顺序尚无归档验证结果。本次仅更正归档说明，未重新运行验收。

| 检查                                      | 结果                                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 浏览器验收 `vp test --project acceptance` | **连续两轮 59/59 通过**（A1—A16）                                                                                                                                                                |
| `vp test --project geometry`              | 23 个用例通过（原 19 + 加密导出 4）                                                                                                                                                              |
| 区分力对照（逐片段回退）                  | 删除导出守卫并回退 `tabindex` 后：套件 58 项中 56 项通过，**A15-2、A16-1 转红**（A16-2 当时并入 A16-1）；其中 A15 对照显式使用 `ignoreEncryption`，用于展示守卫缺失的后果                        |
| A16-3 的副作用对照                        | 验收第一步直接从 dialog 面板执行 `Shift+Tab`；中间态探针仍记录未处理面板自身时会落到「新建签名」、在弹窗内 `false`。回退 `tabindex` 时 A16-3 不会转红——那时焦点在 body，Shift+Tab 反而留在弹窗内 |
| `vp check`（本轮改动文件）                | 格式 / lint / 类型全绿                                                                                                                                                                           |
| `git diff --check`                        | 通过，无输出                                                                                                                                                                                     |

## 7. 已知问题与待确认项

1. **本方案涉及的源文件与文档静态检查全绿**：`vp check src vite.config.ts` 报告
   23 个文件格式正确、0 error / 0 warning / 0 type error；本方案产出的文档
   （`README.md`、`docs/code-review-2026-09-20.md`、`docs/implementation-report.md`、
   `docs/acceptance/**`）格式检查均通过。
   全仓 `vp check` 仍会报告 `public/pdfjs/wasm/*.js`（PDF.js 随包资源）、
   `docs/implementation-plan.md`、`docs/product-plan.md`（既有文档），以及
   `docs/code-review-2026-09-20-verified-issues.md`、`docs/deepseek-optimization-task.md`
   （另一条并行工作流产出）的格式差异——这些属于有意保留的无关文件，未做改动，避免无关清理。
2. **`vp test` 当前为空跑**：项目没有测试文件，`vp test` 以「No test files found」退出码 1 结束。
   本方案的验证以 `scripts/verify-pdf-geometry.mjs`（数值契约）与浏览器验收脚本承担。
   是否补一份 vitest 单测属于新增范围，需另行确认。
3. **导出使用的 pdf-lib 1.17.1 未处理页面 UserUnit 的缩放语义**：坐标由 PDF.js viewport 逆变换
   得到，属于 PDF 默认用户空间，与内容流坐标系一致；UserUnit 非 1 的文档在本方案下
   预览与导出的坐标系一致，但未在真实 UserUnit≠1 的样本上验证。
4. **CropBox 原点非零时的显示约定**：导出坐标与 pdf.js 的 viewport 契约保持一致（内容流坐标即
   CropBox 坐标）。A5 已用非零 CropBox 样本通过数值与渲染双重核对。
5. **放置模式的点击语义**：放置模式下点击页面空白处放置新实例，点击已有实例只选中。
   因此放置模式下页面链接不可点击，需要先按 `Esc` 退出放置模式。此为设计取舍，非缺陷。
6. **`useSignatureEditor` 的状态监听**：每个 `SignatureOverlay` 实例都会注册一个
   `watch(session, resetEditorState)`。长文档下 watch 数量随页数增长，行为正确但有冗余，
   后续可上移为单处监听。
7. **缩略图与主视图共用同一份 PDF.js 文档对象**：切换文档时按 `documentId` 重建列表，
   缩略图的旧渲染任务会在切换时取消；未在超长文档上实测切换开销。
8. **测试选择器已从 BEM 类名换成 `data-testid`（见 6.5 节）**：这意味着样式再调整不会影响验收，
   但反过来，**新增被验收依赖的元素必须同时补 `data-testid`**，否则脚本会以「找不到元素」失败而不是静默通过。
9. **Tailwind 只增加了一条构建期依赖**：`tailwindcss` 与 `@tailwindcss/vite` 都属于
   `devDependencies`，运行时不引入任何 CSS-in-JS 或脚本；构建产物 CSS 由 11.4 kB 增至约 20.9 kB
   （gzip 3.3 → 5.4 kB），增量来自工具类本身。若后续对首屏体积敏感，可考虑按路由或组件拆分。
10. **未提交、未推送**：按方案要求仅完成工作区改动，分支仍为 `develop`。
11. **离屏释放的边界（6.7 节的取舍）**：页面离开预渲染余量带（视口外 900px）即释放像素缓冲与文本层，
    重新进入时完整重渲染。因此**一帧内跃过 900px 以上的极快滚动**会看到短暂空白页；
    余量可在 `PdfPage.vue` 的 `rootMargin` 调整，代价是常驻缓冲数量线性增加。
    实测常驻 2—3 页：DPR 2 + 适合宽度约 40MB，200% 缩放约 89MB——相对「随浏览页数无限增长」仍是 O(1)。
    余量本身不会随滚动方向抖动，因为进入与离开用的是同一个带（迟滞区间 900px）。
12. **`data-scroll-root` 是 App 内部契约**：页面组件靠它取滚动容器当 `IntersectionObserver` 的 root
    （原因见 6.7 节）。它和 `data-testid` 不是一回事——前者是运行时行为依赖，改动会让预渲染与释放同时失效；
    后者只服务验收脚本。新增包裹层时不要把它挤到内层。
13. **缩略图的缓存键是 `documentId + pageIndex`（6.8 节的取舍）**：因此切换文档必须让缓存整体失效，
    否则新文档的缩略图会命中旧文档的键而跳过渲染。`watch(documentId)` 只做失效、不主动渲染，
    渲染一律由新节点的观察器回调发起，并在 `await` 后核对会话与画布身份——修改这段逻辑时，
    这三条（先失效、不抢跑、核对身份）缺任何一条都会重现「切换后空白且不自愈」。
14. **缩略图渲染失败会写入缓存、不重试**：`renderThumbnail` 的非取消异常也会记入 `renderedKeys`
    （避免失败项被反复重试），但只对**仍然有效的画布**记录。若把这条记录放宽到已被替换的画布上，
    问题会从「报错」变成「静默空白」，与 6.8 节的根因同源。
15. **本轮存在两处未处理的存量/并行项**：`public/favicon.svg` 缺结尾换行（`HEAD` 版本即如此，
    与本轮变更无关，未改动以免产生无关 diff）；`docs/code-review-2026-09-20-verified-issues.md`
    与 `docs/deepseek-optimization-task.md` 由另一条并行工作流产出，存在纯排版级别的格式漂移，
    未代为格式化以免改写他人正在编写的文件。若要让 `vp check docs` 全绿，对这两份文档跑一次
    `vp check --fix` 即可（改动仅为 Markdown 表格补白与标题前空行）。

## 8. 建议的下一步

1. 若需要长期回归保障，把 `scripts/verify-pdf-geometry.mjs` 的契约检查迁移为 vitest 单测，
   使 `vp test` 不再空跑（属于新增范围，需确认）。
2. 用一份 UserUnit≠1 的样本补充第 7 节第 3 条的验证。
3. 若要把验收脚本纳入仓库以便持续复用，需先接受 `playwright-core` 与 Python 侧
   `pypdf`/`pypdfium2` 作为开发依赖。
