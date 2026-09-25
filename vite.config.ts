import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// 版本号单一真源 = package.json 的 version（各仓语义化版本，口径见 VERSIONS.md）
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8790",
    },
  },
  build: {
    outDir: "dist",
  },
});
