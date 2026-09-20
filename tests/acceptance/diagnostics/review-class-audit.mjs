// 审查用：只解析真正的 class 属性与 @apply，核对产物是否生成了每个类。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness.mjs";

const ROOT = REPO_ROOT;
const DIST = join(ROOT, "dist/assets");

const cssFile = readdirSync(DIST)
  .filter((name) => name.endsWith(".css"))
  .map((name) => ({ name, mtime: statSync(join(DIST, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)[0].name;
const css = readFileSync(join(DIST, cssFile), "utf8");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(vue|ts)$/.test(entry)) out.push(full);
  }
  return out;
}
const files = [...walk(join(ROOT, "src")), join(ROOT, "index.html")];

const candidates = new Map();
function add(token, file) {
  const clean = token.trim();
  if (!clean) return;
  if (!/^-?[a-zA-Z][\w:[\]/.%(),#&-]*$/.test(clean)) return;
  if (clean.endsWith(":")) return; // 变体残片
  if (!candidates.has(clean)) candidates.set(clean, new Set());
  candidates.get(clean).add(file.replace(`${ROOT}/`, ""));
}

for (const file of files) {
  const source = readFileSync(file, "utf8");
  // 静态 class="..."
  for (const match of source.matchAll(/(?<![:\w-])class="([^"]*)"/g)) {
    for (const token of match[1].split(/\s+/)) add(token, file);
  }
  // 动态 :class="..." —— 只取里面的字符串字面量
  for (const match of source.matchAll(/:class="([^"]*)"/g)) {
    for (const literal of match[1].matchAll(/'([^']*)'|"([^"]*)"/g)) {
      for (const token of (literal[1] ?? literal[2] ?? "").split(/\s+/)) add(token, file);
    }
  }
  // @apply 组合的工具类
  for (const match of source.matchAll(/@apply\s+([^;]+);/g)) {
    for (const token of match[1].split(/\s+/)) add(token, file);
  }
}

const emitted = new Set();
for (const match of css.matchAll(/\.((?:\\.|[^\s,{>~:+[)])+)/g)) {
  emitted.add(match[1].replace(/\\/g, ""));
}

const missing = [...candidates]
  .filter(([token]) => !emitted.has(token))
  .map(([token, from]) => ({ token, from: [...from] }));

console.log(`产物: ${cssFile}`);
console.log(`候选类: ${candidates.size} / 产物类: ${emitted.size} / 未命中: ${missing.length}`);
for (const item of missing.sort((a, b) => a.token.localeCompare(b.token))) {
  console.log(`  MISS ${item.token}  <- ${item.from.join(", ")}`);
}
