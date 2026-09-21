import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig, lazyPlugins } from "vite-plus";

// https://vite.dev/config/
export default defineConfig({
  // Pages 构建使用站点子路径，本地开发和普通构建仍使用根路径。
  base: process.env.PAGES_BASE_PATH || "/",
  test: {
    fileParallelism: false,
    projects: [
      {
        test: {
          name: "geometry",
          include: ["tests/geometry/**/*.test.ts"],
          environment: "node",
          fileParallelism: false,
          retry: 0,
          testTimeout: 60_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: "acceptance",
          include: ["tests/acceptance/acceptance.test.mjs"],
          environment: "node",
          fileParallelism: false,
          retry: 0,
          testTimeout: 900_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  plugins: lazyPlugins(() => [vue(), tailwindcss()]),
});
