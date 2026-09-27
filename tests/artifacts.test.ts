import { afterEach, expect, test } from "vite-plus/test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";
import { startLocalArtifacts } from "../apps/desktop/src/library/local.ts";
import { startHub } from "../apps/hub/src/server.ts";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { MAX_CONTENT_BYTES, type LiveEvent } from "@irudd-scope/protocol";

const token = "synthetic-test-token-for-scope-only";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const exec = promisify(execFile);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope-artifacts-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const server = await startArtifactServer({ directory, token, port: 0 });
  cleanup.push(server.close);
  const client = new ScopeClient(server.url, token);
  const cli = (...args: string[]) =>
    exec(process.execPath, [resolve("packages/cli/dist/main.mjs"), ...args], {
      env: {
        ...process.env,
        SCOPE_ENDPOINT: server.url,
        SCOPE_TOKEN: token,
        SCOPE_TOKEN_FILE: undefined,
      },
      maxBuffer: 2 * 1024 * 1024,
    });
  return { directory, server, client, cli };
}

async function delayedArtifactServer(options: {
  getDelay?: number;
  uploadDelay?: number;
  updateDelay?: number;
  hangUpdateResponse?: boolean;
}) {
  const current = {
    id: "slow-update",
    title: "Before",
    kind: "text",
    blob: "a".repeat(64),
    fileName: "note.txt",
    mediaType: "text/plain",
    revision: 1,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    size: 6,
  };
  let updateReceived = false;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    request.resume();
    request.on("end", () => {
      const send = (value: unknown, delay = 0) => {
        setTimeout(() => {
          if (response.destroyed) return;
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(value));
        }, delay);
      };
      if (request.method === "GET" && path === "/v1/artifacts/slow-update") {
        send(current, options.getDelay);
      } else if (request.method === "POST" && path.endsWith("/tab")) {
        send({ tabId: "e13387ae-ae2e-4f15-8632-e00916600a13" });
      } else if (request.method === "POST" && path.endsWith("/blobs")) {
        send({ blob: "b".repeat(64) }, options.uploadDelay);
      } else if (request.method === "PUT" && path === "/v1/artifacts/slow-update") {
        updateReceived = true;
        const finish = () => {
          if (response.destroyed) return;
          response.writeHead(200, { "Content-Type": "application/json" });
          if (options.hangUpdateResponse) response.flushHeaders();
          else response.end(JSON.stringify({ ...current, revision: 2 }));
        };
        setTimeout(finish, options.updateDelay ?? 0);
      } else {
        response.writeHead(404);
        response.end();
      }
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address() as AddressInfo;
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    );
  });
  return { url: `http://127.0.0.1:${address.port}`, updateWasReceived: () => updateReceived };
}

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  return exec(process.execPath, [resolve("packages/cli/dist/main.mjs"), ...args], {
    cwd,
    env,
    maxBuffer: 2 * 1024 * 1024,
    timeout: 10_000,
  });
}

test("the real CLI publishes every supported kind, updates a stable ID, and data survives a storage restart", async () => {
  const { directory, server, client, cli } = await fixture();
  await cli("text", "A finding", "--title", "Review", "--id", "review");
  const samples = [
    ["review.md", "markdown", "# Review\nA useful finding"],
    ["preview.html", "html", "<h1>Preview</h1>"],
    ["screenshot.png", "image", "synthetic-image-bytes"],
    ["build.zip", "file", "synthetic-archive-bytes"],
  ];
  for (const [fileName, kind, body] of samples) {
    const file = join(directory, fileName);
    await writeFile(file, body);
    const { stdout } = await cli("add", file, "--id", kind);
    expect(JSON.parse(stdout).kind).toBe(kind);
    expect(new TextDecoder().decode(await client.content(kind))).toBe(body);
  }
  const replacement = join(directory, "updated.txt");
  await writeFile(replacement, "A corrected finding");
  await cli("update", "review", replacement);
  expect(await client.get("review")).toMatchObject({ id: "review", title: "Review", revision: 2 });
  cleanup.pop();
  await server.close();
  const restarted = await startArtifactServer({ directory, token, port: 0 });
  cleanup.push(restarted.close);
  const reopened = new ScopeClient(restarted.url, token);
  expect(await reopened.list()).toHaveLength(5);
  expect(new TextDecoder().decode(await reopened.content("review"))).toBe("A corrected finding");
});

test("live notifications announce publication and rejected concurrent updates preserve content", async () => {
  const { client, cli } = await fixture();
  const controller = new AbortController();
  const events: LiveEvent[] = [];
  const watching = client.watch((event) => events.push(event), controller.signal).catch(() => {});
  cleanup.push(async () => {
    controller.abort();
    await watching;
  });
  await expect.poll(() => events.some((event) => event.type === "ready")).toBe(true);
  await cli("text", "Original", "--id", "architecture");
  await expect
    .poll(() =>
      events.some((event) => event.type === "artifact" && event.artifact.id === "architecture"),
    )
    .toBe(true);
  const artifact = await client.get("architecture");
  const metadata = {
    title: artifact.title,
    kind: artifact.kind,
    fileName: artifact.fileName,
    mediaType: artifact.mediaType,
    expectedRevision: artifact.revision,
  };
  await client.publish(artifact.id, metadata, new TextEncoder().encode("New version"));
  await expect(
    client.publish(artifact.id, metadata, new TextEncoder().encode("Stale edit")),
  ).rejects.toMatchObject({ status: 409 });
  await expect(client.content(artifact.id, 1)).rejects.toMatchObject({ status: 409 });
  expect(new TextDecoder().decode(await client.content(artifact.id))).toBe("New version");
});

test("authentication, invalid metadata, and oversized content fail without creating artifacts", async () => {
  const { server, client, directory } = await fixture();
  expect((await fetch(`${server.url}/v1/artifacts`)).status).toBe(401);
  const headers = { Authorization: `Bearer ${token}` };
  expect(
    (
      await fetch(`${server.url}/v1/artifacts`, {
        headers: { ...headers, Origin: "https://untrusted.invalid" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${server.url}/v1/artifacts/bad`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ title: "Bad", blob: "../../file" }),
      })
    ).status,
  ).toBe(400);
  const reservation = await fetch(`${server.url}/v1/artifacts/oversized/tab`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedRevision: 0 }),
  }).then((response) => response.json());
  expect(
    (
      await fetch(`${server.url}/v1/tabs/${reservation.tabId}/blobs`, {
        method: "POST",
        headers,
        body: new Uint8Array(MAX_CONTENT_BYTES + 1),
      })
    ).status,
  ).toBe(413);
  expect(await client.list()).toEqual([]);
  const bytes = await readFile(join(directory, "scope.db"));
  expect(bytes.includes(Buffer.from(token))).toBe(false);
});

test("the optional hub forwards live publications and rejects unavailable desktops without replay", async () => {
  const { directory, server, client } = await fixture();
  const hub = await startHub({ endpoint: server.url, token, port: 0 });
  cleanup.push(hub.close);
  const forwarded = new ScopeClient(hub.url, token);
  expect((await fetch(`${hub.url}/v1/artifacts`)).status).toBe(401);
  expect(
    (
      await fetch(`${hub.url}/v1/artifacts`, {
        headers: { Authorization: `Bearer ${token}`, Origin: "https://untrusted.invalid" },
      })
    ).status,
  ).toBe(403);
  const controller = new AbortController();
  const events: LiveEvent[] = [];
  const watching = forwarded
    .watch((event) => events.push(event), controller.signal)
    .catch(() => {});
  cleanup.push(async () => {
    controller.abort();
    await watching;
  });
  await expect.poll(() => events.some((event) => event.type === "ready")).toBe(true);
  const metadata = {
    title: "Via hub",
    kind: "text",
    mediaType: "text/plain",
    fileName: "note.txt",
    expectedRevision: 0,
  };
  const bytes = new TextEncoder().encode("Stored on the Mac");
  await forwarded.publish("forwarded", metadata, bytes);
  await expect
    .poll(() =>
      events.some((event) => event.type === "artifact" && event.artifact.id === "forwarded"),
    )
    .toBe(true);
  expect(await client.content("forwarded")).toEqual(bytes);
  await expect(forwarded.publish("forwarded", metadata, bytes)).rejects.toMatchObject({
    status: 409,
  });
  controller.abort();
  await watching;
  await server.close();
  await expect(forwarded.publish("offline", metadata, bytes)).rejects.toMatchObject({
    status: 503,
  });
  const restarted = await startArtifactServer({
    directory,
    token,
    port: Number(new URL(server.url).port),
  });
  cleanup.push(restarted.close);
  expect((await forwarded.list()).map((artifact) => artifact.id)).toEqual(["forwarded"]);
  await forwarded.publish("after-restart", metadata, bytes);
  expect((await forwarded.list()).map((artifact) => artifact.id)).toEqual([
    "after-restart",
    "forwarded",
  ]);
});

test("the CLI never sends local discovery credentials to an explicitly selected endpoint", async () => {
  const { directory, server, client } = await fixture();
  const file = join(directory, "connection.json");
  await writeFile(file, JSON.stringify({ version: 1, endpoint: server.url, token }));
  const env = {
    ...process.env,
    SCOPE_CONNECTION_FILE: file,
    SCOPE_ENDPOINT: server.url,
    SCOPE_TOKEN: undefined,
    SCOPE_TOKEN_FILE: undefined,
  };
  await expect(
    exec(
      process.execPath,
      [resolve("packages/cli/dist/main.mjs"), "text", "Should fail", "--id", "unexpected"],
      { env },
    ),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("An explicit endpoint needs"),
  });
  expect(await client.list()).toEqual([]);
});

test("a failed local listener leaves the existing discovery file and library usable", async () => {
  const { directory, server, cli, client } = await fixture();
  await cli("text", "Original library", "--id", "original");
  const connectionFile = join(directory, "connection.json");
  const connection = JSON.stringify({ version: 1, endpoint: server.url, token });
  await writeFile(connectionFile, connection);
  await expect(
    startLocalArtifacts({
      directory: join(directory, "another-library"),
      connectionFile,
      port: Number(new URL(server.url).port),
    }),
  ).rejects.toMatchObject({ code: "EADDRINUSE" });
  expect(await readFile(connectionFile, "utf8")).toBe(connection);
  expect(new TextDecoder().decode(await client.content("original"))).toBe("Original library");
});

test("invalid CLI options fail before reading connection settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-cli-args-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const env = {
    ...process.env,
    SCOPE_CONNECTION_FILE: join(directory, "missing.json"),
    SCOPE_ENDPOINT: undefined,
    SCOPE_TOKEN: undefined,
    SCOPE_TOKEN_FILE: undefined,
  };
  await expect(runCli(["text", "hello", "--kind", "html"], env)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("Text accepts --kind text or markdown"),
  });
  await expect(runCli(["list", "--timeout-ms", "0"], env)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("--timeout-ms must be a whole number"),
  });
});

test("the CLI deadline aborts while reading the publication response body", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-cli-body-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const replacement = join(directory, "replacement.txt");
  await writeFile(replacement, "Replacement content");
  const server = await delayedArtifactServer({ hangUpdateResponse: true });
  const env = {
    ...process.env,
    SCOPE_ENDPOINT: server.url,
    SCOPE_TOKEN: token,
    SCOPE_TOKEN_FILE: undefined,
  };
  await expect(
    runCli(["update", "slow-update", replacement, "--timeout-ms", "1200"], env),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining(
      "Scope command timed out after 1200 ms. Artifact slow-update may have been published; read it before retrying.",
    ),
  });
  expect(server.updateWasReceived()).toBe(true);
});

test("the CLI timeout bounds an update across its read, upload, and publication requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-cli-budget-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const replacement = join(directory, "replacement.txt");
  await writeFile(replacement, "Replacement content");
  const gitDirectory = join(directory, "git");
  await mkdir(gitDirectory);
  const fastGit = join(gitDirectory, "git");
  await writeFile(fastGit, "#!/bin/sh\nexit 1\n");
  await chmod(fastGit, 0o755);
  const server = await delayedArtifactServer({
    getDelay: 600,
    uploadDelay: 600,
    updateDelay: 600,
  });
  const env = {
    ...process.env,
    PATH: `${gitDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    SCOPE_ENDPOINT: server.url,
    SCOPE_TOKEN: token,
    SCOPE_TOKEN_FILE: undefined,
  };
  await expect(
    runCli(["update", "slow-update", replacement, "--timeout-ms", "1700"], env),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("Scope command timed out after 1700 ms."),
  });
  expect(server.updateWasReceived()).toBe(true);
});

test("slow optional Git provenance is killed within its budget without blocking publication", async () => {
  const { directory, server } = await fixture();
  const gitDirectory = join(directory, "slow-git");
  await mkdir(gitDirectory);
  const gitPath = join(gitDirectory, "git");
  const pidFile = join(directory, "git-pids.txt");
  cleanup.push(async () => {
    let pids: number[] = [];
    try {
      pids = (await readFile(pidFile, "utf8")).trim().split("\n").map(Number);
    } catch {}
    for (const pid of pids) {
      if (!Number.isSafeInteger(pid) || pid < 1) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  });
  await writeFile(
    gitPath,
    "#!/bin/sh\n" +
      'if [ "$1" = "--fixture-ready" ]; then exit 0; fi\n' +
      'printf "%s\\n" "$$" >> "$SCOPE_TEST_GIT_PIDS"\n' +
      'exec "$SCOPE_TEST_NODE" -e \'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)\'\n',
  );
  await chmod(gitPath, 0o755);
  const env = {
    ...process.env,
    PATH: `${gitDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    SCOPE_ENDPOINT: server.url,
    SCOPE_TOKEN: token,
    SCOPE_TOKEN_FILE: undefined,
    SCOPE_TEST_GIT_PIDS: pidFile,
    SCOPE_TEST_NODE: process.execPath,
  };
  // Finish first-execution setup before measuring the command's Git budget.
  await exec(gitPath, ["--fixture-ready"], { env, timeout: 10_000 });
  const started = performance.now();
  const { stdout } = await runCli(["text", "Publishes without Git", "--id", "slow-git"], env);
  expect(JSON.parse(stdout)).toMatchObject({ id: "slow-git", revision: 1 });
  expect(performance.now() - started).toBeLessThan(3_000);
  const pids = (await readFile(pidFile, "utf8")).trim().split("\n").map(Number);
  expect(pids.length).toBeGreaterThan(0);
  for (const pid of pids) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      else throw error;
    }
    expect(alive).toBe(false);
  }
});

test("Git provenance preserves unborn and detached branches and omits Git fields outside a repository", async () => {
  const { directory, server, client } = await fixture();
  const unborn = join(directory, "unborn");
  const detached = join(directory, "detached");
  const noGit = join(directory, "no-git");
  await Promise.all([mkdir(unborn), mkdir(detached), mkdir(noGit)]);
  const [unbornPath, detachedPath, noGitPath] = await Promise.all([
    realpath(unborn),
    realpath(detached),
    realpath(noGit),
  ]);
  await exec("git", ["init", unborn], {});
  await exec("git", ["-C", detached, "init"], {});
  await writeFile(join(detached, "seed.txt"), "seed");
  await exec("git", ["-C", detached, "add", "seed.txt"], {});
  await exec(
    "git",
    [
      "-C",
      detached,
      "-c",
      "user.name=Scope Test",
      "-c",
      "user.email=scope@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "-c",
      `core.hooksPath=${join(directory, "empty-hooks")}`,
      "commit",
      "-m",
      "initial",
    ],
    {},
  );
  await exec("git", ["-C", detached, "checkout", "--detach"], {});
  const { stdout: unbornBranch } = await exec(
    "git",
    ["-C", unborn, "branch", "--show-current"],
    {},
  );
  expect(unbornBranch.trim()).not.toBe("");
  const env = {
    ...process.env,
    SCOPE_ENDPOINT: server.url,
    SCOPE_TOKEN: token,
    SCOPE_TOKEN_FILE: undefined,
  };
  await runCli(["text", "Unborn branch", "--id", "unborn-git"], env, unbornPath);
  await runCli(["text", "Detached HEAD", "--id", "detached-git"], env, detachedPath);
  await runCli(["text", "No Git", "--id", "no-git"], env, noGitPath);

  const unbornSource = (await client.get("unborn-git")).source;
  expect(unbornSource).toMatchObject({
    cwd: unbornPath,
    repo: unbornPath,
    worktree: unbornPath,
    branch: unbornBranch.trim(),
  });
  const detachedSource = (await client.get("detached-git")).source;
  expect(detachedSource).toMatchObject({
    cwd: detachedPath,
    repo: detachedPath,
    worktree: detachedPath,
  });
  expect(detachedSource).not.toHaveProperty("branch");
  const noGitSource = (await client.get("no-git")).source;
  expect(noGitSource).toMatchObject({ cwd: noGitPath });
  expect(noGitSource).not.toHaveProperty("repo");
  expect(noGitSource).not.toHaveProperty("branch");
  expect(noGitSource).not.toHaveProperty("worktree");
});
