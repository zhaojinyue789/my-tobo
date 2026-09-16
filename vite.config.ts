import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// base 用相对路径 + 单文件内联，dist/index.html 可直接双击（file:// 协议）离线使用
export default defineConfig({
  base: "./",
  plugins: [viteSingleFile()],
});
