# PDFInk

**保存常用签名，轻松签署 PDF。**

PDFInk 是一个开源网页工具：打开本地 PDF，手写一个签名并保存到本地签名库，把签名放到页面上，
然后下载添加了手写笔迹的 PDF。PDF 与签名都在浏览器本地处理，不上传到任何服务器。

> 这里的签名指写入 PDF 的可见手写笔迹，**不提供**证书数字签名、签署人身份认证或文件篡改验证能力。

## 启动方式

项目使用 [Vite+](https://viteplus.dev/) 管理（`vp` 统一命令行）。首次拉取代码后：

```bash
vp install          # 安装依赖（postinstall 会自动同步 PDF.js 资源到 public/pdfjs）
vp dev              # 启动开发服务器
```

生产构建与本地预览：

```bash
vp run build        # 同步 PDF.js 资源 && vue-tsc -b && vp build
vp preview
```

`public/pdfjs` 是由 `scripts/sync-pdfjs-assets.mjs` 从 `node_modules/pdfjs-dist` 复制出来的
**生成物**，已写入 `.gitignore`，不需要提交。安装、启动与构建都会自动重建它；
需要单独重建时执行：

```bash
pnpm sync:pdfjs
```

坐标与导出契约的数值验证（在 Node 中调用真实的 pdfjs-dist 与 pdf-lib）：

```bash
pnpm verify:geometry
```

## 当前支持范围

| 能力                                                       | 状态                             |
| ---------------------------------------------------------- | -------------------------------- |
| 打开本地 PDF、分页连续阅读、缩略图定位、页码跳转           | 支持                             |
| 缩放与「适合宽度」                                         | 支持                             |
| 手写签名（鼠标／触控笔），高像素密度适配                   | 支持                             |
| 签名裁剪到笔迹边界、透明背景 PNG                           | 支持                             |
| 本地签名库：保存、重命名、删除、重复使用                   | 支持                             |
| 页面放置、拖动、等比缩放、删除、撤销／重做                 | 支持                             |
| 导出为原文件名加 `-signed.pdf` 的新文件                    | 支持                             |
| 保留原文件的页面旋转（0/90/180/270）、CropBox 与页面尺寸   | 支持                             |
| 保留文字选择与基础链接交互                                 | 支持                             |
| 加密 PDF                                                   | 不支持，会提示无法打开           |
| 已包含数字签名的 PDF                                       | 支持编辑，但打开前会提示失效风险 |
| 手机／平板触控专门适配、PWA 离线、云端同步、签名库导入导出 | 暂缓                             |
| 签名自由旋转、PDF 正文编辑                                 | 不支持                           |

> 打开已含有效数字签名的 PDF 时，会先弹出确认框提示「继续编辑并导出会使原有数字签名失效」，
> 由用户确认后才打开。原始文件不会被改写，导出结果始终另存为新文件，提示也会在编辑过程中保留。

「打开新文件会放弃未导出编辑」「删除签名模板会不可撤销」这类操作同样会先弹出确认框；
确认框为页面内 dialog，可用 `Esc` 或点击遮罩取消，默认焦点落在「取消」上。

## 本地存储与隐私

- 签名库保存在当前站点的 **IndexedDB**（数据库名 `pdf-ink`，对象存储 `signatures`）。
- 当前打开的 PDF 与页面上的编辑只存在于当前会话，刷新页面后需要重新打开文件。
- 签名库仅对同一站点、同一浏览器环境可见；清除站点数据后会丢失，也不会跨设备同步。
- PDF 与签名均在浏览器内处理，构建产物中没有指向远端 CDN 的资源引用；
  PDF.js 需要的 worker、CMap、标准字体、WASM 与 ICC 资源由本站点的 `public/pdfjs` 目录提供。

## 键盘快捷键

| 快捷键                             | 作用                                   |
| ---------------------------------- | -------------------------------------- |
| `⌘/Ctrl + Z`                       | 撤销页面编辑                           |
| `⌘/Ctrl + Shift + Z`、`⌘/Ctrl + Y` | 重做页面编辑                           |
| `Delete` / `Backspace`             | 删除选中的签名（焦点在输入框时不生效） |
| `Esc`                              | 退出放置模式；未在放置时取消选中       |

## 实现结构

```text
src/
  App.vue                     页面布局与模块连接
  style.css                   设计令牌（@theme）与两个复用原语（.button / .input）
  styles/pdfjs-text-layer.css PDF.js 文本层的接口契约样式（不能用工具类表达）
  types/pdf.ts                文档会话、页面几何与签名实例类型
  types/signature.ts          签名模板与会话图片类型
  lib/pdfCoordinates.ts       页面与 PDF 坐标、矩阵转换
  lib/pdfExport.ts            读取原字节、嵌入签名、生成输出字节
  lib/signatureStore.ts       IndexedDB 打开与签名增删改查
  composables/usePdfDocument.ts       文件加载、PDF.js 生命周期、页面信息
  composables/useSignatureLibrary.ts  签名库加载、保存状态与错误展示
  composables/useSignatureEditor.ts   实例选择、页面操作和撤销重做
  composables/useConfirmDialog.ts     确认弹窗状态（Promise 化，供异步流程 await）
  components/                 PdfToolbar / PdfViewer / PdfPage / PageThumbnails
                              SignatureLibrary / SignaturePadDialog / SignatureOverlay
                              ConfirmDialog
scripts/
  sync-pdfjs-assets.mjs       同步 PDF.js 运行期静态资源
  verify-pdf-geometry.mjs     坐标与导出契约的数值验证
```

### 样式组织

样式由 [Tailwind CSS v4](https://tailwindcss.com/docs/installation/using-vite) 组织，插件接入方式见 `vite.config.ts`。

- **令牌在 `src/style.css`。** 颜色、字号、阴影先写成原生 CSS 变量，再由 `@theme inline`
  映射成 `bg-surface`、`text-ink-muted`、`text-meta` 这类语义工具类。`@theme inline` 让工具类
  直接内联成 `var(--surface)`，所以深色模式只需要覆盖 `:root`，模板里不写任何 `dark:` 变体。
- **外观写在模板上。** 组件的类名即样式，`src/style.css` 只保留 `.button` / `.input`
  两个在 5 个组件里重复出现的原语，以及手写区底纹 `@utility hatch`。
- **两处不适用工具类的地方单独成文件。** PDF.js 文本层的选择器与 CSS 变量是第三方契约
  （`src/styles/pdfjs-text-layer.css`）；缩放中的尺寸、矩阵变换这类运行期数值走行内 `style`。
- **同一属性不要同时给出静态与动态两个工具类。** 工具类优先级相同，胜负由样式表顺序决定，
  而不是类名书写顺序；互相排斥的取值要用三元表达式只输出一个，例如
  `:class="active ? 'border-accent' : 'border-line'"`。

### 布局契约要点

四处不写就「看着正常、用起来坏掉」的约束，改动预览区、缩略图或放置逻辑前先确认：

- **视口的内容层必须能随页面宽度撑开。** 内容层用 `items-center` 居中，同时带 `min-w-max`。
  `items-center` 在内容比容器宽时会把两侧溢出量均分，左侧那一半落进 `scrollLeft` 最小值 0
  之外——页面左边缘既看不到也放不了签名。`min-width` 只在内容更宽时生效，内容较窄时居中不变。
- **页面组件靠 `data-scroll-root` 找到滚动容器**，用它作为 `IntersectionObserver` 的 `root`。
  `rootMargin` 的预渲染余量只有在 root 是滚动容器本身时才作数：root 用视口时，
  中间滚动容器的可视区会把扩大出来的部分裁掉，余量可能实际为 0。这一条同时决定
  「离屏释放渲染资源」是否会把滚动变成白页。
  （缩略图那一侧是实测有效的个例，见 `docs/implementation-report.md` 6.8 节；调整前请用
  `/private/tmp/pdf-ink-fixtures/thumb-margin-probe.mjs` 重新量一次，不要按结构类推。）
- **放置与拖动的边界约束走同一条路径。** 初次放置和后续拖动都调用 `clampMatrixToViewBox`。
  预览层不裁剪越界部分，导出却受页面可见区域限制；只在拖动时约束，就会出现
  「预览完整、导出缺一角」。
- **缩略图的缓存键是 `documentId + pageIndex`。** 切换文档时必须让缓存整体失效，但**不要抢跑渲染**：
  `watch(documentId)` 在 DOM 更新之前触发，此刻手里还是旧画布；在那里渲染就是「用新文档编号
  把内容画进已移除的画布」，完成后把新页面标记为已渲染，新画布反而永久跳过渲染（表现为切换后
  部分缩略图空白且不自愈）。交给新节点的观察器触发，并在 `await` 之后核对会话与画布身份。

### 坐标契约要点

- 实例以「图片单位正方形 → PDF 用户空间」的六参数仿射矩阵保存，矩阵同时表达位置、尺寸与方向。
- 预览先把图片的左上、右上、左下三个角点换算到 viewport 坐标，再据此构造 DOM 变换；
  不直接把左下原点的矩阵套用为 CSS transform。
- 导出按 `translate → rotate → scale` 的顺序把矩阵分解为 pdf-lib `drawImage` 的
  `x`、`y`、`width`、`height`、`rotate`，写入前会校验矩阵无斜切、无镜像。
- 页面自带旋转与非零 CropBox 原点全部由 PDF.js viewport 的正／逆变换处理。

## 文档

- 产品与实现方向：`docs/product-plan.md`
- 执行方案与验收清单：`docs/implementation-plan.md`
- 本次实现报告：`docs/implementation-report.md`
