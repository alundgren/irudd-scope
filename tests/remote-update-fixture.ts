import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:http";
import { HubState } from "../apps/hub/src/state.ts";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { memoryCredentials } from "../apps/desktop/src/credentials.ts";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";
import { Remotes } from "../apps/desktop/src/remotes.ts";
import { decodeLocalConnection } from "@irudd-scope/protocol";
import { expect } from "vite-plus/test";

const exec = promisify(execFile);
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill();
  await closed;
}

export async function remoteUpdateFixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope-remote-update-"));
  const upstream = join(directory, "upstream");
  const root = join(directory, "installation");
  const bin = join(directory, "bin");
  const data = join(directory, "hub");
  await mkdir(upstream);
  await mkdir(root);
  await mkdir(bin);
  for (const path of [
    "tools/package-cli.ts",
    "install-cli.sh",
    "LICENSE",
    "pnpm-workspace.yaml",
    ".agents/skills/irudd-scope",
    "packages/cli/dist",
    "apps/hub/dist",
  ]) {
    await mkdir(dirname(join(upstream, path)), { recursive: true });
    await cp(resolve(path), join(upstream, path), { recursive: true });
  }
  const git = (args: string[], cwd = upstream) => exec("git", args, { cwd });
  await git(["init", "--initial-branch=main"]);
  await git(["config", "user.name", "Scope test"]);
  await git(["config", "user.email", "scope@example.invalid"]);
  async function commitSkill(label: string) {
    await writeFile(join(upstream, ".agents/skills/irudd-scope/SKILL.md"), label);
    await git(["add", "."]);
    await git(["commit", "-m", `test: ${label}`]);
    return (await git(["rev-parse", "HEAD"])).stdout.trim();
  }
  const initialCommit = await commitSkill("Initial publishing skill");
  await git(["clone", upstream, join(root, "source")]);
  const realGit = (await exec("which", ["git"])).stdout.trim();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    SCOPE_CLI_INSTALL_ROOT: root,
    SCOPE_CLI_BIN_DIR: bin,
    SCOPE_CLI_SOURCE: undefined,
    SCOPE_VP: join(bin, "vp"),
    SCOPE_HUB_DATA_DIR: data,
    SCOPE_CONNECTION_FILE: join(directory, "connection.json"),
    SCOPE_SETUP_HOME: join(directory, "user"),
    SCOPE_ENDPOINT: undefined,
    SCOPE_TOKEN: undefined,
    SCOPE_TOKEN_FILE: undefined,
  };
  const mock = (name: string, source: string) =>
    writeFile(join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  // Git uses a real local repository. Only the remote URL check stands in for GitHub.
  await mock(
    "git",
    `
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('get-url')) console.log('https://github.com/alundgren/irudd-scope.git');
else {const result=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(result.status ?? 1);}
`,
  );
  await mock(
    "vp",
    `
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
if (fs.existsSync(${JSON.stringify(join(directory, "fail-build"))})) {console.error('Synthetic build failure');process.exit(1);}
while (fs.existsSync(${JSON.stringify(join(directory, "hold-build"))})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
if (args[0] === 'exec') {
  const result=spawnSync(${JSON.stringify(process.execPath)},args.slice(2),{stdio:'inherit'});
  process.exit(result.status ?? 1);
}
`,
  );
  let hub: ChildProcess | undefined;
  let worker: ChildProcess | undefined;
  let launches = 0;
  let diagnostics = "";
  function capture(child: ChildProcess) {
    child.stdout?.on("data", (chunk: Buffer) => (diagnostics += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (diagnostics += chunk.toString()));
    child.on("error", (error) => (diagnostics += String(error)));
    return child;
  }
  async function startHub() {
    await stop(hub);
    hub = capture(spawn(join(root, "current/bin/irudd-scope-hub"), [], { env }));
    await once(hub, "spawn");
  }
  const services = createServer(async (request, response) => {
    try {
      const { command, args } = JSON.parse(decodeURIComponent(request.url!.slice(1))) as {
        command: string;
        args: string[];
      };
      if (command === "systemd-run") {
        if (worker && worker.exitCode === null) throw new Error("Updater is already running");
        const commandIndex = args.findIndex((arg) => !arg.startsWith("--"));
        const jobEnv = { ...env };
        for (const arg of args.filter((arg) => arg.startsWith("--setenv="))) {
          const separator = arg.indexOf("=", 9);
          jobEnv[arg.slice(9, separator)] = arg.slice(separator + 1);
        }
        worker = capture(spawn(args[commandIndex], args.slice(commandIndex + 1), { env: jobEnv }));
        launches++;
        await once(worker, "spawn");
      } else if (args.includes("is-active")) {
        if (!worker || worker.exitCode !== null || worker.signalCode !== null) {
          response.writeHead(503).end();
          return;
        }
      } else if (args.includes("show")) {
        const unmanaged = await readFile(join(directory, "unmanaged-service"), "utf8").catch(
          () => "",
        );
        response.end(unmanaged || String(hub?.pid ?? 0));
        return;
      } else if (args.includes("restart")) await startHub();
      response.end();
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  services.listen(0, "127.0.0.1");
  await once(services, "listening");
  const servicePort = (services.address() as { port: number }).port;
  for (const command of ["systemctl", "systemd-run"])
    await mock(
      command,
      `
fetch('http://127.0.0.1:${servicePort}/'+encodeURIComponent(JSON.stringify({command:${JSON.stringify(command)},args:process.argv.slice(2)})))
.then(async response=>{if(!response.ok)process.exitCode=1;else process.stdout.write(await response.text());}).catch(()=>{process.exitCode=1;});
`,
    );
  const state = await HubState.open(data);
  const local = await startArtifactServer({
    directory: join(directory, "artifacts"),
    port: 0,
    token: "synthetic-local-publishing-token",
  });
  const publication = { url: local.url, token: "synthetic-local-publishing-token" };
  const store = new DesktopStore(join(directory, "desktop"), memoryCredentials());
  await store.load();
  let remotes = new Remotes(store, publication, () => {}, initialCommit);
  async function close() {
    await remotes.close();
    await rm(join(directory, "hold-build"), { force: true });
    await stop(worker);
    await stop(hub);
    await new Promise<void>((done) => services.close(() => done()));
    await local.close();
    await store.close();
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
  try {
    await exec("bash", [resolve("install-cli.sh")], { env, timeout: 60_000 });
    const portServer = createServer();
    portServer.listen(0, "127.0.0.1");
    await once(portServer, "listening");
    const port = (portServer.address() as { port: number }).port;
    await new Promise<void>((done) => portServer.close(() => done()));
    const endpoint = `http://127.0.0.1:${port}`;
    await state.configure({ endpoint, port, connectionFile: env.SCOPE_CONNECTION_FILE! });
    const cli = (...args: string[]) =>
      exec(join(bin, "irudd-scope"), args, { env, timeout: 30_000 });
    await cli("skill", "install");
    await startHub();
    await expect
      .poll(
        async () =>
          cli("hub", "status").then(
            () => true,
            () => false,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    await remotes.start();
    await remotes.pair(state.pairUrl());
    await expect
      .poll(() => remotes.snapshot()[0]?.update?.currentCommit, { timeout: 15_000 })
      .toBe(initialCommit);
    const remoteId = remotes.snapshot()[0].id;
    const token = (await store.remoteToken(remoteId))!;
    const connection = decodeLocalConnection(
      JSON.parse(await readFile(env.SCOPE_CONNECTION_FILE!, "utf8")),
    );
    return {
      directory,
      upstream,
      root,
      initialCommit,
      state,
      cli,
      commitSkill,
      close,
      endpoint,
      token,
      localToken: connection.token,
      launches: () => launches,
      diagnostics: () => diagnostics,
      status: () => remotes.snapshot()[0],
      retry: () => remotes.retryUpdate(remoteId),
      enable: (enabled: boolean) => remotes.setEnabled(remoteId, enabled),
      async openMac(commit: string | undefined) {
        await remotes.close();
        remotes = new Remotes(store, publication, () => {}, commit);
        await remotes.start();
      },
    };
  } catch (error) {
    console.error(diagnostics);
    await close();
    throw error;
  }
}
