import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/main.ts"],
    format: ["esm"],
    target: "node24",
    platform: "node",
    outDir: "dist",
    outExtensions: () => ({ js: ".mjs" }),
    deps: {
      alwaysBundle: ["@irudd-scope/protocol", "@irudd-scope/protocol/**", "effect", "effect/**"],
    },
  },
});
