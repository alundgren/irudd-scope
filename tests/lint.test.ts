import { expect, test } from "vite-plus/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runLint } from "../tools/lint.ts";
import type { LintException } from "../tools/lint-report.ts";

const source = `export function reviewed(value: boolean) {
  if (value) return 1;
  return 0;
}
export const label = "fixture";
`;
const exceptions: LintException[] = [
  {
    file: "sample.ts",
    at: "export function reviewed(value: boolean) {",
    limits: { complexity: 2, "max-lines-per-function": 4 },
    reason: "Synthetic function for exercising reviewed warning limits.",
  },
  {
    file: "sample.ts",
    limits: { "max-lines": 5 },
    reason: "Synthetic file for exercising the reviewed file length.",
  },
];

async function lintFixture(cleanup: (callback: () => Promise<void>) => void) {
  // Vite+ resolves commands within the installed workspace, including this isolated config.
  const directory = await mkdtemp(join(process.cwd(), ".lint-test-"));
  cleanup(() => rm(directory, { recursive: true, force: true }));
  const configure = async (severity = "warn", typeCheck = false) =>
    writeFile(
      join(directory, "vite.config.ts"),
      `export default ${JSON.stringify({
        lint: {
          rules: {
            complexity: [severity, { max: 1 }],
            "max-lines": ["warn", { max: 4, skipBlankLines: true, skipComments: true }],
            "max-lines-per-function": [
              "warn",
              { max: 3, skipBlankLines: true, skipComments: true },
            ],
            "no-debugger": "error",
          },
          options: { typeAware: typeCheck, typeCheck },
        },
      })};`,
    );
  const write = (text: string) => writeFile(join(directory, "sample.ts"), text);
  await configure();
  await write(source);
  return {
    directory,
    configure,
    write,
    check: (entries = exceptions) => runLint(directory, entries),
  };
}

test("reviewed warnings stay quiet while new functions and increased counts remain advisory", async ({
  onTestFinished,
}) => {
  const fixture = await lintFixture(onTestFinished);
  expect(fixture.check()).toEqual({
    status: 0,
    output: "Lint: 3 reviewed advisories, 0 warnings, 0 errors.\n",
    errors: "",
  });
  await fixture.write(
    `// A comment and blank line move the function without changing its count.\n\n${source}`,
  );
  expect(fixture.check().output).toBe("Lint: 3 reviewed advisories, 0 warnings, 0 errors.\n");

  await fixture.write(source.replace("  return 0;", "  if (!value) return 2;\n  return 0;"));
  const grown = fixture.check();
  expect(grown.status).toBe(0);
  expect(grown.output).toContain("complexity of 3");
  expect(grown.output).toContain("function `reviewed` has too many lines (5)");
  expect(grown.output).toContain("File has too many lines (6)");
  expect(grown.output).toContain("0 reviewed advisories, 3 warnings, 0 errors");

  await fixture.write(
    `${source}\n${source.replaceAll("reviewed", "newFunction").replaceAll("label", "otherLabel")}`,
  );
  const added = fixture.check();
  expect(added.status).toBe(0);
  expect(added.output).toContain("function `newFunction` has a complexity of 2");
  expect(added.output).toContain("2 reviewed advisories, 3 warnings, 0 errors");
});

test("exceptions cannot hide unrelated warnings, lint errors, type errors, or parse failures", async ({
  onTestFinished,
}) => {
  const fixture = await lintFixture(onTestFinished);
  await fixture.write(`${source}\ndebugger;\nconst unusedValue = 1;\n`);
  const unrelated = fixture.check();
  expect(unrelated.status).toBe(1);
  expect(unrelated.output).toContain("eslint(no-debugger)");
  expect(unrelated.output).toContain("unusedValue");

  await fixture.write(source);
  await fixture.configure("error");
  const required = fixture.check();
  expect(required.status).toBe(1);
  expect(required.output).toContain("[error/eslint(complexity)]");

  await fixture.configure("warn", true);
  await writeFile(
    join(fixture.directory, "tsconfig.json"),
    JSON.stringify({ include: ["sample.ts"] }),
  );
  await fixture.write(`${source}\nexport const invalid: number = "text";\n`);
  const types = fixture.check();
  expect(types.status).toBe(1);
  expect(types.output).toContain("not assignable");

  await fixture.write("export function broken( {");
  const syntax = fixture.check();
  expect(syntax.status).toBe(1);
  expect(syntax.output).toContain("sample.ts");

  await writeFile(join(fixture.directory, "vite.config.ts"), "export default {");
  const configuration = fixture.check();
  expect(configuration.status).not.toBe(0);
  expect(configuration.errors).toContain("Could not read Oxlint's JSON report");
});

test("removed and ambiguous functions cannot silently reuse an exception", async ({
  onTestFinished,
}) => {
  const fixture = await lintFixture(onTestFinished);
  await fixture.write(
    source.replace("  if (value) return 1;\n  return 0;", "  return Number(value);"),
  );
  const removed = fixture.check();
  expect(removed.status).toBe(0);
  expect(removed.output.match(/Review or remove/g)).toHaveLength(3);

  await fixture.write(
    `export namespace First {\n${source}\n}\nexport namespace Second {\n${source}\n}\n`,
  );
  const ambiguous = fixture.check();
  expect(ambiguous.output.match(/function `reviewed` has a complexity of 2/g)).toHaveLength(2);
  expect(ambiguous.output).toContain("unused or ambiguous lint exception");
  expect(ambiguous.output).toContain("0 reviewed advisories");

  await fixture.write(source);
  expect(() => fixture.check([...exceptions, exceptions[0]])).toThrow("Duplicate lint exception");
  expect(() => fixture.check([{ ...exceptions[0], reason: "" }])).toThrow(
    "needs a file, limits, and a reason",
  );
  expect(() => fixture.check([{ ...exceptions[0], limits: { complexity: 0 } }])).toThrow(
    "Invalid lint exception limit",
  );
});
