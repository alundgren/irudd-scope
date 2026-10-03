import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vite-plus/test";
import { chromium, type Browser } from "@playwright/test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { startPlanWebServer } from "../apps/plan-web/src/backend/server.ts";

let installed: string;
let directory: string;
let browser: Browser;
let server: Awaited<ReturnType<typeof startPlanWebServer>>;
let children: ChildProcess[] = [];
let executable: string;
const packagePath = resolve("apps/plan-web/dist/plan-web-cli-0.1.0.tgz");
async function command(
  program: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const child = spawn(program, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (bytes: Buffer) => {
    stdout += bytes.toString();
  });
  child.stderr.on("data", (bytes: Buffer) => {
    stderr += bytes.toString();
  });
  const [code] = (await once(child, "exit")) as [number];
  return { code, stdout, stderr };
}
beforeAll(async () => {
  installed = await mkdtemp(join(tmpdir(), "plan-cli-installed-"));
  await writeFile(
    join(installed, "package.json"),
    JSON.stringify({
      name: "plan-cli-install-test",
      private: true,
      version: "1.0.0",
      type: "module",
      packageManager: "pnpm@12.6.0",
    }),
  );
  const install = await command(
    "vp",
    ["install", packagePath, "--ignore-scripts", "--no-lockfile"],
    installed,
  );
  expect(install.code, install.stderr).toBe(0);
  executable = join(installed, "node_modules", ".bin", "plan-web");
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
}, 30_000);
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "plan-cli-test-"));
  server = await startPlanWebServer({ databasePath: join(directory, "plans.sqlite") });
  children = [];
});
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  }
  await server.close();
  await rm(directory, { recursive: true, force: true });
});
afterAll(async () => {
  await browser?.close();
  await rm(installed, { recursive: true, force: true });
});
function environment() {
  return {
    ...process.env,
    PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
    PLAN_WEB_CLI_HOME: join(directory, "private-cli"),
  };
}
function cli(args: string[], defaults = false) {
  return command(
    executable,
    [...args, ...(defaults ? [] : ["--server", server.url])],
    directory,
    environment(),
  );
}
async function login(identity = "Alex", action = "Approve agent", defaults = false) {
  const child = spawn(
    executable,
    [
      "login",
      ...(defaults ? [] : ["--server", server.url]),
      "--agent",
      "Installed test agent",
      "--no-browser",
    ],
    { cwd: directory, env: environment(), stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (value: Buffer) => {
    stderr += value.toString();
  });
  const lines = createInterface({ input: child.stdout });
  const uri = await new Promise<string>((resolveUri, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`CLI did not display approval URL: ${stderr}`)),
      10_000,
    );
    lines.on("line", (line) => {
      if (line.startsWith("http")) {
        clearTimeout(timer);
        resolveUri(line);
      }
    });
  });
  const page = await browser.newPage();
  await page.goto(uri);
  await page.getByRole("radio", { name: identity, exact: true }).check();
  const submitted = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url() === uri,
  );
  await page.getByRole("button", { name: action, exact: true }).click();
  const approval = await submitted;
  expect(approval.status(), await approval.text()).toBe(200);
  await expect
    .poll(() => page.locator("h1").textContent())
    .toContain(action === "Approve agent" ? "approved" : "denied");
  await page.close();
  const [code] = (await exited) as [number];
  lines.close();
  return { code, stderr, uri };
}
test("installs with vp, approves all fake identities in the browser, protects credentials, and revokes", async () => {
  expect((await cli(["--help"])).stdout).toContain("plan-web login");
  expect((await cli(["whoami"])).code).toBe(1);
  for (const identity of ["Alex", "Blair", "Casey"]) {
    const signed = await login(identity);
    expect(signed.code, signed.stderr).toBe(0);
    const who = await cli(["whoami"]);
    expect(who.code, who.stderr).toBe(0);
    expect(JSON.parse(who.stdout)).toMatchObject({
      actor: {
        id: `fake-user-${identity.toLowerCase()}`,
        kind: "agent",
        name: `${identity} / Installed test agent`,
      },
      endpoint: `${server.url}/mcp`,
    });
    const file = await stat(join(directory, "private-cli", "credentials.sqlite"));
    expect(file.mode & 0o777).toBe(0o600);
    const configuration = await cli(["mcp-config"]);
    expect(JSON.parse(configuration.stdout)).toMatchObject({
      mcpServers: {
        "plan-web": { args: expect.arrayContaining(["mcp", "--server", `${server.url}/mcp`]) },
      },
    });
    const tools = await cli(["tools"]);
    expect(tools.code, tools.stderr).toBe(0);
    expect(JSON.parse(tools.stdout).tools).toHaveLength(8);
    expect((await cli(["logout"])).code).toBe(0);
    expect((await cli(["whoami"])).code).toBe(1);
  }
}, 30_000);
test("browser denial returns a readable error and does not save a credential", async () => {
  const signed = await login("Casey", "Deny");
  expect(signed.code).toBe(1);
  expect(signed.stderr).toContain("denied or cancelled");
  expect((await cli(["whoami"])).code).toBe(1);
});
test("installed stdio bridge serves legacy clients while sending stateless HTTP tools", async () => {
  const signed = await login("Blair");
  expect(signed.code, signed.stderr).toBe(0);
  const child = spawn(executable, ["mcp", "--server", server.url], {
    cwd: directory,
    env: environment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const lines = createInterface({ input: child.stdout });
  const queue = new Map<number, (value: Record<string, unknown>) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    queue.get(Number(message.id))?.(message);
  });
  function send(id: number, method: string, params: unknown) {
    return new Promise<Record<string, unknown>>((resolveMessage, reject) => {
      const timer = setTimeout(() => reject(new Error(`No stdio response for ${method}.`)), 10_000);
      queue.set(id, (value) => {
        clearTimeout(timer);
        queue.delete(id);
        resolveMessage(value);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  const initialized = await send(1, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "legacy-test", version: "1" },
  });
  expect(initialized.error).toBeUndefined();
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const tools = await send(2, "tools/list", {});
  expect(tools.error).toBeUndefined();
  expect(tools.result).toMatchObject({ tools: expect.any(Array) });
  const read = await send(3, "tools/call", {
    name: "plan_read",
    arguments: { name: "bridge-plan" },
  });
  expect(read.error).toBeUndefined();
  const result = read.result as { content: { text: string }[] };
  expect(JSON.parse(result.content[0].text)).toMatchObject({ name: "bridge-plan", revision: 1 });
  const snapshot = JSON.parse(result.content[0].text) as { html: string; htmlRevision: number };
  const write = await send(4, "tools/call", {
    name: "plan_apply_html",
    arguments: {
      name: "bridge-plan",
      requestId: "installed-command",
      baseHtmlRevision: snapshot.htmlRevision,
      html: snapshot.html.replace("Start planning together.", "Installed bridge changed the plan."),
    },
  });
  expect(write.error).toBeUndefined();
  const accepted = (await (await fetch(`${server.url}/api/plans/bridge-plan`)).json()) as {
    html: string;
  };
  expect(accepted.html).toContain("Installed bridge changed the plan.");
  lines.close();
}, 20_000);

test("default installed CLI origin matches the app listener without a server override", async () => {
  await server.close();
  server = await startPlanWebServer({
    databasePath: join(directory, "default-plans.sqlite"),
    port: 43130,
  });
  const approved = await login("Blair", "Approve agent", true);
  expect(approved.code, approved.stderr).toBe(0);
  expect(approved.uri).toContain("http://127.0.0.1:43130/auth/");
  const who = await cli(["whoami"], true);
  expect(who.code, who.stderr).toBe(0);
  expect(JSON.parse(who.stdout).actor.name).toBe("Blair / Installed test agent");
  const config = await cli(["mcp-config"], true);
  expect(config.code).toBe(0);
  expect(config.stdout).toContain("http://127.0.0.1:43130/mcp");
  expect((await cli(["logout"], true)).code).toBe(0);
}, 30_000);
