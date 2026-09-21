---
version: 1
slug: "src-views-homepage-vue"
primary_target: "src/views/HomePage.vue"
related_targets: []
---

# PDFInk 首页

Mode: Persuade。仅首页；操作页保留现有视觉。用户已确认极简签名入口，首页最多两屏，首屏必须可选择文件。

## Direction contract

THESIS: 一句用途、一个入口、一处笔迹示例；去掉强配色、场景包装和功能卡片。

OWN-WORLD: 柔白底色、石墨文字、细线边界、黑色按钮；中文标题以衬线字形和克制比例承载层次。

STORY: 读懂给 PDF 添加手写签名的用途，选择本地文件，加载成功后进入操作页。只承诺现有本地处理能力。

FIRST VIEWPORT: 左上小型字标；中央两行标题与说明、选择按钮；下方窄幅签名样张；底部一行能力和本地处理说明。落笔动画只运行一次，尊重减少动态效果设置。

FORM: 用户选择重新推荐的极简签名入口 quiet-focus；seed d6476be3，reroll 1。直接以代码实现，不使用生成图片。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

验证边界：按用户项目规则不启动应用、不运行测试。本轮只进行静态审核与限定文件检查，视觉及真实路由行为未验证。
