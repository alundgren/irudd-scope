import { expect, test } from "vite-plus/test";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { readPlanSnapshot, type PlanSnapshot } from "@irudd-scope/protocol/plan";
import { artifactRequest } from "@irudd-scope/protocol/remote";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
const executable = resolve("packages/cli/dist/main.mjs");
const exec = promisify(execFile);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope-plan-cli-"));
  const token = "synthetic-plan-cli-token";
  const server = await startArtifactServer({ directory, token, port: 0 });
  const client = new ScopeClient(server.url, token);
  const env = {
    ...process.env,
    SCOPE_ENDPOINT: server.url,
    SCOPE_TOKEN: token,
    SCOPE_TOKEN_FILE: undefined,
    SCOPE_CONNECTION_FILE: undefined,
  };
  const cli = (...args: string[]) => exec(process.execPath, [executable, ...args], { env });
  const html = join(directory, "plan.html");
  await writeFile(html, "<h1 id='goal'>Build a feature</h1>");
  return {
    directory,
    server,
    client,
    env,
    cli,
    html,
    close: async () => {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function read(client: ScopeClient): Promise<PlanSnapshot> {
  return readPlanSnapshot((command) => client.plan(command), "cli-plan");
}
async function addComment(client: ScopeClient, revision: number) {
  await client.plan({
    action: "comment",
    name: "cli-plan",
    requestId: randomUUID(),
    revision,
    page: "goal",
    text: "Include a failure case",
    image: png,
    annotatedImage: png,
    annotations: [{ type: "box", from: { x: 0.2, y: 0.3 }, to: { x: 0.7, y: 0.8 } }],
  });
  return (await read(client)).comments.at(-1)!;
}

test("built plan CLI exports durable visual feedback, commits a response and keeps HTML history", async () => {
  const f = await fixture();
  try {
    const first = JSON.parse((await f.cli("add", f.html, "--plan", "--name", "cli-plan")).stdout);
    expect(first).toMatchObject({ name: "cli-plan", kind: "plan", mediaType: "text/html" });
    expect((await f.server.store.tabs())[0].permanent).toBe(1);
    const comment = await addComment(f.client, first.revision);
    await f.client.plan({
      action: "submit",
      name: "cli-plan",
      requestId: randomUUID(),
      commentIds: [comment.id],
    });
    const state = await read(f.client);
    const output = join(f.directory, "feedback");
    const receipt = JSON.parse(
      (await f.cli("plan", "feedback", "cli-plan", state.rounds[0].id, "--output", output)).stdout,
    );
    expect(receipt).toMatchObject({ comments: 1, revision: first.revision });
    const packet = JSON.parse(await readFile(join(output, "packet.json"), "utf8"));
    expect(packet.comments[0]).toMatchObject({
      id: comment.id,
      text: "Include a failure case",
      annotations: comment.annotations,
    });
    expect(await readFile(join(output, packet.comments[0].image.file))).toEqual(
      Buffer.from(png, "base64"),
    );
    expect(await readFile(join(output, "plan.html"), "utf8")).toContain("Build a feature");
    const response = {
      action: "respond",
      name: "cli-plan",
      requestId: randomUUID(),
      roundId: state.rounds[0].id,
      expectedRevision: first.revision,
      summary: "Added the failure case",
      replies: [{ commentId: comment.id, text: "Covered offline behavior" }],
      html: "<h1>Feature and offline failure</h1>",
    };
    const file = join(f.directory, "response.json");
    await writeFile(file, JSON.stringify(response));
    await f.cli("plan", "respond", file);
    await f.cli("plan", "respond", file);
    const answered = await read(f.client);
    expect(answered.responses).toHaveLength(1);
    expect(answered.rounds[0].status).toBe("responded");
    expect(answered.artifact.revision).toBe(first.revision + 1);
    const original = join(f.directory, "original.html");
    await f.cli(
      "plan",
      "content",
      "cli-plan",
      "--revision",
      String(first.revision),
      "--output",
      original,
    );
    expect(await readFile(original, "utf8")).toContain("Build a feature");
    await expect(f.cli("plan", "content", "cli-plan", "--output", original)).rejects.toThrow();
    await writeFile(f.html, "<h1>Published update</h1>");
    await f.cli("update", first.id, f.html);
    expect(await f.client.get(first.id)).toMatchObject({
      kind: "plan",
      name: "cli-plan",
      revision: first.revision + 2,
    });
    expect(
      JSON.parse(
        (await f.cli("plan", "read", "cli-plan", "--since", String((await read(f.client)).version)))
          .stdout,
      ).type,
    ).toBe("unchanged");
    const auto = JSON.parse((await f.cli("add", f.html, "--plan")).stdout);
    expect(auto.name).toMatch(/^plan-html-[a-f0-9]{8}$/);
    const invalid = join(f.directory, "invalid.md");
    await writeFile(invalid, "# Invalid");
    await expect(f.cli("add", invalid, "--plan")).rejects.toThrow("Plans require an HTML file");
  } finally {
    await f.close();
  }
});

test("plan watcher wakes T3 for submitted rounds, recovers pending rounds and ignores comments/responses", async () => {
  const f = await fixture();
  const requests: { message: { text: string } }[] = [];
  const t3 = createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer synthetic-t3-plan-token") {
      response.writeHead(401).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET")
      response.end(
        JSON.stringify({
          thread: { id: "plan-thread", runtimeMode: "full-access", interactionMode: "default" },
        }),
      );
    else {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      response.end("{}");
    }
  });
  t3.listen(0, "127.0.0.1");
  await once(t3, "listening");
  const address = t3.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const tokenFile = join(f.directory, "t3-token");
  await writeFile(tokenFile, "synthetic-t3-plan-token", { mode: 0o600 });
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<unknown> | undefined;
  try {
    const artifact = JSON.parse(
      (await f.cli("add", f.html, "--plan", "--name", "cli-plan")).stdout,
    );
    const first = await addComment(f.client, artifact.revision);
    await f.client.plan({
      action: "submit",
      name: "cli-plan",
      requestId: randomUUID(),
      commentIds: [first.id],
    });
    child = spawn(
      process.execPath,
      [
        executable,
        "plan",
        "watch",
        "cli-plan",
        "--t3-thread",
        "plan-thread",
        "--t3-endpoint",
        `http://127.0.0.1:${address.port}`,
        "--t3-token-file",
        tokenFile,
      ],
      { env: f.env, cwd: f.directory },
    );
    closed = once(child, "exit");
    let diagnostics = "";
    child.stderr!.on("data", (data) => {
      diagnostics += data;
    });
    await expect.poll(() => diagnostics).toContain("Listening");
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].message.text).toContain((await read(f.client)).rounds[0].id);
    const second = await addComment(f.client, artifact.revision);
    await delay(200);
    expect(requests).toHaveLength(1);
    await f.client.plan({
      action: "submit",
      name: "cli-plan",
      requestId: randomUUID(),
      commentIds: [second.id],
    });
    await expect.poll(() => requests.length).toBe(2);
    const snapshot = await read(f.client);
    await f.client.plan({
      action: "respond",
      name: "cli-plan",
      requestId: randomUUID(),
      roundId: snapshot.rounds[1].id,
      expectedRevision: artifact.revision,
      summary: "Answered",
      replies: [{ commentId: second.id, text: "Confirmed" }],
    });
    await delay(200);
    expect(requests).toHaveLength(2);
  } finally {
    child?.kill();
    await closed;
    t3.closeAllConnections();
    await new Promise<void>((resolveClose) => t3.close(() => resolveClose()));
    await f.close();
  }
});

test("hub plan route allowlist accepts bounded read and image paths", () => {
  expect(artifactRequest("POST", "/v1/plans")).toBe(true);
  expect(artifactRequest("GET", `/v1/plans/cli-plan/images/${"a".repeat(64)}`)).toBe(true);
  expect(artifactRequest("GET", "/v1/plans/cli-plan/revisions/2/content")).toBe(true);
  for (const path of [
    "/v1/plans/cli-plan/revisions/0/content",
    "/v1/plans/cli-plan/revisions/2/content?x=1",
    "/v1/plans/../images/x",
    "/v1/plans/cli-plan/images/x",
  ])
    expect(artifactRequest("GET", path)).toBe(false);
});

test("Claude plan listener delivers every pending round after initialization", async () => {
  const f = await fixture();
  let restarted: Awaited<ReturnType<typeof startArtifactServer>> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<unknown> | undefined;
  try {
    const artifact = JSON.parse(
      (await f.cli("add", f.html, "--plan", "--name", "cli-plan")).stdout,
    );
    const roundIds: string[] = [];
    for (let index = 0; index < 33; index++) {
      const commentId = randomUUID();
      await f.client.plan({
        action: "comment",
        name: "cli-plan",
        requestId: commentId,
        revision: artifact.revision,
        page: "goal",
        text: `Feedback ${index}`,
        image: png,
        annotatedImage: png,
        annotations: [],
      });
      const roundId = randomUUID();
      await f.client.plan({
        action: "submit",
        name: "cli-plan",
        requestId: roundId,
        commentIds: [commentId],
      });
      roundIds.push(roundId);
    }
    child = spawn(process.execPath, [executable, "plan", "watch", "cli-plan", "--claude-channel"], {
      env: f.env,
      cwd: f.directory,
    });
    closed = once(child, "exit");
    let stdout = "";
    let diagnostics = "";
    child.stdout!.on("data", (data) => {
      stdout += data;
    });
    child.stderr!.on("data", (data) => {
      diagnostics += data;
    });
    child.stdin!.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
    );
    await expect.poll(() => stdout).toContain('"serverInfo"');
    expect(stdout).not.toContain("notifications/claude/channel");
    child.stdin!.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const notices = () =>
      stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((message) => message.method === "notifications/claude/channel");
    await expect.poll(() => notices().length).toBe(33);
    for (const id of roundIds)
      expect(notices().filter((message) => message.params.content.includes(id))).toHaveLength(1);
    await expect.poll(() => diagnostics).toContain("Listening");
    await f.server.close();
    restarted = await startArtifactServer({
      directory: f.directory,
      token: f.env.SCOPE_TOKEN,
      port: Number(new URL(f.server.url).port),
    });
    await expect.poll(() => diagnostics, { timeout: 5000 }).toContain("reconnecting");
    await delay(1300);
    expect(notices()).toHaveLength(33);
  } finally {
    child?.kill();
    await closed;
    await restarted?.close();
    await f.close();
  }
});
