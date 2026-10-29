import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [vue()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 18451, proxy: { "/api": "http://127.0.0.1:18450" } },
});
