// 任务 A：构造「getDocument 成功但某页 getPage 抛错」的变异 PDF，验证泄漏路径可被触发。
import { PDFDocument, PDFName, PDFNumber, PDFNull } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { OUT_ROOT } from "../../support/browser.mjs";

const OUT = OUT_ROOT + "/";
async function makeBase(pages = 3) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    doc.addPage([612, 792]);
  }
  return doc;
}

// 在 catalog -> Pages -> Kids 中定位信息
function locate(doc) {
  const pagesRef = doc.catalog.get(PDFName.of("Pages")); // PDFRef
  const pagesDict = doc.context.lookup(pagesRef); // PDFDict
  const kids = pagesDict.get(PDFName.of("Kids")); // PDFArray
  return { pagesRef, pagesDict, kids };
}

async function tryLoad(label, bytes) {
  const task = getDocument({ data: bytes.slice() });
  const result = {
    label,
    getDocumentResolved: false,
    numPages: null,
    perPage: [],
    getDocError: null,
  };
  try {
    const pdf = await task.promise;
    result.getDocumentResolved = true;
    result.numPages = pdf.numPages;
    for (let p = 1; p <= pdf.numPages; p++) {
      try {
        const page = await pdf.getPage(p);
        const view = page.view; // 触发 readPageGeometries 同样读取的内容
        result.perPage.push({
          page: p,
          ok: true,
          view: view ? view.map((v) => Math.round(v)) : null,
        });
      } catch (e) {
        result.perPage.push({
          page: p,
          ok: false,
          error: e?.name || e?.constructor?.name,
          msg: String(e?.message || e).slice(0, 120),
        });
      }
    }
    await task.destroy().catch(() => {});
  } catch (e) {
    result.getDocError = e?.name || e?.constructor?.name;
    result.getDocMsg = String(e?.message || e).slice(0, 160);
    await task.destroy().catch(() => {});
  }
  return result;
}

async function run() {
  const variants = {};

  // 变体 0：干净基线
  {
    const doc = await makeBase(3);
    variants["baseline(clean)"] = await doc.save();
  }

  // 变体 1：/Count 大于实际 Kids
  {
    const doc = await makeBase(3);
    const { pagesDict } = locate(doc);
    pagesDict.set(PDFName.of("Count"), PDFNumber.of(99));
    variants["Count>Kids"] = await doc.save();
  }

  // 变体 2：把第 2 个 kid 引用替换成一个指向 PDFNumber 的新 ref（非字典对象）
  {
    const doc = await makeBase(3);
    const { kids } = locate(doc);
    const badRef = doc.context.register(PDFNumber.of(0));
    kids.set(1, badRef);
    variants["kid->PDFNumber"] = await doc.save();
  }

  // 变体 3：把第 2 个 kid 引用替换成 PDFNull
  {
    const doc = await makeBase(3);
    const { kids } = locate(doc);
    const nullRef = doc.context.register(PDFNull);
    kids.set(1, nullRef);
    variants["kid->PDFNull"] = await doc.save();
  }

  // 变体 4：把 kid 引用的底层对象替换为 PDFNumber（保留 ref 不变）
  {
    const doc = await makeBase(3);
    const { kids } = locate(doc);
    const kidRef = kids.get(1);
    doc.context.assign(kidRef, PDFNumber.of(0));
    variants["pageObj->PDFNumber"] = await doc.save();
  }

  // 变体 5：Kids 数组插入 null 引用（指向不存在对象 999 999）
  {
    const doc = await makeBase(3);
    const { kids } = locate(doc);
    const ghostRef = doc.context.register(PDFNull);
    kids.push(ghostRef); // 额外一个 ghost
    const pagesDict = doc.context.lookup(doc.catalog.get(PDFName.of("Pages")));
    pagesDict.set(PDFName.of("Count"), PDFNumber.of(4));
    variants["Kids+ghostNull"] = await doc.save();
  }

  // 变体 6：第 2 页缺失 /MediaBox
  {
    const doc = await makeBase(3);
    const { kids } = locate(doc);
    const kidRef = kids.get(1);
    const pageDict = doc.context.lookup(kidRef);
    pageDict.delete(PDFName.of("MediaBox"));
    variants["pageNoMediaBox"] = await doc.save();
  }

  // 变体 7：第 2 页缺失 /Contents
  {
    const doc = await makeBase(3);
    const { kids } = locate(doc);
    const kidRef = kids.get(1);
    const pageDict = doc.context.lookup(kidRef);
    pageDict.delete(PDFName.of("Contents"));
    variants["pageNoContents"] = await doc.save();
  }

  // 变体 8：第 2 页 /MediaBox 改为非数组（一个 Name）
  {
    const doc = await makeBase(3);
    const { kids } = locate(doc);
    const kidRef = kids.get(1);
    const pageDict = doc.context.lookup(kidRef);
    pageDict.set(PDFName.of("MediaBox"), PDFName.of("Bogus"));
    variants["MediaBox=Name"] = await doc.save();
  }

  // 变体 9：第 2 页 /Type 改为非 Page
  {
    const doc = await makeBase(3);
    const { kids } = locate(doc);
    const kidRef = kids.get(1);
    const pageDict = doc.context.lookup(kidRef);
    pageDict.set(PDFName.of("Type"), PDFName.of("XObject"));
    variants["pageType!=Page"] = await doc.save();
  }

  const rows = [];
  for (const [label, bytes] of Object.entries(variants)) {
    const r = await tryLoad(label, bytes);
    // 选择触发文件：getDocument 成功 且 至少一页 getPage 抛错 且 其余页可正常取 geometry
    const anyPageFail = r.perPage.some((p) => !p.ok);
    const trigger = r.getDocumentResolved && anyPageFail;
    rows.push({ r, trigger });
    console.log(
      `${label.padEnd(20)} | getDoc=${r.getDocumentResolved ? "OK(" + r.numPages + "p)" : "REJECT/" + (r.getDocError || "")}` +
        ` | trigger=${trigger ? "YES" : "-"}` +
        ` | pages=` +
        r.perPage.map((p) => (p.ok ? `p${p.page}✓` : `p${p.page}✗(${p.error})`)).join(","),
    );
  }

  // 保存所有变体以便浏览器侧按需载入
  const fs = await import("node:fs/promises");
  for (const [label, bytes] of Object.entries(variants)) {
    await fs.writeFile(OUT + "var_" + label.replace(/[^a-zA-Z0-9]+/g, "_") + ".pdf", bytes);
  }

  const triggers = rows.filter((x) => x.trigger).map((x) => x.r.label);
  console.log("\n触发文件候选:", triggers.length ? triggers.join(", ") : "无");

  // 若有触发生成 best-trigger.pdf
  if (triggers.length) {
    const best = triggers[0];
    const bytes = variants[best];
    await fs.writeFile(OUT + "trigger.pdf", bytes);
    console.log("已写出 trigger.pdf <-", best);
  } else {
    // 退而求其次：getDocument 接受但某页失败（即便别页也失败），仍写第一候选
    console.log("未找到理想触发文件（getDoc 成功且恰好某页失败）。");
  }
}

await run();
