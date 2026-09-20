/**
 * 生成长文档性能夹具 heavy-text-40p.pdf。
 *
 * 已有的 book-100p.pdf 每页只有 53—66 个字符，用来验证「离屏释放文本层」太弱：
 * 泄漏量只有个位数节点，断言看起来通过但其实区分不出实现差异。
 * 这份夹具每页约 1200 个字符、40 页，文本层节点数是真实量级，
 * 让「离屏页面是否释放文本层」变成可量化的对比。
 *
 * 用法：node make-heavy-text.mjs [输出路径]
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const target = process.argv[2] ?? join(import.meta.dirname, "heavy-text-40p.pdf");
const PAGE_COUNT = 40;
const LINES_PER_PAGE = 46;

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);

for (let index = 0; index < PAGE_COUNT; index += 1) {
  const page = doc.addPage([612, 792]);
  page.drawText(`heavy text fixture — page ${index + 1} of ${PAGE_COUNT}`, {
    x: 48,
    y: 748,
    size: 13,
    font,
    color: rgb(0.06, 0.09, 0.16),
  });
  for (let line = 0; line < LINES_PER_PAGE; line += 1) {
    // 每行独立成一个文本对象，文本层会为它建一个 span。
    page.drawText(
      `L${String(line + 1).padStart(2, "0")} needle-${index + 1}-${line + 1} ` +
        "the quick brown fox jumps over the lazy dog 0123456789",
      { x: 48, y: 716 - line * 14, size: 9, font, color: rgb(0.12, 0.16, 0.24) },
    );
  }
}

await writeFile(target, await doc.save());
console.log(`已生成 ${target}：${PAGE_COUNT} 页 × ${LINES_PER_PAGE + 1} 行文本对象`);
