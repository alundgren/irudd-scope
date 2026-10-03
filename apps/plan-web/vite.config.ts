import { defineConfig } from "vite-plus";

export default defineConfig({
  build: { outDir: "dist/client" },
  optimizeDeps: { exclude: ["@electric-sql/pglite"] },
  worker: { format: "es" },
  pack: [
    {
      entry: ["src/server-main.ts"],
      format: ["esm"],
      platform: "node",
      target: "node26",
      outDir: "dist/server",
      deps: { alwaysBundle: ["effect", "effect/**"] },
    },
    {
      entry: ["src/cli/main.ts"],
      format: ["esm"],
      platform: "node",
      target: "node26",
      outDir: "dist/cli",
      deps: { alwaysBundle: [/.*/], onlyBundle: false },
    },
  ],
});
