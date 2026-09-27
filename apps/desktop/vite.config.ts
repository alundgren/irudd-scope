import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { resolve } from "node:path";
import { cp } from "node:fs/promises";

const directory = import.meta.dirname;
export default defineConfig({
  logLevel: "warn",
  root: resolve(directory, "src/renderer"),
  base: "./",
  plugins: [
    react(),
    tailwind(),
    {
      name: "local-excalidraw-fonts",
      closeBundle: async () => {
        await cp(
          resolve(directory, "node_modules/@excalidraw/excalidraw/dist/prod/fonts"),
          resolve(directory, "dist/renderer/fonts"),
          { recursive: true },
        );
      },
    },
  ],
  resolve: { alias: { "@": resolve(directory, "src/renderer") } },
  build: {
    outDir: resolve(directory, "dist/renderer"),
    emptyOutDir: true,
    target: "chrome152",
    chunkSizeWarningLimit: 5000,
  },
  pack: [
    {
      entry: { main: "src/main.ts" },
      outDir: "dist",
      clean: false,
      format: "esm",
      target: "node24",
      platform: "node",
      deps: { neverBundle: ["electron", "@napi-rs/keyring"] },
      outExtensions: () => ({ js: ".mjs" }),
    },
    {
      entry: { preload: "src/preload.ts" },
      outDir: "dist",
      clean: false,
      format: "cjs",
      target: "node24",
      platform: "node",
      deps: { neverBundle: ["electron"] },
      outExtensions: () => ({ js: ".cjs" }),
    },
  ],
});
