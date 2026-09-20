import { expect, test } from "vite-plus/test";
import { runAcceptance } from "./run.mjs";

// 保留跨章节的共享状态；每项结果使用软断言，操作异常仍中断整个连续流程。
test("完整浏览器验收（A1—A16、B1—B6）", async () => {
  await runAcceptance(({ id, ok, detail }) => {
    expect.soft(ok, `${id}${detail ? ` — ${detail}` : ""}`).toBe(true);
  });
});
