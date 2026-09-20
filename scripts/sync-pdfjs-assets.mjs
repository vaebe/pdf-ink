/**
 * 把 PDF.js 运行期需要的静态资源从 node_modules 同步到 public/pdfjs。
 *
 * PDF.js 需要 CMap、标准字体、WASM 和 ICC 资源才能完整解码真实文件。
 * 这些资源必须由本站点本地提供，不从未经确认的 CDN 加载。
 *
 * 用法：pnpm sync:pdfjs
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const DIRECTORIES = ["cmaps", "standard_fonts", "wasm", "iccs"];

const require = createRequire(import.meta.url);
const pdfjsEntry = require.resolve("pdfjs-dist/package.json");
const packageRoot = dirname(pdfjsEntry);
const repoRoot = join(dirname(new URL(import.meta.url).pathname), "..");
const targetRoot = join(repoRoot, "public", "pdfjs");

await rm(targetRoot, { recursive: true, force: true });
await mkdir(targetRoot, { recursive: true });

for (const directory of DIRECTORIES) {
  await cp(join(packageRoot, directory), join(targetRoot, directory), { recursive: true });
  console.log(`synced ${directory} -> public/pdfjs/${directory}`);
}

console.log("PDF.js 静态资源同步完成。");
