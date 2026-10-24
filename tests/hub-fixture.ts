import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const hubMain = resolve("apps/hub/dist/main.mjs");
export const cliMain = resolve("packages/cli/dist/main.mjs");

async function freePort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  await new Promise((done) => server.close(done));
  return port;
}

/** A hub from the built executable, as a remote installs it. */
export async function spawnedHub(directory: string) {
  const port = await freePort();
  const env = {
    ...process.env,
    SCOPE_HUB_DATA_DIR: join(directory, "data"),
    SCOPE_CONNECTION_FILE: join(directory, "connection.json"),
    SCOPE_ENDPOINT: undefined,
    SCOPE_TOKEN: undefined,
    SCOPE_TOKEN_FILE: undefined,
  };
  const endpoint = `http://127.0.0.1:${port}`;
  await exec(
    process.execPath,
    [hubMain, "configure", "--endpoint", endpoint, "--port", String(port)],
    { env },
  );
  const info = JSON.parse((await exec(process.execPath, [hubMain, "info"], { env })).stdout);
  let child: ChildProcess | undefined;
  const start = async () => {
    child = spawn(process.execPath, [hubMain, "run"], { env, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((done, fail) => {
      child!.stdout!.on("data", (data: Buffer) => {
        if (data.toString().includes("Scope hub listening")) done();
      });
      child!.once("exit", () => fail(new Error("The hub exited during startup.")));
    });
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((done) => child!.once("exit", done));
    child.kill("SIGTERM");
    await exited;
  };
  const cli = async (...args: string[]) =>
    (await exec(process.execPath, [cliMain, ...args], { env, timeout: 15_000 })).stdout;
  const token = JSON.parse(await readFile(env.SCOPE_CONNECTION_FILE, "utf8")).token as string;
  await start();
  const pairUrl = /irudd-scope:\/\/pair\S+/.exec(await cli("pair"))![0];
  return { id: info.id as string, endpoint, token, pairUrl, env, start, stop, cli };
}
