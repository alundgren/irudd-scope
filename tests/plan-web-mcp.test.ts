import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { startPlanWebServer } from "../apps/plan-web/src/backend/server.ts";
import type { PlanSnapshot } from "../apps/plan-web/src/contracts.ts";

let directory: string;
let server: Awaited<ReturnType<typeof startPlanWebServer>>;
const databasePath = () => join(directory, "plans.sqlite");
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "plan-mcp-"));
  server = await startPlanWebServer({ databasePath: databasePath() });
});
afterEach(async () => {
  await server.close();
  await rm(directory, { recursive: true, force: true });
});
async function post(path: string, input: unknown) {
  return fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close" },
    body: JSON.stringify(input),
    redirect: "manual",
  });
}
type Pairing = { pairing_id: string; pairing_secret: string; verification_uri: string };
async function pair(agent = "Test agent"): Promise<Pairing> {
  return (await post("/auth/pairing", { agent, resource: `${server.url}/mcp` })).json();
}
async function decide(pairing: Pairing, action = "approve", identity = "Alex") {
  const page = await fetch(pairing.verification_uri, { headers: { Connection: "close" } });
  const html = await page.text();
  expect(html).toContain("Alex");
  expect(html).toContain("Blair");
  expect(html).toContain("Casey");
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
  return fetch(pairing.verification_uri, {
    method: "POST",
    headers: {
      Origin: server.url,
      Cookie: page.headers.get("set-cookie")!.split(";")[0],
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ csrf, action, identity }),
    redirect: "manual",
  });
}
async function approve(identity = "Alex", agent = "Test agent") {
  const pairing = await pair(agent);
  expect((await decide(pairing, "approve", identity)).status).toBe(200);
  const response = await post("/auth/pairing/poll", pairing);
  expect(response.status).toBe(200);
  const token = (await response.json()) as { access_token: string };
  return { pairing, token: token.access_token };
}
async function rpc(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  extra: Record<string, string> = {},
) {
  const send = extra.Host ? gatewayRequest : fetch;
  return send(`${server.url}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...(method === "tools/call" ? { "Mcp-Name": String(params.name) } : {}),
      ...extra,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}
async function gatewayRequest(url: string, options: RequestInit = {}) {
  return new Promise<Response>((resolveResponse, reject) => {
    const request = httpRequest(
      url,
      { method: options.method, headers: Object.fromEntries(new Headers(options.headers)) },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("error", reject);
        incoming.on("end", () =>
          resolveResponse(
            new Response(Buffer.concat(chunks), {
              status: incoming.statusCode,
              headers: incoming.headers as Record<string, string>,
            }),
          ),
        );
      },
    );
    request.on("error", reject);
    request.end(options.body instanceof URLSearchParams ? options.body.toString() : options.body);
  });
}
async function tool<T>(token: string, name: string, args: unknown): Promise<T> {
  const response = await rpc(token, "tools/call", { name, arguments: args });
  expect(response.status).toBe(200);
  expect(response.headers.get("mcp-session-id")).toBeNull();
  const message = (await response.json()) as {
    result: { content: { text: string }[] };
    error?: unknown;
  };
  expect(message.error).toBeUndefined();
  return JSON.parse(message.result.content[0].text) as T;
}
function expire(table: "mcp_grants" | "mcp_credentials") {
  const db = new DatabaseSync(databasePath());
  if (table === "mcp_grants") {
    for (const row of db.prepare("SELECT id,data FROM mcp_grants").all()) {
      const data = JSON.parse(String(row.data)) as Record<string, unknown>;
      data.expires = Date.now() - 1;
      db.prepare("UPDATE mcp_grants SET expires=?,data=? WHERE id=?").run(
        data.expires as number,
        JSON.stringify(data),
        String(row.id),
      );
    }
  } else db.exec("UPDATE mcp_credentials SET expires=0");
  db.close();
}
describe("MCP browser approvals and stateless requests", () => {
  test("requires credentials, rejects foreign origins, and advertises OAuth discovery", async () => {
    expect((await rpc("invalid", "tools/list")).status).toBe(401);
    const challenge = await rpc("invalid", "tools/list");
    expect(challenge.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
    expect(
      (await rpc("invalid", "tools/list", {}, { Origin: "https://attacker.invalid" })).status,
    ).toBe(403);
    const resource = (await (
      await fetch(`${server.url}/.well-known/oauth-protected-resource/mcp`)
    ).json()) as { resource: string };
    expect(resource.resource).toBe(`${server.url}/mcp`);
    expect((await fetch(`${server.url}/mcp`)).status).toBe(405);
  });
  test("requires explicit form approval, preserves grants and credentials over restart, and redeems once", async () => {
    const pairing = await pair();
    expect((await post("/auth/pairing/poll", pairing)).status).toBe(400);
    const forged = await fetch(pairing.verification_uri, {
      method: "POST",
      headers: { Origin: server.url },
      body: "action=approve&identity=Alex",
    });
    expect(forged.status).toBe(403);
    const oldUrl = server.url;
    await server.close();
    server = await startPlanWebServer({
      databasePath: databasePath(),
      port: Number(new URL(oldUrl).port),
    });
    expect((await decide(pairing, "approve", "Blair")).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const response = await post("/auth/pairing/poll", pairing);
    expect(response.status).toBe(200);
    const value = (await response.json()) as { access_token: string };
    expect((await post("/auth/pairing/poll", pairing)).status).toBe(400);
    await server.close();
    server = await startPlanWebServer({
      databasePath: databasePath(),
      port: Number(new URL(oldUrl).port),
    });
    expect((await rpc(value.access_token, "tools/list")).status).toBe(200);
    const db = new DatabaseSync(databasePath());
    const stored = JSON.stringify(db.prepare("SELECT * FROM mcp_credentials").all());
    expect(stored).not.toContain(value.access_token);
    expect(JSON.stringify(db.prepare("SELECT * FROM mcp_grants").all())).not.toContain(
      pairing.pairing_secret,
    );
    db.close();
  });
  test("denial, cancellation, expiry, bounded polling, revocation, and endpoint binding", async () => {
    const denied = await pair();
    await decide(denied, "deny");
    expect((await post("/auth/pairing/cancel", denied)).status).toBe(400);
    expect(await (await fetch(denied.verification_uri)).text()).toContain("Authorization denied");
    expect(await (await post("/auth/pairing/poll", denied)).json()).toEqual({
      error: "access_denied",
    });
    const cancelled = await pair();
    await post("/auth/pairing/cancel", cancelled);
    expect(await (await post("/auth/pairing/poll", cancelled)).json()).toEqual({
      error: "access_denied",
    });
    const pending = await pair();
    await post("/auth/pairing/poll", pending);
    expect(await (await post("/auth/pairing/poll", pending)).json()).toMatchObject({
      error: "slow_down",
      interval: 7,
    });
    expire("mcp_grants");
    expect(await (await post("/auth/pairing/poll", pending)).json()).toEqual({
      error: "expired_token",
    });
    const { token } = await approve("Casey");
    expire("mcp_credentials");
    expect((await rpc(token, "tools/list")).status).toBe(401);
    const fresh = await approve();
    await fetch(`${server.url}/auth/revoke`, {
      method: "POST",
      body: new URLSearchParams({ token: fresh.token }),
    });
    expect((await rpc(fresh.token, "tools/list")).status).toBe(401);
    const bound = await approve();
    const oldUrl = server.url;
    await server.close();
    server = await startPlanWebServer({ databasePath: databasePath() });
    expect(server.url).not.toBe(oldUrl);
    expect((await rpc(bound.token, "tools/list")).status).toBe(401);
  });
  test("fresh requests support all tools and exact retries with two agents and a human", async () => {
    const alex = await approve("Alex", "Agent one");
    const blair = await approve("Blair", "Agent two");
    expect((await rpc(alex.token, "server/discover")).status).toBe(200);
    const list = (await (await rpc(alex.token, "tools/list")).json()) as {
      result: { tools: unknown[] };
    };
    expect(list.result.tools).toHaveLength(8);
    const current = await tool<PlanSnapshot>(alex.token, "plan_read", { name: "team" });
    const args = {
      name: "team",
      requestId: "html-once",
      baseHtmlRevision: current.htmlRevision,
      html: current.html.replace("Start planning together.", "Both agents can read this."),
    };
    const lost = await rpc(alex.token, "tools/call", { name: "plan_apply_html", arguments: args });
    await lost.body?.cancel();
    const committed = await tool<{ revision: number; snapshot: PlanSnapshot }>(
      alex.token,
      "plan_apply_html",
      args,
    );
    expect(await tool(alex.token, "plan_apply_html", args)).toEqual(committed);
    expect(committed.snapshot.htmlRevision).toBe(current.htmlRevision + 1);
    const comment = await tool<{ snapshot: PlanSnapshot }>(blair.token, "plan_comment", {
      name: "team",
      requestId: "agent-comment",
      text: "Review this",
      anchor: { elementId: "title", quote: "team", x: 0, y: 0 },
    });
    expect(comment.snapshot.comments[0].actor).toMatchObject({
      id: "fake-user-blair",
      kind: "agent",
      name: "Blair / Agent two",
    });
    const id = comment.snapshot.comments[0].id;
    await post("/api/plans/team/commands", {
      requestId: "human-reply",
      actor: { id: "fake-user-casey", name: "Casey", kind: "human" },
      kind: "comment.reply",
      commentId: id,
      text: "Human reviewed",
    });
    await tool(alex.token, "plan_reply", {
      name: "team",
      requestId: "agent-reply",
      commentId: id,
      text: "Updated",
    });
    const resolved = await tool<{ snapshot: PlanSnapshot }>(blair.token, "plan_resolve", {
      name: "team",
      requestId: "resolved",
      commentId: id,
      resolved: true,
    });
    expect(resolved.snapshot.comments[0].replies).toHaveLength(2);
    expect(resolved.snapshot.comments[0].resolved).toBe(true);
    expect(
      await tool(alex.token, "plan_version", { name: "team", revision: committed.revision }),
    ).toEqual(committed.snapshot);
    expect(
      await tool(alex.token, "plan_diff", { name: "team", from: 1, to: committed.revision }),
    ).toMatchObject({ diff: expect.stringContaining("Both agents") });
    expect(await tool(alex.token, "plan_history", { name: "team", limit: 2 })).toMatchObject({
      versions: expect.any(Array),
      nextBefore: expect.any(Number),
    });
    expect(
      (
        await rpc(
          alex.token,
          "tools/call",
          { name: "plan_read", arguments: { name: "team" } },
          { "Mcp-Name": "plan_apply_html" },
        )
      ).status,
    ).toBe(400);
    const legacy = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alex.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "old", version: "1" },
        },
      }),
    });
    expect(legacy.status).toBe(400);
  });
  test("generic clients register and redeem authorization codes with S256 PKCE", async () => {
    const redirectUri = "http://127.0.0.1:49123/callback";
    const registration = await post("/auth/register", {
      client_name: "Generic MCP client",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    });
    expect(registration.status).toBe(201);
    const client = (await registration.json()) as { client_id: string };
    const verifier = "a".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      resource: `${server.url}/mcp`,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "state-check",
    });
    const authorization = await fetch(`${server.url}/auth/authorize?${params}`, {
      redirect: "manual",
    });
    expect(authorization.status).toBe(302);
    const uri = `${server.url}${authorization.headers.get("location")!}`;
    const response = await decide(
      { pairing_id: "", pairing_secret: "", verification_uri: uri },
      "approve",
      "Casey",
    );
    expect(response.status).toBe(302);
    const callback = new URL(response.headers.get("location")!);
    expect(callback.searchParams.get("state")).toBe("state-check");
    expect(callback.searchParams.get("iss")).toBe(server.url);
    const input = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      resource: `${server.url}/mcp`,
      code: callback.searchParams.get("code")!,
      code_verifier: verifier,
    });
    const tokenRequest = () => fetch(`${server.url}/auth/token`, { method: "POST", body: input });
    input.set("code_verifier", "b".repeat(43));
    expect((await tokenRequest()).status).toBe(400);
    input.set("code_verifier", verifier);
    input.set("resource", "https://other.example/mcp");
    expect((await tokenRequest()).status).toBe(400);
    input.set("resource", `${server.url}/mcp`);
    const tokenResponse = await tokenRequest();
    expect(tokenResponse.status).toBe(200);
    const token = (await tokenResponse.json()) as { access_token: string };
    expect((await tokenRequest()).status).toBe(400);
    expect((await rpc(token.access_token, "tools/list")).status).toBe(200);
    expect(
      (await post("/auth/register", { redirect_uris: ["http://evil.invalid/callback"] })).status,
    ).toBe(400);
  });
  test("configured HTTPS proxy origin owns discovery, approval URLs, audience and origin checks", async () => {
    await server.close();
    const publicOrigin = "https://plans.example:8455";
    server = await startPlanWebServer({ databasePath: databasePath(), publicOrigin });
    const headers = { Host: new URL(publicOrigin).host, Connection: "close" };
    const metadata = await gatewayRequest(`${server.url}/.well-known/oauth-authorization-server`, {
      headers,
    });
    expect(await metadata.json()).toMatchObject({
      issuer: publicOrigin,
      authorization_endpoint: `${publicOrigin}/auth/authorize`,
      token_endpoint: `${publicOrigin}/auth/token`,
    });
    const response = await gatewayRequest(`${server.url}/auth/pairing`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ resource: `${publicOrigin}/mcp`, agent: "Remote agent" }),
    });
    const pairing = (await response.json()) as Pairing;
    expect(pairing.verification_uri).toBe(`${publicOrigin}/auth/approve/${pairing.pairing_id}`);
    const path = new URL(pairing.verification_uri).pathname;
    const page = await gatewayRequest(`${server.url}${path}`, { headers });
    expect(page.headers.get("set-cookie")).toContain("Secure");
    const html = await page.text();
    expect(html).toContain(`${publicOrigin}/mcp`);
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
    const approve = await gatewayRequest(`${server.url}${path}`, {
      method: "POST",
      headers: {
        ...headers,
        Origin: publicOrigin,
        Cookie: page.headers.get("set-cookie")!.split(";")[0],
      },
      body: new URLSearchParams({ csrf, action: "approve", identity: "Alex" }),
    });
    expect(approve.status).toBe(200);
    const poll = await gatewayRequest(`${server.url}/auth/pairing/poll`, {
      method: "POST",
      headers,
      body: JSON.stringify(pairing),
    });
    const token = (await poll.json()) as { access_token: string };
    expect((await rpc(token.access_token, "tools/list", {}, headers)).status).toBe(200);
    expect((await rpc(token.access_token, "tools/list")).status).toBe(403);
    expect(
      (await rpc(token.access_token, "tools/list", {}, { ...headers, Origin: server.url })).status,
    ).toBe(403);
  });
});

test("source development entry starts under the provisioned Node runtime", async () => {
  const child = spawn(process.execPath, [resolve("apps/plan-web/src/server-main.ts")], {
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      PLAN_WEB_ORIGIN: "",
      PLAN_WEB_DB: join(directory, "source-entry.sqlite"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (bytes: Buffer) => {
    stderr += bytes.toString();
  });
  try {
    const url = await new Promise<string>((ready, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Development entry did not start: ${stderr}`)),
        10_000,
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`Development entry exited: ${stderr}`));
      });
      let output = "";
      child.stdout.on("data", (bytes: Buffer) => {
        output += bytes.toString();
        const found = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
        if (found) {
          clearTimeout(timer);
          ready(found[0]);
        }
      });
    });
    expect((await fetch(`${url}/api/plans/source-entry`)).status).toBe(200);
    expect(
      (
        await fetch(`${url}/auth/pairing`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent: "Development entry agent", resource: `${url}/mcp` }),
        })
      ).status,
    ).toBe(200);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  }
}, 15_000);
