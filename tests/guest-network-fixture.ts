import { writeFile } from "node:fs/promises";
import { join, resolve, delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import { syntheticCli } from "./synthetic-cli.ts";

/** Emulate OS discovery and route synthetic node addresses to isolated local sockets. */
export async function guestNetworkFixture(directory: string) {
  const state = join(directory, "network-state.json");
  await writeFile(state, "{}");
  await syntheticCli(
    directory,
    "tailscale",
    String.raw`
const address = process.env.SCOPE_GUEST_TEST_ADDRESS;
const fault = JSON.parse(require('node:fs').readFileSync(process.env.SCOPE_GUEST_TEST_STATE, 'utf8'))[address] ?? {};
const peer = address === '100.64.0.1' ? '100.64.0.2' : '100.64.0.1';
console.log(JSON.stringify({ Version: '1.90.0-synthetic', TUN: true, Health: [], BackendState: fault.stopped ? 'Stopped' : 'Running', Self: { ID: 'synthetic-self', HostName: 'scope-one', Online: true, TailscaleIPs: [address] }, Peer: { synthetic: { ID: 'synthetic-peer', HostName: 'scope-two', DNSName: 'scope-two.example.test.', Online: true, TailscaleIPs: [peer] } } }));
`,
  );
  const entry = join(directory, "guest-desktop.cjs");
  await writeFile(
    entry,
    `
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const address = process.env.SCOPE_GUEST_TEST_ADDRESS;
const fault = () => JSON.parse(fs.readFileSync(process.env.SCOPE_GUEST_TEST_STATE, 'utf8'))[address] ?? {};
os.networkInterfaces = () => ({ synthetic: fault().interfaceMissing ? [] : [{ address, family: 'IPv4', internal: false }] });
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function(...args) {
  if (args[1] === address) {
    if (fault().occupied) { process.nextTick(() => this.emit('error', Object.assign(new Error('Synthetic occupied port'), { code: 'EADDRINUSE' }))); return this; }
    if (process.env.SCOPE_GUEST_FIXTURE_EVENTS) fs.appendFileSync(process.env.SCOPE_GUEST_FIXTURE_EVENTS, JSON.stringify({ kind: 'listen', address })+'\\n');
    args[1] = '127.0.0.1';
  }
  return listen.apply(this, args);
};
const request = http.request;
http.request = function(...args) {
  let options = args[0];
  if (options && typeof options === 'object' && /^100\\.64\\.0\\.[12]$/.test(options.host)) {
    const routes = JSON.parse(fs.readFileSync(process.env.SCOPE_GUEST_FIXTURE_ROUTES, 'utf8'));
    const port = options.port;
    if (process.env.SCOPE_GUEST_FIXTURE_EVENTS) fs.appendFileSync(process.env.SCOPE_GUEST_FIXTURE_EVENTS, JSON.stringify({ kind: options.path, port })+'\\n');
    args[0] = { ...options, host: '127.0.0.1', localAddress: '127.0.0.1', port: routes[port] ?? port };
  }
  return request.apply(this, args);
};
require('node:module').syncBuiltinESMExports();
import(${JSON.stringify(pathToFileURL(resolve("apps/desktop/dist/main.mjs")).href)});
`,
  );
  return {
    entry,
    state,
    env: { PATH: directory + delimiter + process.env.PATH, SCOPE_GUEST_TEST_STATE: state },
  };
}
