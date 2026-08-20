import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL("./src/browser/trace", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("./dist/browser/trace", import.meta.url)),
    emptyOutDir: true,
    target: "es2022",
  },
  resolve: {
    alias: {
      "@trace": fileURLToPath(new URL("./src/browser/trace", import.meta.url)),
    },
  },
  cacheDir: `${packageRoot}node_modules/.vite`,
});
