import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/main.ts", "src/update-runner.ts"],
    format: ["esm"],
    target: "node26",
    platform: "node",
    outDir: "dist",
    outExtensions: () => ({ js: ".mjs" }),
    deps: {
      alwaysBundle: [
        "@irudd-scope/sqlite",
        "@irudd-scope/protocol",
        "@irudd-scope/protocol/**",
        "effect",
        "effect/**",
      ],
    },
  },
});
