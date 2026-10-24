import { defineConfig } from "vite-plus";
import { readdirSync } from "node:fs";
import { promises } from "./tests/promises.ts";

const plugins = readdirSync(new URL("./apps/desktop/src/plugins/", import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const remoteUpdateTests = ["tests/remote-updates*.test.ts"];

export default defineConfig({
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      complexity: ["warn", { max: 10 }],
      "max-lines": ["warn", { max: 500, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["warn", { max: 150, skipBlankLines: true, skipComments: true }],
    },
    options: { typeAware: true, typeCheck: true, denyWarnings: false },
    overrides: plugins.map((plugin) => ({
      files: [`apps/desktop/src/plugins/${plugin}/**`],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: [
                  "../registry*",
                  "**/plugins/registry*",
                  ...plugins
                    .filter((other) => other !== plugin)
                    .flatMap((other) => [`../${other}/**`, `**/plugins/${other}/**`]),
                ],
                message:
                  "Use the shared plugin API or an event contract; plugin implementations are independent.",
              },
            ],
          },
        ],
      },
    })),
  },
  test: {
    // Native macOS fullscreen windows share one display and compete for focus.
    maxWorkers: process.platform === "darwin" ? 1 : 2,
    testTimeout: 30_000,
    reporters: ["minimal"],
    tags: promises.map(({ name, description }) => ({ name, description })),
    // Project inheritance combines include lists, so each project defines its own.
    projects: [
      {
        extends: true,
        test: {
          name: "standard",
          include: ["tests/**/*.test.ts"],
          exclude: remoteUpdateTests,
        },
      },
      { extends: true, test: { name: "remote-updates", include: remoteUpdateTests } },
    ],
  },
  run: { cache: false },
});
