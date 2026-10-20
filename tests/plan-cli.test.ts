import { expect, test } from "vite-plus/test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";

const executable = resolve("packages/cli/dist/main.mjs");
const exec = promisify(execFile);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope-plan-cli-"));
  const token = "synthetic-plan-cli-token";
  const server = await startArtifactServer({ directory, token, port: 0 });
  const env = {
    ...process.env,
    SCOPE_ENDPOINT: server.url,
    SCOPE_TOKEN: token,
    SCOPE_TOKEN_FILE: undefined,
    SCOPE_CONNECTION_FILE: undefined,
  };
  const cli = async (...args: string[]) =>
    JSON.parse((await exec(process.execPath, [executable, ...args], { env })).stdout);
  const html = join(directory, "plan.html");
  await writeFile(html, "<h1 id='goal'>Build a feature</h1>");
  return {
    directory,
    server,
    cli,
    html,
    close: async () => {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("built plan CLI publishes a plan, updates it, and saves only the current HTML", async () => {
  const f = await fixture();
  try {
    const first = await f.cli("add", f.html, "--plan", "--name", "cli-plan");
    expect(first).toMatchObject({ name: "cli-plan", kind: "plan", mediaType: "text/html" });
    expect((await f.server.store.tabs())[0].permanent).toBe(1);
    await writeFile(f.html, "<h1 id='goal'>Build the revised feature</h1>");
    const second = await f.cli("update", "cli-plan", f.html);
    expect(second).toMatchObject({ id: first.id, name: "cli-plan", kind: "plan" });
    const output = join(f.directory, "current.html");
    expect(await f.cli("plan", "content", "cli-plan", "--output", output)).toEqual({
      name: "cli-plan",
      title: first.title,
      output,
    });
    expect(await readFile(output, "utf8")).toBe("<h1 id='goal'>Build the revised feature</h1>");
    await expect(f.cli("plan", "content", "cli-plan", "--output", output)).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe("<h1 id='goal'>Build the revised feature</h1>");
  } finally {
    await f.close();
  }
});
