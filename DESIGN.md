---
name: PDFInk 首页
description: 仅适用于首页的极简签名入口视觉记录
colors:
  home-paper: "#fafaf9"
  home-ink: "#252527"
  home-muted: "#6d6d72"
  home-line: "#dededc"
  paper-white: "#fff"
  button-hover: "#424246"
  focus-ring: "#68686d"
typography:
  display:
    fontFamily: '"Songti SC", "Noto Serif CJK SC", "SimSun", serif'
    fontSize: "clamp(38px, 4.4vw, 62px)"
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: "-0.035em"
  body:
    fontSize: "15px"
    lineHeight: 1.9
  label:
    fontSize: "12px"
rounded:
  button: "7px"
spacing:
  button-gap: "12px"
  button-inline: "28px"
components:
  button-primary:
    backgroundColor: "{colors.home-ink}"
    textColor: "{colors.paper-white}"
    rounded: "{rounded.button}"
    padding: "0 28px"
  button-primary-hover:
    backgroundColor: "{colors.button-hover}"
  signature-paper:
    backgroundColor: "{colors.paper-white}"
    padding: "20px 28px 18px"
---

# Design System: PDFInk 首页

## Overview

**Creative North Star: "极简签名入口"**

柔白纸面与石墨文字构成安静、简洁的签名入口。中文衬线标题与细线手写笔迹提供识别度，主按钮保持明确，签名样张以轻微阴影表达纸面。

frontmatter 令牌适用于 `src/views/HomePage.vue` 的首页局部视觉，不替代 `src/style.css` 的全局语义系统。首页使用浅色局部样式；操作页采用下述独立局部令牌。产品约束见 `PRODUCT.md`，首页构图与首屏策略见 `.impeccable/surfaces/src-views-homepage-vue.md`。

**Key Characteristics:**

- 柔白石墨
- 中文衬线标题
- 克制纸面与手写笔迹

依据当前源码提取，尚未进行浏览器视觉验证。令牌仅收录已实现的主要角色，未建立通用组件库或补充推测值。

## Colors

### Primary

石墨（`home-ink`）用于主要文字与文件选择按钮；按钮悬停使用 `button-hover`，键盘焦点使用 `focus-ring`。

### Neutral

柔白（`home-paper`）为首页背景；纯白（`paper-white`）用于签名纸面和按钮文字；柔灰（`home-muted`）承载辅助说明；细线灰（`home-line`）用于签名横线及页脚分隔。

操作页由 `EditorPage.vue` 的 `.editor-workspace` 局部覆盖语义变量：浅色使用白色面板、`#eeefed` 阅读背景、`#29292c` 文字、`#343438` 强调色；深色使用 `#202023` 面板、`#171719` 阅读背景、`#ededee` 文字、`#d3d3da` 强调色。主按钮以前景／面板色反转，保留错误、警告等语义色。PDF 和签名画布不随界面主题染色。

## Typography

标题使用 frontmatter 中的中文衬线字体栈；实际字形取决于设备可用字体。正文与控件沿用项目继承字体，本记录不重定义其字体栈。

`display` 对应两行主标题，`body` 对应介绍文案，`label` 对应桌面页头说明和文件处理说明。首页还使用更小的样张与页脚文字，未据此扩展通用字号体系。

## Layout

首页纵向弹性布局并可垂直滚动，水平内边距为 `clamp(24px, 5vw, 80px)`。内容区域居中，最大宽度为 880px；签名样张宽度为 `min(100%, 380px)`。

600px 及以下时页头最小高度从 92px 调整到 72px，页脚变为居中纵向排列。首屏入口与最多两屏是已确认的首页目标，实际视口表现尚未通过浏览器确认。

操作页工具栏保持单行：文件名限制宽度并省略溢出内容，悬停显示完整名称；页码、缩放、编辑和下载按组排列，空间不足时横向滚动。签名库的新建与重新加载入口并排。页面栏宽 172px，签名栏宽 264px；中间保留弹性滚动阅读区。签名预览高 88px，按钮最小高 36px，小按钮最小高 32px。签名弹窗宽度上限 600px，内部留白 24px，超出视口高度时内部滚动。此轮仅静态检查，未验证实际操作舒适度。

## Elevation & Depth

白色签名纸面使用单层轻阴影。精确阴影记录在 sidecar 的 `extensions.shadows`；首页其他主要层次由留白、文字与细线表达。

## Shapes

主按钮采用小圆角（见 `rounded.button`）；签名纸面保持直角。签名示例使用圆端点、圆连接的 SVG 细线。

## Components

- 文件选择按钮：最小高度 54px，图标与文字横向排列。悬停上移 1px、按下回到原位；禁用时透明度为 0.6，使用等待光标。按钮和字标具有 2px 焦点轮廓，偏移 5px。
- 签名样张：标签、手写 SVG、细横线与辅助说明组成白色纸面；属于静态示例，不是可编辑签名控件。
- 落笔动画：使用 1.5s 描边动画，底线延迟 0.3s；减少动态效果设置关闭动画和按钮过渡。参数记录在 sidecar。
- 文件输入隐藏，仅由主按钮触发；复用的确认弹窗继续使用现有组件视觉，不纳入首页局部令牌。

## Do's and Don'ts

### Do:

- Do 保留柔白、石墨和细线组成的首页视觉层次。
- Do 保持文件选择入口突出，并保留加载、错误和键盘焦点状态。
- Do 尊重减少动态效果设置。

### Don't:

- Don't 将首页令牌用于覆盖操作页或全局语义令牌。
- Don't 在首页增加强配色、场景包装或功能卡片。
