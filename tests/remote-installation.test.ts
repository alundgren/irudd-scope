import { expect, test } from "vite-plus/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

const exec = promisify(execFile);

test("the standalone installer and CLI setup preserve existing Serve routes and can revoke and remove the hub", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-remote-install-"));
  const root = join(directory, "installation");
  const bin = join(directory, "bin");
  const userDirectory = join(directory, "user");
  const pidFile = join(directory, "hub.pid");
  const hubLog = join(directory, "hub.log");
  const serveFile = join(directory, "serve.json");
  const local = createServer();
  await new Promise<void>((done) => local.listen(0, "127.0.0.1", done));
  const port = (local.address() as { port: number }).port;
  await new Promise<void>((done) => local.close(() => done()));
  const existingServe = {
    TCP: { "443": { HTTPS: true } },
    Web: {
      "worker.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:12345" } } },
    },
  };
  await mkdir(bin);
  await writeFile(serveFile, JSON.stringify(existingServe));
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    SCOPE_CLI_INSTALL_ROOT: root,
    SCOPE_CLI_BIN_DIR: bin,
    SCOPE_CLI_SOURCE: resolve("."),
    SCOPE_VP: join(bin, "vp"),
    SCOPE_SETUP_HOME: userDirectory,
    SCOPE_HUB_DATA_DIR: join(directory, "hub"),
    SCOPE_CONNECTION_FILE: join(directory, "connection.json"),
    SCOPE_ENDPOINT: undefined,
    SCOPE_TOKEN: undefined,
    SCOPE_TOKEN_FILE: undefined,
  };
  const mock = async (name: string, source: string) =>
    writeFile(join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  await mock(
    "vp",
    `const {execFileSync} = require('node:child_process'); const args = process.argv.slice(2); if(args[0] === 'exec') execFileSync(${JSON.stringify(process.execPath)}, args.slice(2), {stdio:'inherit', env:process.env});`,
  );
  await mock("loginctl", "console.log('yes');");
  await mock(
    "tailscale",
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = ${JSON.stringify(serveFile)};
if(args[0] === 'status') console.log(JSON.stringify({Version:'synthetic',BackendState:'Running',Self:{DNSName:'worker.example.ts.net.',HostName:'test-worker',Online:true},Peer:{}}));
else if(args.includes('status')) console.log(fs.readFileSync(file,'utf8'));
else {
 if(process.env.SCOPE_TEST_SERVE_DENY === '1') {console.error('Serve requires administrator permission');process.exit(1);}
 const config = JSON.parse(fs.readFileSync(file,'utf8'));
 const port = args.find(arg => arg.startsWith('--https=')).split('=')[1];
 if(args.includes('off')) {delete config.TCP[port]; delete config.Web['worker.example.ts.net:'+port];}
 else {config.TCP[port]={HTTPS:true};config.Web['worker.example.ts.net:'+port]={Handlers:{'/':{Proxy:args.at(-1)}}};}
 fs.writeFileSync(file,JSON.stringify(config));
}`,
  );
  await mock(
    "systemctl",
    `
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {setTimeout: delay} = require('node:timers/promises');
const args=process.argv.slice(2), file=${JSON.stringify(pidFile)};
function running(pid) {
 try {
  process.kill(pid, 0);
  if(process.platform === 'linux') {
   const status = fs.readFileSync('/proc/'+pid+'/stat', 'utf8');
   // An orphan can remain a zombie after it releases its resources.
   if(status.slice(status.lastIndexOf(')') + 2).startsWith('Z')) return false;
  }
  return true;
 } catch(error) {
  if(error.code === 'ESRCH' || error.code === 'ENOENT') return false;
  throw error;
 }
}
async function main() {
 if(args.includes('stop') || args.includes('restart') || args.includes('--now')) {
  if(fs.existsSync(file)) {
   const pid = Number(fs.readFileSync(file,'utf8'));
   try { process.kill(pid, 'SIGTERM'); } catch(error) { if(error.code !== 'ESRCH') throw error; }
   // systemctl waits for stop completion before starting a replacement.
   const deadline = Date.now() + 5000;
   while(running(pid)) {
    if(Date.now() >= deadline) {
     process.kill(pid, 'SIGKILL');
     throw new Error('The synthetic hub did not stop within five seconds.');
    }
    await delay(20);
   }
   fs.unlinkSync(file);
  }
 }
 if(args.includes('start') || args.includes('restart')) {
  const output = fs.openSync(${JSON.stringify(hubLog)}, 'a', 0o600);
  const child=spawn(${JSON.stringify(join(root, "current/runtime/node"))},[${JSON.stringify(join(root, "current/hub/main.mjs"))},'run'],{env:process.env,detached:true,stdio:['ignore',output,output]});
  fs.closeSync(output);
  await once(child, 'spawn');
  fs.writeFileSync(file,String(child.pid));child.unref();
 }
}
main().catch(error => {console.error(error);process.exitCode = 1;});`,
  );
  const cli = (...args: string[]) => exec(join(bin, "irudd-scope"), args, { env, timeout: 30_000 });
  try {
    await exec("bash", [resolve("install-cli.sh")], { env, timeout: 60_000 });
    expect((await cli("--help")).stdout).toContain("irudd-scope setup");
    if (process.platform !== "linux") {
      await expect(
        cli("setup", "--yes", "--no-pair", "--port", String(port)),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("requires Linux with a systemd user service"),
      });
      return;
    }
    await expect(cli("setup", "--port", String(port))).rejects.toMatchObject({
      stderr: expect.stringContaining("--yes"),
    });
    await expect(
      exec(join(bin, "irudd-scope"), ["setup", "--yes", "--no-pair", "--port", String(port)], {
        env: { ...env, SCOPE_TEST_SERVE_DENY: "1" },
        timeout: 30_000,
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("sudo tailscale serve") });
    const result = await cli("setup", "--yes", "--no-pair", "--port", String(port));
    expect(result.stdout).toContain("Hub is running");
    const serve = JSON.parse(await readFile(serveFile, "utf8"));
    expect(serve.Web["worker.example.ts.net:443"]).toEqual(
      existingServe.Web["worker.example.ts.net:443"],
    );
    expect(JSON.parse((await cli("hub", "status")).stdout)).toMatchObject({
      connected: false,
      pairedMac: null,
    });
    await cli("hub", "stop");
    await exec(join(bin, "irudd-scope"), ["setup", "--yes", "--no-pair"], {
      env: { ...env, SCOPE_TEST_SERVE_DENY: "1" },
      timeout: 30_000,
    });
    expect(JSON.parse(await readFile(serveFile, "utf8"))).toEqual(serve);
    expect((await cli("pair")).stdout).toContain("irudd-scope://pair?endpoint=");
    expect((await stat(join(directory, "connection.json"))).mode & 0o777).toBe(0o600);
    expect(await readlink(join(userDirectory, ".agents/skills/irudd-scope"))).toBe(
      join(root, "current/skill"),
    );
    expect(
      await readFile(join(userDirectory, ".claude/skills/irudd-scope/SKILL.md"), "utf8"),
    ).toContain("name: irudd-scope");
    await cli("hub", "unpair");
    await cli("hub", "remove");
    expect(JSON.parse(await readFile(serveFile, "utf8"))).toEqual(existingServe);
    await expect(
      stat(join(userDirectory, ".config/systemd/user/irudd-scope-hub.service")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await cli("skill", "remove");
    await expect(stat(join(userDirectory, ".agents/skills/irudd-scope"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await cli("--help")).stdout).toContain("irudd-scope add");
  } catch (error) {
    const output = await readFile(hubLog, "utf8").catch(() => "No hub output was captured.");
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nHub output:\n${output}`,
      { cause: error },
    );
  } finally {
    try {
      await exec(join(bin, "systemctl"), ["--user", "stop", "irudd-scope-hub.service"], {
        env,
        timeout: 10_000,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 60_000);
