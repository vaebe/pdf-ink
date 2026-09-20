/**
 * 把验收脚本里的 BEM 选择器换成 data-testid 钩子。
 * 长的选择器必须先替换，避免被更短的前缀规则吃掉。
 */
import { readFile, writeFile } from "node:fs/promises";
import { HERE } from "../harness.mjs";
import { join } from "node:path";

const FILE = join(HERE, "acceptance.mjs");
let text = await readFile(FILE, "utf8");
const report = [];

function replace(from, to, expected) {
  const count = text.split(from).length - 1;
  if (count !== expected) {
    report.push(`!! ${from} -> ${to}：期望 ${expected} 处，实际 ${count} 处`);
    if (count === 0) return;
  } else {
    report.push(`   ${from} -> ${to}  (${count})`);
  }
  text = text.split(from).join(to);
}

// 先把 classList 用法改掉（依赖 library-item--active）
replace(
  '.evaluate((element) => element.classList.contains("library-item--active"));',
  '.evaluate((element) => element.dataset.active === "true");',
  1,
);

replace(".modal--dialog", "[data-testid=confirm-dialog]", 1);
replace(".confirm__details li", "[data-testid=confirm-details] li", 1);
replace(".confirm__actions .button", "[data-testid=confirm-actions] .button", 1);
replace(".confirm__title", "[data-testid=confirm-title]", 1);
replace(".confirm__message", "[data-testid=confirm-message]", 1);
replace(".modal .pad__canvas", "[data-testid=signature-pad-canvas]", 1);
replace(".pad__canvas", "[data-testid=signature-pad-canvas]", 1);
replace(".modal .field__input", "[data-testid=pad-name-input]", 1);
replace(".modal .message--error", "[data-testid=pad-error]", 2);
replace(
  'document.querySelectorAll(".modal button")',
  'document.querySelectorAll("[data-testid=signature-pad-dialog] button")',
  2,
);
replace('page.locator(".modal").', "page.locator('[data-testid=signature-pad-dialog]').", 3);
replace(".library-item__pick", "[data-testid=library-item-pick]", 1);
replace(".library-item__name", "[data-testid=library-item-name]", 1);
replace(".library-item__preview", "[data-testid=library-item-preview]", 1);
replace(".library-item", "[data-testid=library-item]", 7);
replace(".toolbar__filename", "[data-testid=file-name]", 5);
replace(".toolbar__page", "[data-testid=page-indicator]", 1);
replace(".toolbar__scale", "[data-testid=zoom-level]", 2);
replace(".toolbar .field__input--page", "[data-testid=page-input]", 2);
replace(".toolbar input[type=file]", "[data-testid=toolbar] input[type=file]", 4);
replace(".toolbar .button--primary", "[data-testid=toolbar] .button--primary", 1);
replace(".toolbar", "[data-testid=toolbar]", 3);
replace(".pdf-page__canvas", ".pdf-page canvas", 2);
replace(".panel--library", "[data-testid=signature-library]", 1);
replace(".banner--success", "[data-testid=banner][data-tone=success]", 1);
replace(".banner--notice", "[data-testid=banner][data-tone=notice]", 2);
replace(".banner--error", "[data-testid=banner][data-tone=error]", 3);
replace(".pdf-viewer", "[data-testid=pdf-scroller]", 2);
replace(".signature-frame__delete", "[data-testid=placement-delete]", 1);
replace(".signature-handle", "[data-testid=placement-handle]", 1);
replace(".signature-item", "[data-testid=placement]", 3);

await writeFile(FILE, text);
console.log(report.join("\n"));

const leftovers = [
  ".toolbar__",
  ".toolbar ",
  ".library-item",
  ".modal",
  ".confirm__",
  ".banner--",
  ".pdf-viewer",
  ".signature-item",
  ".signature-handle",
  ".signature-frame",
  ".pad__canvas",
  ".panel--",
  ".pdf-page__",
].filter((token) => text.includes(token));
console.log("\n残留旧选择器：", leftovers.length ? leftovers : "无");
