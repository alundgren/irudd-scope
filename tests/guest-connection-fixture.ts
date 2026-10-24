import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect } from "vite-plus/test";
import { syntheticCli } from "./synthetic-cli.ts";
import { desktopFixture } from "./desktop-fixture.ts";

// A local CLI stand-in keeps standard tests independent of public relay service.
const cli = String.raw`
const fs = require('node:fs');
const net = require('node:net');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
const keyPath = args.find(a => a.startsWith('--key='))?.slice(6);
const events = process.env.SCOPE_GUEST_FIXTURE_EVENTS;
function record(kind,port) { fs.appendFileSync(events, JSON.stringify({kind,pid:process.pid,port})+'\n'); }
function tunnel(socket,port,observe=false) {
 if(observe) {
  let header='';
  const inspect=chunk=>{
   header+=chunk.toString();
   if(header.includes('\r\n')) {
    const path=header.split(' ')[1];
    if(['/guest/challenge','/guest/hello','/guest/identity'].includes(path))record(path,port);
    socket.removeListener('data',inspect);
   }
  };
  socket.on('data',inspect);
 }
 const routes=process.env.SCOPE_GUEST_FIXTURE_ROUTES;
 const target=observe && routes ? JSON.parse(fs.readFileSync(routes,'utf8'))[port]??port : port;
 const remote=net.connect(target,'127.0.0.1');
 socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy());
 socket.pipe(remote);remote.pipe(socket);
}
if (args[0]==='genkey') {
 fs.writeFileSync(keyPath,JSON.stringify({Private:crypto.randomBytes(32).toString('hex')}));
} else if (args.includes('serve')) {
 const port=Number(args.at(-1));
 const key=keyPath==='new' ? crypto.randomBytes(32) : fs.readFileSync(keyPath);
 const address='tc'+crypto.createHash('sha256').update(key).digest('hex');
 record('serve',port);process.stdout.write(JSON.stringify({listenAddr:address})+'\n');setInterval(()=>{},1000);
} else if (args.includes('forward')) {
 const port=Number(args.at(-1).split(':')[1]);
 net.createServer(socket=>tunnel(socket,port)).listen(0,'127.0.0.1',function(){
 record('forward',this.address().port);process.stderr.write('# forwarding 127.0.0.1:'+this.address().port+' -> remote localhost:'+port+'\n');
 });
} else if (args.includes('socks')) {
 net.createServer(socket=>{
  let phase=0,buffer=Buffer.alloc(0);
  const receive=chunk=>{
   buffer=Buffer.concat([buffer,chunk]);
   if(phase===0 && buffer.length>=3){buffer=buffer.subarray(3);phase=1;socket.write(Buffer.from([5,0]));}
   if(phase===1 && buffer.length>=5 && buffer.length>=7+buffer[4]){
    const end=7+buffer[4],port=buffer.readUInt16BE(end-2);
    socket.removeListener('data',receive);socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));
    if(buffer.length>end)socket.unshift(buffer.subarray(end));tunnel(socket,port,true);
   }
  };
  socket.on('data',receive);socket.on('error',()=>{});
 }).listen(0,'127.0.0.1',function(){record('socks',this.address().port);process.stderr.write('SOCKS running at socks5h://127.0.0.1:'+this.address().port+'\n');});
} else process.exit(2);
`;

export async function guestConnectionChecks() {
  const directory = await mkdtemp(join(tmpdir(), "scope-guest-cli-"));
  const events = join(directory, "events.jsonl");
  const routes = join(directory, "routes.json");
  await writeFile(routes, "{}");
  await syntheticCli(directory, "tailcat", cli);
  const env = {
    PATH: directory + delimiter + process.env.PATH,
    SCOPE_GUEST_FIXTURE_EVENTS: events,
    SCOPE_GUEST_FIXTURE_ROUTES: routes,
  };
  const a = await desktopFixture({ hideInitialPrompts: true, env });
  const b = await desktopFixture({ hideInitialPrompts: true, env });
  const trap = createServer((_request, response) => response.writeHead(403).end());
  await new Promise<void>((resolve) => trap.listen(0, "127.0.0.1", resolve));
  const trapPort = (trap.address() as { port: number }).port;
  const left = await a.launch();
  let right: typeof left | undefined;
  try {
    right = await b.launch();
    const pageA = await left.firstWindow();
    const pageB = await right.firstWindow();
    const invitation = await pageA.evaluate(() => window.scope.createPairing("Source Scope"));
    await pageA.evaluate((id) => window.scope.copyPairingSecret(id), invitation.id);
    const pairingSecret = await left.evaluate(({ clipboard }) => clipboard.readText());
    await pageB.evaluate((input) => window.scope.pairScope(input), {
      url: invitation.url,
      secret: pairingSecret,
      name: "Guest Scope",
    });
    const id = (await pageA.evaluate(() => window.scope.transferDevices())).peers[0]!.id;
    expect((await pageB.evaluate(() => window.scope.guestStatus())).peers[0]).toMatchObject({
      enabled: false,
      state: "disabled",
    });
    await pageA.evaluate((id) => window.scope.setGuestAccess(id, true), id);
    await pageA.evaluate((id) => window.scope.copyGuestLink(id), id);
    const link = await left.evaluate(({ clipboard }) => clipboard.readText());
    const decoded = JSON.parse(Buffer.from(link.split("#")[1]!, "base64url").toString());
    const { mac: _mac, ...routed } = decoded;
    await writeFile(routes, JSON.stringify({ [trapPort]: decoded.endpoint.port }));
    routed.endpoint = { ...routed.endpoint, port: trapPort };
    const mac = createHmac("sha256", Buffer.from(pairingSecret, "base64url"))
      .update("scope-guest:link:" + JSON.stringify(routed))
      .digest("base64url");
    const routedLink =
      "scope-guest://v1/#" + Buffer.from(JSON.stringify({ ...routed, mac })).toString("base64url");
    // The signed destination rejects direct HTTP. Only SOCKS maps it to the peer.
    expect((await fetch(`http://127.0.0.1:${trapPort}/guest/challenge`)).status).toBe(403);
    await right.evaluate(({ clipboard }, link) => clipboard.writeText(link), routedLink);
    await expect(pageB.evaluate((id) => window.scope.connectGuestLink(id), id)).rejects.toThrow(
      "disabled",
    );
    await pageB.evaluate((id) => window.scope.setGuestAccess(id, true), id);
    await pageB.evaluate((id) => window.scope.connectGuestLink(id), id);
    const stateA = () =>
      pageA.evaluate(() => window.scope.guestStatus()).then((status) => status.peers[0]?.state);
    const stateB = () =>
      pageB.evaluate(() => window.scope.guestStatus()).then((status) => status.peers[0]?.state);
    await expect.poll(stateA, { timeout: 20000 }).toBe("connected");
    await expect.poll(stateB).toBe("connected");
    await right.evaluate(({ clipboard }) => clipboard.writeText("scope-guest://v1/#invalid"));
    await expect(pageB.evaluate((id) => window.scope.connectGuestLink(id), id)).rejects.toThrow(
      "invalid",
    );
    expect(await stateB()).toBe("connected");
    const rows = (await readFile(events, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; pid: number; port: number });
    // These events are emitted only after HTTP bytes cross the SOCKS tunnel.
    // Merely completing SOCKS CONNECT while HTTP uses a local socket cannot pass.
    expect(rows.some((row) => row.kind === "/guest/challenge" && row.port === trapPort)).toBe(true);
    expect(rows.some((row) => row.kind === "/guest/hello" && row.port === trapPort)).toBe(true);
    expect(rows.filter((row) => row.kind === "/guest/challenge").length).toBeGreaterThanOrEqual(2);
    expect(rows.filter((row) => row.kind === "/guest/hello").length).toBeGreaterThanOrEqual(2);
    await pageA.evaluate((id) => window.scope.retryGuest(id), id);
    await expect
      .poll(async () => (await readFile(events, "utf8")).includes('"/guest/identity"'))
      .toBe(true);
    const servers = rows.filter((row) => row.kind === "serve");
    const endpoint = JSON.parse(Buffer.from(link.split("#")[1]!, "base64url").toString())
      .endpoint as { port: number; address: string };
    expect((await fetch(`http://127.0.0.1:${endpoint.port}/guest/identity`)).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${endpoint.port}/v1/artifacts`)).status).toBe(403);
    const tailcat = servers.find((row) => row.port === endpoint.port)!;
    process.kill(tailcat.pid, "SIGKILL");
    await expect
      .poll(
        async () =>
          (await readFile(events, "utf8")).split("\n").filter((line) => line.includes('"serve"'))
            .length,
        { timeout: 30000 },
      )
      .toBeGreaterThan(servers.length);
    await pageA.evaluate((id) => window.scope.retryGuest(id), id);
    await pageB.evaluate((id) => window.scope.retryGuest(id), id);
    await expect.poll(stateA, { timeout: 30000 }).toBe("connected");
    await expect.poll(stateB, { timeout: 30000 }).toBe("connected");
    await pageA.evaluate((id) => window.scope.copyGuestLink(id), id);
    const restarted = await left.evaluate(({ clipboard }) => clipboard.readText());
    expect(
      JSON.parse(Buffer.from(restarted.split("#")[1]!, "base64url").toString()).endpoint,
    ).toEqual(endpoint);
    await pageA.evaluate((id) => window.scope.setGuestAccess(id, false), id);
    expect(await stateA()).toBe("disabled");
    await pageB.evaluate((id) => window.scope.retryGuest(id), id);
    await expect.poll(stateB, { timeout: 20000 }).toBe("offline");
    expect((await pageA.evaluate(() => window.scope.transferDevices())).peers).toHaveLength(1);
    await pageA.evaluate((id) => window.scope.forgetScope(id), id);
    expect((await pageA.evaluate(() => window.scope.transferDevices())).peers).toHaveLength(0);
  } finally {
    await right?.close();
    trap.closeAllConnections();
    await new Promise<void>((resolve) => trap.close(() => resolve()));
    await left.close();
    await Promise.all(
      [directory, a.directory, b.directory].map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    );
  }
}
