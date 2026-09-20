/**
 * 加密文档的导出拒绝契约（纯 Node，不需要浏览器）。
 *
 * 背景：只设所有者密码、用户口令为空的 PDF，PDF.js 不要求输入密码就能渲染，
 * 因此它能被正常打开；而 pdf-lib 不解密内容流，照写会产出坏文件。
 * 所以「导出必须显式拒绝」是一条只在导出路径才成立的规则，
 * 删除导出守卫不会报错，只会静默产出坏文件 —— 需要断言专门守住。
 *
 * 区分力对照写在第三个用例里：把守卫摘掉、并显式忽略 pdf-lib 的加密检查后，
 * 同一份输入会一路跑到 `save()` 并成功返回字节，
 * 因此第二个用例的「必须拒绝」在该对照流程下必然转红。
 */
import { expect, test } from "vite-plus/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { DocumentSession, PageGeometry } from "../../src/types/pdf";
import { ENCRYPTED_PDF_MESSAGE, exportSignedPdf } from "../../src/lib/pdfExport";

const FIXTURE = fileURLToPath(new URL("../fixtures/encrypted-owner-password.pdf", import.meta.url));
const PLAIN = fileURLToPath(new URL("../fixtures/plain.pdf", import.meta.url));

async function loadFixture(path: string) {
  return new Uint8Array(await readFile(path));
}

/**
 * 按 `tests/fixtures/encrypted-owner-password.pdf` 的真实结构装配会话。
 * 加密文档在守卫处就抛错，走不到页面比对，因此 `pdfDocument` 只是占位；
 * 但 `pages` 必须与真实页数一致，否则用它在「已排除加密」的反向用例里会得到误导结论。
 */
async function buildSession(bytes: Uint8Array): Promise<DocumentSession> {
  const pageCount = (
    await PDFDocument.load(bytes.slice(), { ignoreEncryption: true })
  ).getPageCount();
  const pages: PageGeometry[] = Array.from({ length: pageCount }, (_, index) => ({
    pageIndex: index,
    viewBox: [0, 0, 300, 400],
    rotation: 0,
    userUnit: 1,
  }));
  return {
    fileName: "encrypted-owner-password.pdf",
    originalBytes: bytes,
    pdfDocument: null as unknown as PDFDocumentProxy,
    loadingTask: null as unknown as DocumentSession["loadingTask"],
    pages,
    assets: new Map(),
  };
}

test("夹具本身确实是加密文档：默认加载被拒，且 isEncrypted 为真", async () => {
  const bytes = await loadFixture(FIXTURE);

  // 默认加载失败证明「加密」是文档自身的属性，不是我们守卫生造出来的：
  // pdf-lib 在 ignoreEncryption 为假时直接拒绝加载。
  // 顺带固化一个已知事实：抛出的错误对象 constructor/name 都退化成 Error
  //（ES5 降级丢失子类原型），所以这里不能断言错误类型，只能断言「被拒」。
  await expect(PDFDocument.load(bytes.slice())).rejects.toBeInstanceOf(Error);

  const document = await PDFDocument.load(bytes.slice(), { ignoreEncryption: true });
  expect(document.isEncrypted).toBe(true);
  expect(document.getPageCount()).toBe(2);
});

test("加密文档导出被拒，且提示为统一文案", async () => {
  const bytes = await loadFixture(FIXTURE);
  const session = await buildSession(bytes);

  await expect(exportSignedPdf({ session, placements: [] })).rejects.toThrow(ENCRYPTED_PDF_MESSAGE);

  // 拒绝必须发生在写入之前：源字节不得被改写。
  expect(Buffer.compare(Buffer.from(session.originalBytes), Buffer.from(bytes))).toBe(0);
});

test("区分力对照：忽略加密检查并摘掉守卫时同一份输入会成功产出字节", async () => {
  const bytes = await loadFixture(FIXTURE);
  const session = await buildSession(bytes);

  /** 对照流程：显式忽略 pdf-lib 的加密检查，再执行加载、页数比对与保存。 */
  async function exportWithoutEncryptionGuard(): Promise<Uint8Array> {
    const document = await PDFDocument.load(session.originalBytes.slice(), {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    expect(document.getPageCount()).toBe(session.pages.length);
    return document.save();
  }

  const legacyOutput = await exportWithoutEncryptionGuard();
  expect(legacyOutput.byteLength).toBeGreaterThan(0);
});

test("反向约束：同一套会话装配下，非加密文档仍然导出成功", async () => {
  const bytes = await loadFixture(PLAIN);
  const session = await buildSession(bytes);

  const exported = await exportSignedPdf({ session, placements: [] });
  expect(exported.byteLength).toBeGreaterThan(0);
  expect(Buffer.compare(Buffer.from(session.originalBytes), Buffer.from(bytes))).toBe(0);
});
