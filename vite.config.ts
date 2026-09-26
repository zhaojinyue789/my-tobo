import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// dist/sw.js 的缓存版本号占位符在构建收尾替换为构建号：
// 每次发版 SW 缓存名必变，旧缓存自动清空，不用手动 bump CACHE_NAME
function swBuildId(): Plugin {
  return {
    name: "sw-build-id",
    apply: "build",
    closeBundle() {
      const path = resolve(import.meta.dirname, "dist/sw.js");
      const src = readFileSync(path, "utf8");
      writeFileSync(path, src.replace("__BUILD_ID__", Date.now().toString(36)));
    },
  };
}

// base 用相对路径 + 单文件内联，dist/index.html 可直接双击（file:// 协议）离线使用
export default defineConfig({
  base: "./",
  plugins: [viteSingleFile(), swBuildId()],
});
