import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/main.ts"],
    format: ["esm"],
    target: "node26",
    platform: "node",
    outDir: "dist",
  },
});
