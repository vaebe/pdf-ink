# 测试与验收

PDFInk 的端到端验收脚本、探针与夹具。**曾经散落在 `/private/tmp/pdf-ink-fixtures/`（不在版本控制内，
随时可能丢失，他人无法复现「54/54」这类结论）**，现全部纳入仓库；`docs/code-review-guidelines.md`
的「验证不可复现」缺口由此闭合。

测试由 Vitest 管理：数值契约在 Node 中执行，浏览器验收用 Playwright 操作真实 Chromium，
导出的 PDF 由 `support/pdf.ts` 使用 PDF.js / pdf-lib 读回并渲染为 PNG。
不再需要 Python。读回仍检查文字、链接、图片变换与页面边界，但不再提供跨 PDF 引擎交叉验证；
PNG 是人工查看的产物，当前没有自动像素差异比较。

## 快速开始

前置条件：

```bash
pnpm install                      # postinstall 会同步 public/pdfjs（约 3.9MB，不入库）
pnpm exec playwright-core install chromium   # playwright-core 不打包浏览器，需单独装
```

跑起来（**两个终端**）：

```bash
# 终端 1：固定端口。原始脚本硬编码 localhost:5199，端口漂移会让所有用例一起红。
vp run dev --port 5199 --strictPort

# 终端 2：主套件（1 个连续集成用例，59 项验收断言）
vp test --project acceptance
```

主套件通过 Vitest 的 Node 环境运行，Playwright 负责操作真实应用，不使用 Browser Mode。
`vp run test:acceptance`（或 `pnpm test:acceptance`）仍是兼容入口；
`acceptance/run.mjs` 只导出 `runAcceptance`，由 `acceptance/acceptance.test.mjs` 调用。

`vp test` 会同时执行数值与浏览器两个项目，仍需提前启动应用。
数值检查可单独使用 `vp test --project geometry`，不需要浏览器。
每项 `check` 同时写入报告并触发 Vitest 软断言；任一断言失败会使集成用例失败，
操作异常则中断连续流程并关闭浏览器。用例数量与逐项断言数量分别统计。

## 环境变量

全部默认值集中在 `support/browser.mjs`，脚本内不写机器路径。

| 变量            | 默认                     | 说明                                                                                                                                   |
| --------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `PDFINK_APP`    | `http://localhost:5199/` | 被测应用地址                                                                                                                           |
| `CHROMIUM_PATH` | 空                       | 指定现成的 Chrome for Testing 可执行文件。留空则交给 Playwright 按自身修订号解析——本机 Playwright 期望的修订号与已缓存的不一致时需要它 |
| `PDFINK_OUT`    | 系统临时目录             | 产物根目录，**默认在仓库之外**，见下节                                                                                                 |

### 浏览器修订号对不上时怎么办

套件只依赖 `playwright-core`（不打包浏览器）。启动失败时报的是这种错，它不是套件的问题：

```
browserType.launch: Executable doesn't exist at
  ~/Library/Caches/ms-playwright/chromium_headless_shell-<A>/chrome-headless-shell-mac-arm64/chrome-headless-shell
```

`<A>` 是**当前 `playwright-core` 期望的修订号**，本机缓存里是另一个号（例如缓存有 `1234`、期望 `1243`）就会这样。
两条路任选：

```bash
pnpm exec playwright-core install chromium   # 正规做法：补下载期望的修订号
```

```bash
# 或者直接复用已缓存的同名二进制（版本接近时可用，省一次下载）
export CHROMIUM_PATH="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell"
```

## 产物落点：刻意放在仓库之外

默认写到 `<系统临时目录>/pdf-ink-acceptance/`（`out/`、`out-tw/`、`p3-fixed-backup/`），运行结束会打印
`report.json` 的绝对路径。

**不要把它改回仓库内**。`vp dev` 对项目根目录下任何文件的写入都会触发**整页重载**（实测 `docs/*.md`、
根 `README.md` 这类不在模块图里的文件同样会触发；只有 `.workbuddy/` 这类点目录被忽略），而整页重载会
冲掉用例打在页面里的补丁（例如 A2-2 替换的 `IDBObjectStore.prototype.put`），表现为「某个断言莫名失败、
外加 30 秒点击超时」，极易误判为产品缺陷。A2-2 已把「用例期间整页重载 0 次」写成断言：

```
用例期间整页重载 0 次（应为 0，非 0 说明调试期写入了项目目录，重载会冲掉 put 补丁）
```

## 目录结构

```text
tests/
├── README.md                 测试入口、环境与覆盖说明
├── geometry/                 数值契约与 PDF 工具测试（Vitest）
├── acceptance/
│   ├── acceptance.test.mjs   浏览器验收入口（Vitest）
│   └── run.mjs               保持原顺序的连续验收流程
├── support/
│   ├── browser.mjs           路径、产物、应用地址及浏览器配置
│   └── pdf.ts                PDF 结构读回与 PNG 渲染
├── fixtures/                 PDF 夹具与生成脚本
└── manual/
    ├── probes/               常备探针，按需手动执行
    └── diagnostics/          历史诊断脚本，不自动收集
```

`vp test` 只收集 `geometry/*.test.ts` 和浏览器入口。`manual/` 不会自动执行；
其中 `p3-control.mjs`、`rewrite-selectors.mjs` 等工具会改写源码或脚本，按需明确选择，不能批量运行。
例如只运行已迁移的 P2 探针：`vp exec node tests/manual/probes/p2-verify.mjs`。

### 主套件覆盖

| 段      | 主题                                                                           |
| ------- | ------------------------------------------------------------------------------ |
| A1—A2   | 签名库落库、刷新后持久化、空白画布拒存、存储失败保留笔迹                       |
| A3—A4   | 跨页实例、拖动/缩放、单实例删除、模板删除的连锁影响                            |
| A5—A6   | 旋转页与 CropBox、导出变换行列式、DPR 2 多缩放拖动无漂移、切换态 hover 配色    |
| A7—A8   | 撤销/重做分支、导出幂等与源文件不被改写                                        |
| A9      | 文字层与链接：链接不被文本层吞掉指针事件、导出后仍可提取文字/保留注解          |
| A10—A12 | 快速换文件、100 页文档、全程无未捕获异常、不外发数据                           |
| A13     | 布局可达性、贴边放置与导出不裁剪、离屏资源释放、预渲染余量                     |
| A14     | 切换文档后缩略图不空白、保存签名闸门（含反向对照）                             |
| A15—A16 | 加密文档可打开但导出被拒绝（含「未产生下载」）；确认弹窗点击正文后的键盘可用性 |
| B1—B6   | 数字签名文档的确认与失效提示、损坏文件、放弃编辑确认、无原生弹窗               |

### 常备探针

| 脚本                                                        | 断言数 | 用途                                                                                                                              |
| ----------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `manual/probes/p2-verify.mjs`                               | 15     | 布局可达性、贴边放置、离屏资源释放；每条都带「旧实现会怎样」的对照                                                                |
| `manual/probes/p3-verify.mjs`                               | 13     | 缩略图切换竞态、保存闸门；含「扰动确实生效」的自证断言                                                                            |
| `manual/probes/p3-control.mjs`                              | —      | 把 P2-4/P2-5 的**根因**回退成旧写法再跑 p3-verify：`apply` / `restore` / `status`。回退后必须变红，否则说明断言恒真或根因判断错了 |
| `manual/probes/thumb-margin-probe.mjs`                      | —      | 量缩略图观察器的 `rootMargin` 是否真的生效（**不要按结构类推**，本文件所在仓库的取值经实测才有效）                                |
| `manual/probes/tw-check.mjs`、`manual/probes/tw-visual.mjs` | —      | Tailwind 迁移后的视觉回归核对                                                                                                     |
| `manual/probes/fix-verify.mjs`                              | —      | 历史修复项的针对性复核                                                                                                            |

夹具由 `fixtures/make-fixtures.mjs`、`make-heavy-text.mjs`、`make-dot.mjs` 生成；缺夹具时主套件会自动补齐。
需要重建全部夹具：`pnpm fixtures:make`。

**例外：`fixtures/encrypted-owner-password.pdf` 不是脚本生成的，直接入库。**
它要求「用户口令为空、所有者密码非空」，pdf-lib 不提供加密能力，仓库里也没有第二套 PDF 写入实现，
所以用一次性命令生成后入库（A15 段依赖它；sha256 前 16 位 `84215ccac4d94730`）：

```bash
# 一次性、仅在需要重建该夹具时执行；测试运行本身不需要 Python
python3 -c "from pypdf import PdfWriter
w = PdfWriter(clone_from='tests/fixtures/plain.pdf')
w.encrypt(user_password='', owner_password='pdfink-owner', algorithm='RC4-128')
w.write(open('tests/fixtures/encrypted-owner-password.pdf','wb'))"
```

两侧引擎的行为已实测固定下来，改动该夹具前先确认它们仍然成立，否则 A15 与 `geometry`
的两条断言会以「加密语义变了」的形式失败：PDF.js 不要求密码即可打开（2 页、可渲染），
pdf-lib 默认加载被拒、`ignoreEncryption: true` 时 `isEncrypted === true`。

## 与 `docs/acceptance/` 的分工

- `tests/`（这里）= **可执行的脚本与夹具**，可复现、可审计。
- `docs/acceptance/` = **某一次运行的结论留档**（截图、导出样本、`acceptance-report.json`）。它是历史证据，
  不参与运行；脚本改动后其中的报告不会自动更新。

## 写新用例的约定

1. **定位一律走 `data-testid` / `data-*` 钩子**，不要绑视觉类名（Tailwind 重排会让断言失效）。
2. **每条断言都要有区分力**：能说清「旧实现会输出什么」。特别是为了证明某个根因，要么给出对照写法，
   要么把「扰动确实生效了」也写成断言（如 A14-3 判断注入延迟 ≥350ms、A14-4 判断染步被推迟）。
3. **测屏幕几何前先等瞬时提示条收掉**。应用把「签名已保存到本地签名库」「已导出 xxx」渲染成**参与布局**
   的横幅（`data-testid=banner`，约 36.5px 高，3.2s 后自动消失）；它消失时整个预览区会上移 36.5px，
   跨在拖动过程中就会被误读成「拖动漂移」（见 `acceptance/run.mjs` 的
   `waitForBannersToClear`）。A6-1 曾因此稳定误报 36.50px。
4. **放置模式是一次性的**：产品在成功放置一次后退出放置模式；再次放置前必须重新选中模板
   （`pickTemplate`）。**注意 `pickTemplate` 在条目已 `data-active` 时会跳过点击**——若此时放置模式
   其实已经退出，跳过就什么也放不下。直接调 `mouse.click()` 的用例要自己补这一步（A13-2、P2-2c 都踩过）。
5. **异步返回后要写回共享状态的地方，要重新核对身份**（会话 / DOM 节点仍属同一代）。

## 已知坑（都已写进代码注释）

- 项目目录下的任何写入都会让 dev server 整页重载 → 产物必须落在仓库外。
- **签名名称输入已移除**：`library-item-name` 节点不存在了，条目身份只能靠数量 + 预览图 `src`
  判断，不要再按名称断言。
- **文案类断言不要绑过死**：删除模板的确认框已改为泛指的「删除这个签名？」；「放弃当前编辑？」的
  补充说明刻意不再报条数（导出后删光实例会与基准不同，按数量描述会说错）。
- 中文路径 / 空格路径在 Windows 上不要写成 `.ps1`、`.bat`，编码会把文件名写坏。
