import { defineConfig } from "vite-plus";
import { readdirSync } from "node:fs";

const plugins = readdirSync(new URL("./apps/desktop/src/plugins/", import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

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
    include: ["tests/**/*.test.ts"],
    maxWorkers: 1,
    testTimeout: 30_000,
    reporters: ["minimal"],
  },
  run: { cache: false },
});
