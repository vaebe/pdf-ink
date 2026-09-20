/**
 * 生成极轻量夹具 dot-40p.pdf：每页只有一个很小的填充矩形。
 *
 * 用途：P2-4 的症状是竞态——旧实现里 pre-flush 的 stale 渲染必须**赶在**观察器首帧回调
 * 之前完成，才会把「新文档编号」写进缓存、让真正的新画布永久跳过渲染。
 * 用 heavy-text 这类内容页渲染耗时较长，stale 渲染总是被回调取消，症状不出现；
 * 换成几乎无内容、但仍有非透明像素（能验证真的画上去了）的页面，
 * 就把这个竞态窗口拉开到可复现的程度。
 *
 * 用法：node make-dot.mjs [输出路径]
 */
import { PDFDocument, rgb } from "pdf-lib";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const target = process.argv[2] ?? join(import.meta.dirname, "dot-40p.pdf");
const PAGE_COUNT = 40;

const doc = await PDFDocument.create();
for (let index = 0; index < PAGE_COUNT; index += 1) {
  const page = doc.addPage([612, 792]);
  // 一个足够大、能落在缩略图里的小方块：保证「已绘制」可被像素探测到，
  // 同时把算子表压到最小，让渲染尽快完成。
  page.drawRectangle({
    x: 40,
    y: 700,
    width: 120,
    height: 60,
    color: rgb(0.1, 0.2, 0.5),
  });
}

await writeFile(target, await doc.save());
console.log(`已生成 ${target}：${PAGE_COUNT} 页，每页 1 个小矩形`);
