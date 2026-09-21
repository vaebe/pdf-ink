import { execFileSync } from "node:child_process";

// 比较共同祖先到 HEAD 的已提交改动；基准由本地调用者或 PR 工作流明确传入。
const base = process.argv[2];
if (!base) {
  console.error("用法：vp run review:diff <基准分支或提交>（例如 origin/main）");
  process.exit(1);
}

try {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  process.chdir(root);
  const ancestor = execFileSync("git", ["merge-base", "HEAD", base], {
    encoding: "utf8",
  }).trim();
  const range = `${ancestor}..HEAD`;

  execFileSync("git", ["diff", "--check", range, "--"], { stdio: "inherit" });
  const files = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", "-z", range, "--"],
    { encoding: "utf8" },
  )
    .split("\0")
    // 删除文件只参与差异检查；PDF 等二进制资源不交给格式和 Lint 工具。
    .filter((file) => /\.(?:[cm]?[jt]sx?|vue|jsonc?|ya?ml|md|html|css|scss)$/i.test(file))
    .map((file) => `./${file}`);

  if (files.length === 0) {
    console.log("差异空白检查通过；没有需要格式 / Lint 检查的变更文件。");
  } else {
    console.log(`检查 ${files.length} 个变更文件（基准 ${ancestor}）。`);
    // 纯文档或配置 PR 仍检查格式，允许没有可供 Lint 分析的源文件。
    execFileSync("vp", ["check", "--no-error-on-unmatched-pattern", ...files], {
      stdio: "inherit",
    });
  }
} catch (error) {
  console.error("PR 差异检查失败：", error.message);
  process.exit(error.status || 1);
}
