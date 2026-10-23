import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createVitest } from "vite-plus/test/node";
import { promises } from "../tests/promises.ts";
import { frontDoorExceptions, maxTests } from "../tests/test-limits.ts";

const root = path.resolve(import.meta.dirname, "..");
const frontDoors =
  "Tests reach Scope only through the built CLI, the artifact and hub HTTP APIs, the Electron UI, and @irudd-scope/protocol.";
const specifiers = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["'`]([^"'`]+)["'`]/g,
  /\brequire\s*\(\s*["']([^"']+)["']/g,
  /\.(?:mock|doMock|importActual|importMock)\s*\(\s*["'`]([^"'`]+)["'`]/g,
];

export type CollectedTest = { file: string; name: string; line: number; tags: string[] };

export async function collectTests() {
  const vitest = await createVitest("test", {
    root,
    watch: false,
    reporters: [],
    includeTaskLocation: true,
  });
  try {
    const { testModules } = await vitest.collect();
    const tests: CollectedTest[] = [];
    const errors: string[] = [];
    for (const module of testModules) {
      const file = path.relative(root, module.moduleId);
      for (const error of module.errors()) errors.push(`${file}: ${error.message}`);
      for (const suite of module.children.allSuites())
        if (suite.options.tags?.length)
          errors.push(
            `${file}:${suite.location?.line}: suite "${suite.name}" has tags. Name the promise on each test instead.`,
          );
      for (const test of module.children.allTests())
        tests.push({ file, name: test.name, line: test.location?.line ?? 0, tags: test.tags });
    }
    return { tests, errors };
  } finally {
    await vitest.close();
  }
}

async function workspacePackages() {
  const names: string[] = [];
  for (const parent of ["apps", "packages"])
    for (const entry of await readdir(path.join(root, parent), { withFileTypes: true }))
      if (entry.isDirectory()) {
        const manifest = path.join(root, parent, entry.name, "package.json");
        const text = await readFile(manifest, "utf8").catch(() => undefined);
        if (text) names.push(JSON.parse(text).name);
      }
  return names.filter((name) => name !== "@irudd-scope/protocol");
}

function productImport(file: string, specifier: string, packages: readonly string[]) {
  if (specifier.startsWith(".")) {
    const target = path.relative(root, path.resolve(root, path.dirname(file), specifier));
    return /^(apps|packages)\//.test(target) ? target.split(path.sep).join("/") : undefined;
  }
  return packages.some((name) => specifier === name || specifier.startsWith(`${name}/`))
    ? specifier
    : undefined;
}

export async function scanTestSources() {
  const packages = await workspacePackages();
  const imports = new Map<string, string[]>();
  const moduleTags: string[] = [];
  const files = (await readdir(path.join(root, "tests"), { recursive: true }))
    .filter((name) => /\.[cm]?tsx?$/.test(name))
    .map((name) => `tests/${name.split(path.sep).join("/")}`);
  for (const file of files.sort()) {
    const source = await readFile(path.join(root, file), "utf8");
    const used = new Set<string>();
    for (const pattern of specifiers)
      for (const match of source.matchAll(pattern)) {
        const target = productImport(file, match[1]!, packages);
        if (target) used.add(target);
      }
    if (/(\/\/|\*)\s*@module-tag\b/.test(source)) moduleTags.push(file);
    if (used.size) imports.set(file, [...used].sort());
  }
  return { imports, moduleTags };
}

export function checkTests(
  tests: readonly CollectedTest[],
  { imports, moduleTags }: Awaited<ReturnType<typeof scanTestSources>>,
) {
  const failures: string[] = [];
  const known = new Set<string>(promises.map((item) => item.name));
  for (const test of tests)
    if (!test.tags.some((tag) => known.has(tag)))
      failures.push(
        `${test.file}:${test.line}: "${test.name}" names no promise. Add { tags: ["<promise>"] } with a promise from tests/promises.ts. If none fits, delete the test or propose a promise to the repository owner.`,
      );
  if (tests.length > maxTests)
    failures.push(
      `The suite has ${tests.length} tests and the limit is ${maxTests}. Delete a weaker test for each one you add. Only the repository owner raises tests/test-limits.ts.`,
    );
  const counts = Map.groupBy(tests, (test) => test.file);
  for (const file of moduleTags)
    failures.push(
      `${file}: @module-tag applies a promise to every test. Name the promise on each test instead.`,
    );
  for (const [file, used] of imports) {
    const allowed = new Set(frontDoorExceptions[file]?.imports);
    for (const target of used.filter((item) => !allowed.has(item)))
      failures.push(`${file}: imports product code from ${target}. ${frontDoors}`);
  }
  for (const [file, exception] of Object.entries(frontDoorExceptions)) {
    const used = new Set(imports.get(file));
    for (const target of exception.imports.filter((item) => !used.has(item)))
      failures.push(
        `${file}: no longer imports ${target}. Remove it from frontDoorExceptions in tests/test-limits.ts.`,
      );
    const count = counts.get(file)?.length ?? 0;
    if (count !== (exception.tests ?? 0))
      failures.push(
        `${file}: has ${count} tests, and tests/test-limits.ts records ${exception.tests ?? 0}. ` +
          (count > (exception.tests ?? 0)
            ? `Files that import product code take no new tests. ${frontDoors}`
            : "Lower the recorded count to match."),
      );
  }
  const used = new Set(tests.flatMap((test) => test.tags));
  const unused = promises.filter((item) => !used.has(item.name)).map((item) => item.name);
  return { failures, unused };
}

if (import.meta.main) {
  try {
    const [{ tests, errors }, sources] = await Promise.all([collectTests(), scanTestSources()]);
    const { failures, unused } = checkTests(tests, sources);
    failures.unshift(...errors);
    for (const failure of failures) console.error(failure);
    if (unused.length) console.log(`Promises without tests: ${unused.join(", ")}.`);
    console.log(
      `Tests: ${tests.length} of ${maxTests} allowed, ${promises.length} promises, ` +
        `${Object.keys(frontDoorExceptions).length} files still import product code, ${failures.length} failures.`,
    );
    process.exitCode = failures.length ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
