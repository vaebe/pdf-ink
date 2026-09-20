/**
 * tests/acceptance 的共享配置。
 *
 * 全部脚本从这里取与环境相关的值，脚本内不写机器路径：
 * - 应用地址、夹具目录、产物目录、Python 解释器都可用环境变量覆盖
 * - Chromium 默认交给 Playwright 自己解析；本机浏览器与 Playwright 期望的修订号不一致时，
 *   用 `CHROMIUM_PATH` 指到现成的 Chrome for Testing 可执行文件
 *
 * 环境变量：
 *   PDFINK_APP      被测应用地址（默认 http://localhost:5199/）
 *   PDFINK_PYTHON   Python 解释器（默认 python3）
 *   CHROMIUM_PATH   Chromium 可执行文件（默认留空，由 Playwright 解析）
 *   PDFINK_OUT      产物根目录（默认在仓库外的临时目录，见下方说明）
 */
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

/** tests/acceptance 的绝对路径。 */
export const HERE = resolve(dirname(fileURLToPath(import.meta.url)));
/** 仓库根目录。 */
export const REPO_ROOT = resolve(HERE, "..", "..");
/** 夹具 PDF 与生成脚本所在目录。 */
export const FIX = join(HERE, "fixtures");

/**
 * 产物根目录（截图、导出 PDF、报告）。
 *
 * **默认刻意落在仓库之外**：`vp dev` 对项目根目录下任何文件的写入都会触发整页重载
 * （实测 `docs/*.md`、根 `README.md` 都算，只有 `.workbuddy/` 这类点目录被忽略）。
 * 整页重载会冲掉用例在页面里打的补丁（例如 A2-2 的 `IDBObjectStore.prototype.put`），
 * 表现为某个断言莫名失败外加 30 秒点击超时，极易误判为产品缺陷。
 * 所以产物一旦写进仓库，就等于给套件埋了一颗只在特定用例才响的炸弹。
 *
 * 需要保留产物时用 `PDFINK_OUT=/some/abs/path` 覆盖；不要指到仓库内。
 */
export const OUT_BASE = process.env.PDFINK_OUT ?? join(tmpdir(), "pdf-ink-acceptance");
/** 主套件与多数探针的产物目录。 */
export const OUT_ROOT = join(OUT_BASE, "out");
/** Tailwind 迁移核对脚本的产物目录。 */
export const OUT_TW = join(OUT_BASE, "out-tw");
/** p3-control 运行时备份目录（它要改写 src/ 再还原，备份不能留在仓库里）。 */
export const CONTROL_BACKUP = join(OUT_BASE, "p3-fixed-backup");
/** pypdf / PDFium 独立核对脚本所在目录。 */
export const PY_DIR = join(HERE, "python");

/** 被测应用地址。 */
export const APP = process.env.PDFINK_APP ?? "http://localhost:5199/";
/** APP 的 host 部分；A12 的网络审计断言用它判断请求是否留在本站点。 */
export const APP_HOST = new URL(APP).host;

/** Python 解释器。 */
export const PY = process.env.PDFINK_PYTHON ?? "python3";

/** 显式指定的 Chromium；空字符串表示交给 Playwright 解析。 */
export const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? "";

export { chromium };

/** 统一的浏览器启动参数：只在显式指定时才带 executablePath。 */
export function launchOptions(extra = {}) {
  return {
    headless: true,
    ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
    ...extra,
  };
}
