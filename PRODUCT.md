# PDFInk

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

需要为本地 PDF 添加可见手写签名、保存常用签名并重复使用的用户。

## Product Purpose

打开本地 PDF，创建或选择手写签名，放置到页面上，下载添加签名后的新 PDF。

## Operating Context

首页是简洁的工具入口，说明用途并提供“选择本地 PDF”按钮。文件成功加载后进入操作页；取消选择或加载失败时保留首页，并展示必要的错误提示。

首页使用 `#/`，操作页使用 `#/editor`；没有文档会话时访问操作页会返回首页。离开操作页结束当前文档会话，有未导出修改时先确认。

## Capabilities and Constraints

- PDF 与签名在浏览器本地处理；签名库使用 IndexedDB 保存。
- 只处理 PDF；签名是可见手写笔迹，不提供证书数字签名或身份认证。
- 原文件不被改写，编辑结果另存为新的 PDF。
- 当前操作页提供 PDF 预览、页面定位、缩放、签名库、签名放置与调整、撤销重做和下载。
- 保留现有文件加载、数字签名风险确认和未导出修改确认流程。

## Brand Commitments

产品名称为 PDFInk；沿用“保存常用签名，轻松签署 PDF。”的中文表达。

首页采用用户确认的“极简签名入口”：高级、简洁，最多两屏，首屏提供文件选择。

## Evidence on Hand

现有能力和限制见 README.md；页面与加载流程见 src/App.vue 和 src/composables/usePdfDocument.ts。

## Product Principles

- 清楚说明用途，让用户直接选择文件开始。
- 文件成功打开后才展示文档操作界面。
- 复用现有本地处理流程，保持修改范围集中。
