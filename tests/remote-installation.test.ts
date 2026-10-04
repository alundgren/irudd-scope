import { expect, test } from "vite-plus/test";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";

const exec = promisify(execFile);

test("the standalone installer and CLI setup preserve existing Serve routes and can revoke and remove the hub", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-remote-install-"));
  const root = join(directory, "installation");
  const bin = join(directory, "bin");
  const userDirectory = join(directory, "user");
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
  let hub: ReturnType<typeof spawn> | undefined;
  let hubDiagnostics = "";
  const stopHub = async () => {
    if (hub && hub.exitCode === null && hub.signalCode === null) {
      const closed = once(hub, "close");
      hub.kill();
      await closed;
    }
    hub = undefined;
  };
  // systemctl waits for the previous process to exit before starting its replacement.
  const services = createHttpServer(async (request, response) => {
    try {
      const args: string[] = JSON.parse(decodeURIComponent(request.url!.slice(1)));
      if (args.includes("stop") || args.includes("restart") || args.includes("--now"))
        await stopHub();
      if (args.includes("start") || args.includes("restart")) {
        hub = spawn(join(root, "current/bin/irudd-scope-hub"), [], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        for (const stream of [hub.stdout, hub.stderr])
          stream!.on("data", (chunk: Buffer) => (hubDiagnostics += chunk.toString()));
        await once(hub, "spawn");
      }
      response.end();
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
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
  const cli = (...args: string[]) => exec(join(bin, "irudd-scope"), args, { env, timeout: 30_000 });
  try {
    services.listen(0, "127.0.0.1");
    await once(services, "listening");
    const servicePort = (services.address() as { port: number }).port;
    await mock(
      "systemctl",
      `
fetch('http://127.0.0.1:${servicePort}/'+encodeURIComponent(JSON.stringify(process.argv.slice(2))))
 .then(async response => {if(!response.ok) throw new Error(await response.text());})
 .catch(error => {console.error(error);process.exitCode=1;});`,
    );
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
    const retroSkill = join(userDirectory, ".agents/skills/irudd-scope-retro");
    expect(await readlink(retroSkill)).toBe(join(root, "current/retro-skill"));
    expect(
      await readFile(join(userDirectory, ".claude/skills/irudd-scope-retro/SKILL.md"), "utf8"),
    ).toContain("name: irudd-scope-retro");
    expect(
      (await exec("python3", [join(retroSkill, "scripts/retro_sessions.py"), "--help"])).stdout,
    ).toContain("snapshot");
    const separateSkill = join(userDirectory, ".agents/skills/custom-retro");
    await mkdir(separateSkill, { recursive: true });
    await writeFile(join(separateSkill, "SKILL.md"), "Separately maintained skill");
    // Upgrade an installation which only had the original Scope skill.
    await rm(retroSkill);
    await rm(join(userDirectory, ".claude/skills/irudd-scope-retro"));
    await cli("skill", "sync");
    expect(JSON.parse((await cli("skill", "check")).stdout)).toEqual({ installed: true });
    expect(await readFile(join(retroSkill, "SKILL.md"), "utf8")).toContain(
      "name: irudd-scope-retro",
    );
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
    await expect(stat(retroSkill)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(separateSkill, "SKILL.md"), "utf8")).toBe(
      "Separately maintained skill",
    );
    expect((await cli("--help")).stdout).toContain("irudd-scope add");
  } catch (error) {
    console.error(hubDiagnostics);
    throw error;
  } finally {
    await stopHub();
    await new Promise<void>((done) => services.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
