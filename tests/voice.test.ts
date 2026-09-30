import { afterEach, expect, test, vi } from "vite-plus/test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { decodeLocalConnection } from "@irudd-scope/protocol";
import { VOICE_LIFETIME_MS, MAX_VOICE_AUDIO_BYTES, VoiceGuide } from "@irudd-scope/protocol/voice";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { memoryCredentials } from "../apps/desktop/src/credentials.ts";
import { VoiceService } from "../apps/desktop/src/voice/service.ts";
import { voiceProvider } from "../apps/desktop/src/voice/openrouter.ts";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";
import { HubState } from "../apps/hub/src/state.ts";
import { startPairedHub } from "../apps/hub/src/paired-server.ts";
import { Remotes } from "../apps/desktop/src/remotes.ts";

const exec = promisify(execFile);
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope-voice-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  let billingCalls = 0;
  let billed = false;
  let actualProvider: string | null = "Google AI Studio";
  const releases: (() => void)[] = [];
  const requests: Record<string, unknown>[] = [];
  const provider = createServer(async (request, response) => {
    if (request.url?.startsWith("/api/v1/generation")) {
      billingCalls++;
      response.writeHead(billed ? 200 : 404, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(
          billed
            ? {
                data: {
                  id: new URL(request.url, "http://localhost").searchParams.get("id"),
                  model: "google/gemini-3.8-flash-tts-20260922",
                  provider_name: actualProvider,
                  total_cost: 0.001234,
                  tokens_prompt: 50,
                },
              }
            : { error: "pending" },
        ),
      );
      return;
    }
    calls++;
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString());
    requests.push(body);
    if (body.input.startsWith("hold"))
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    if (response.destroyed) return;
    response.setHeader("X-Generation-Id", `gen-tts-${calls}`);
    if (body.input === "error") {
      response.writeHead(429, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "synthetic" }));
    } else if (body.input === "bad-format") {
      response.writeHead(200, { "Content-Type": "audio/mpeg" });
      response.end("not pcm");
    } else if (body.input === "odd") {
      response.writeHead(200, { "Content-Type": "audio/pcm" });
      response.end(Buffer.alloc(3));
    } else if (body.input === "large") {
      response.writeHead(200, { "Content-Type": "audio/pcm" });
      response.end(Buffer.alloc(MAX_VOICE_AUDIO_BYTES));
    } else {
      response.writeHead(200, { "Content-Type": "audio/pcm;rate=24000;channels=1" });
      const pcm = Buffer.alloc(4800);
      for (let i = 0; i < 2400; i++) pcm.writeInt16LE(Math.round(1000 * Math.sin(i / 10)), i * 2);
      response.end(pcm);
    }
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Missing provider port.");
  const providerUrl = `http://127.0.0.1:${address.port}`;
  cleanup.push(async () => {
    for (const release of releases.splice(0)) release();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  });
  const credentials = memoryCredentials();
  let store = new DesktopStore(join(directory, "desktop"), credentials);
  await store.load();
  await store.saveSettings({ voiceGenerationEnabled: true, apiKey: "synthetic-shared-key" });
  cleanup.push(() => store.close());
  const external = voiceProvider((url, init) =>
    fetch(
      (url instanceof Request ? url.url : url.toString()).replace(
        "https://openrouter.ai",
        providerUrl,
      ),
      init,
    ),
  );
  let voice = new VoiceService(store, external);
  await voice.start();
  cleanup.push(() => voice.close());
  const token = "synthetic-speech-publishing-token";
  let desktop = await startArtifactServer({
    directory: join(directory, "artifacts"),
    token,
    port: 0,
    voice,
  });
  cleanup.push(() => desktop.close());
  let client = new ScopeClient(desktop.url, token);
  const cli = (endpoint: string, bearer: string, ...args: string[]) =>
    exec(process.execPath, [resolve("packages/cli/dist/main.mjs"), "voice", ...args], {
      env: {
        ...process.env,
        SCOPE_ENDPOINT: endpoint,
        SCOPE_TOKEN: bearer,
        SCOPE_TOKEN_FILE: undefined,
      },
      maxBuffer: 1024 * 1024,
    });
  return {
    directory,
    token,
    requests,
    credentials,
    cli,
    providerUrl,
    get store() {
      return store;
    },
    get voice() {
      return voice;
    },
    get desktop() {
      return desktop;
    },
    get client() {
      return client;
    },
    get calls() {
      return calls;
    },
    get billingCalls() {
      return billingCalls;
    },
    bill: (providerName: string | null = "Google AI Studio") => {
      billed = true;
      actualProvider = providerName;
    },
    release: () => {
      for (const release of releases.splice(0)) release();
    },
    restart: async () => {
      for (const release of releases.splice(0)) release();
      await desktop.close();
      await voice.close();
      await store.close();
      store = new DesktopStore(join(directory, "desktop"), credentials);
      await store.load();
      voice = new VoiceService(store, external);
      await voice.start();
      desktop = await startArtifactServer({
        directory: join(directory, "artifacts"),
        token,
        port: 0,
        voice,
      });
      client = new ScopeClient(desktop.url, token);
    },
  };
}

async function finished(client: ScopeClient, id: string) {
  await expect.poll(async () => (await client.voiceStatus(id)).state).not.toBe("generating");
  return client.voiceStatus(id);
}

test("default and blank styles send Aoede/C, with conflicting voice reuse rejected", async () => {
  const f = await fixture();
  for (const [requestId, instructions] of [
    ["default", undefined],
    ["blank", "  "],
  ] as const) {
    await f.client.submitVoice({
      requestId,
      text: "Thinking this through.",
      ...(instructions === undefined ? {} : { instructions }),
    });
    expect(await finished(f.client, requestId)).toMatchObject({
      voice: "Aoede",
      state: "succeeded",
    });
    expect(f.requests.at(-1)).toMatchObject({
      voice: "Aoede",
      provider: {
        options: {
          "google-ai-studio": { speech_metadata: { style: VoiceGuide.styles.solo.instructions } },
        },
      },
    });
  }
  await expect(
    f.client.submitVoice({ requestId: "default", text: "Thinking this through.", voice: "Kore" }),
  ).rejects.toMatchObject({ status: 409 });
  await f.client.submitVoice({
    requestId: "explicit-kore",
    text: "An explicit choice.",
    voice: "Kore",
    instructions: "Quiet",
  });
  await finished(f.client, "explicit-kore");
  await expect(
    f.client.submitVoice({
      requestId: "explicit-kore",
      text: "An explicit choice.",
      instructions: "Quiet",
    }),
  ).rejects.toMatchObject({ status: 409 });
  await f.restart();
  expect(
    (await f.client.submitVoice({ requestId: "default", text: "Thinking this through." })).voice,
  ).toBe("Aoede");
  expect(f.calls).toBe(3);
});

for (const state of ["succeeded", "generating"] as const) {
  test(`old Kore ${state} records recover omitted settings after restart without another call`, async () => {
    const f = await fixture();
    await f.client.submitVoice({ requestId: "seed", text: "Original narration.", voice: "Kore" });
    const seed = await finished(f.client, "seed");
    const receipt = { ...seed, requestId: "legacy", state };
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          text: "Original narration.",
          instructions: "",
          voice: "Kore",
          model: seed.requestedModel,
        }),
      )
      .digest("hex");
    const audio =
      state === "succeeded" ? Buffer.from(await f.client.voiceResult("seed")) : undefined;
    await f.store.saveVoice(
      "legacy",
      hash,
      Date.parse(receipt.expiresAt),
      JSON.stringify(receipt),
      audio,
    );
    await f.restart();
    for (const voice of [undefined, "Kore"] as const) {
      expect(
        await f.client.submitVoice({
          requestId: "legacy",
          text: "Original narration.",
          ...(voice ? { voice } : {}),
        }),
      ).toMatchObject({
        voice: "Kore",
        state: state === "generating" ? "interrupted" : "succeeded",
      });
    }
    if (audio) expect(await f.client.voiceResult("legacy")).toEqual(new Uint8Array(audio));
    await expect(
      f.client.submitVoice({ requestId: "legacy", text: "Original narration.", voice: "Aoede" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      f.client.submitVoice({ requestId: "legacy", text: "Changed narration." }),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.calls).toBe(1);
  });
}

test("built CLI generates E roles and the skill helper preserves PCM with a 180 ms turn gap", async () => {
  const f = await fixture();
  const guide = JSON.parse((await f.cli(f.desktop.url, f.token, "guide")).stdout);
  const paths: string[] = [];
  for (const [index, role] of [
    guide.styles.conversation.primary,
    guide.styles.conversation.secondary,
  ].entries()) {
    const text = join(f.directory, `turn-${index}.txt`);
    const audio = join(f.directory, `turn-${index}.wav`);
    await writeFile(text, index ? "What changes for us?" : "This could be useful.");
    await f.cli(
      f.desktop.url,
      f.token,
      "generate",
      text,
      "--request-id",
      `turn-${index}`,
      "--voice",
      role.voice,
      "--instructions",
      role.instructions,
      "--output",
      audio,
    );
    expect(f.requests.at(-1)).toMatchObject({
      voice: role.voice,
      provider: {
        options: { "google-ai-studio": { speech_metadata: { style: role.instructions } } },
      },
    });
    paths.push(audio);
  }
  expect(guide.styles.conversation.primary.voice).toBe("Aoede");
  expect(guide.styles.conversation.secondary.voice).toBe("Leda");
  const output = join(f.directory, "conversation.wav");
  const helper = resolve(".agents/skills/irudd-scope/scripts/join-wav.py");
  await exec("python3", [helper, output, ...paths]);
  const [joined, first, second] = await Promise.all(
    [output, ...paths].map((path) => readFile(path)),
  );
  expect(joined.subarray(44)).toEqual(
    Buffer.concat([first.subarray(44), Buffer.alloc(8640), second.subarray(44)]),
  );
  expect(joined.readUInt32LE(40)).toBe(joined.length - 44);
  await expect(exec("python3", [helper, output, ...paths])).rejects.toMatchObject({ code: 1 });
  expect(await readFile(output)).toEqual(joined);
  const truncated = join(f.directory, "truncated.wav");
  await writeFile(truncated, first.subarray(0, first.length - 2));
  const badOutput = join(f.directory, "bad.wav");
  await expect(exec("python3", [helper, badOutput, truncated])).rejects.toMatchObject({ code: 2 });
  await expect(readFile(badOutput)).rejects.toMatchObject({ code: "ENOENT" });
  const text = join(f.directory, "invalid.txt");
  await writeFile(text, "No provider call.");
  await expect(
    f.cli(f.desktop.url, f.token, "generate", text, "--voice", "Unknown", "--output", badOutput),
  ).rejects.toMatchObject({ code: 1 });
  expect(f.calls).toBe(2);
});

test("built CLI exports playable WAV and a receipt, then refreshes delayed actual billing without speech", async () => {
  const f = await fixture();
  const text = join(f.directory, "narration.txt");
  const audio = join(f.directory, "narration.wav");
  const receipt = join(f.directory, "receipt.json");
  await writeFile(text, "Hello from the agent.");
  const generated = await f.cli(
    f.desktop.url,
    f.token,
    "generate",
    text,
    "--request-id",
    "narration",
    "--instructions",
    "warm and friendly",
    "--output",
    audio,
    "--receipt",
    receipt,
  );
  expect(generated.stderr).toContain("Speech request ID: narration");
  const result = JSON.parse(generated.stdout);
  expect(result).toMatchObject({
    requestId: "narration",
    state: "succeeded",
    audioFormat: "wav",
    mediaType: "audio/wav",
    durationSeconds: 0.1,
    generationId: "gen-tts-1",
    costUsd: null,
    billingStatus: "pending",
  });
  const bytes = await readFile(audio);
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
  expect(bytes.readUInt16LE(20)).toBe(1);
  expect(bytes.readUInt16LE(22)).toBe(1);
  expect(bytes.readUInt32LE(24)).toBe(24000);
  expect(bytes.readUInt16LE(34)).toBe(16);
  expect(bytes.readUInt32LE(40)).toBe(bytes.length - 44);
  expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual(result);
  expect(f.requests).toEqual([
    {
      model: "google/gemini-3.8-flash-tts",
      input: "Hello from the agent.",
      voice: "Aoede",
      response_format: "pcm",
      provider: {
        order: ["google-ai-studio"],
        allow_fallbacks: false,
        options: { "google-ai-studio": { speech_metadata: { style: "warm and friendly" } } },
      },
    },
  ]);
  await expect.poll(() => f.billingCalls).toBe(1);
  f.bill();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 6000);
  await f.cli(f.desktop.url, f.token, "status", "narration", "--refresh-billing");
  await expect
    .poll(async () => (await f.client.voiceStatus("narration")).billingStatus)
    .toBe("known");
  const status = await f.cli(f.desktop.url, f.token, "status", "narration", "--receipt", receipt);
  expect(JSON.parse(status.stdout)).toMatchObject({
    costUsd: 0.001234,
    model: "google/gemini-3.8-flash-tts-20260922",
    provider: "Google AI Studio",
    billingStatus: "known",
  });
  await f.cli(
    f.desktop.url,
    f.token,
    "result",
    "narration",
    "--output",
    join(f.directory, "second.wav"),
  );
  expect(f.calls).toBe(1);
  await f.restart();
  expect(await f.client.voiceResult("narration")).toEqual(new Uint8Array(bytes));
  expect(
    (
      await f.client.submitVoice({
        requestId: "narration",
        text: "Hello from the agent.",
        instructions: "warm and friendly",
      })
    ).state,
  ).toBe("succeeded");
  expect(f.calls).toBe(1);
});

test("lost submission response, duplicate IDs and canceled requests never make another paid call", async () => {
  const f = await fixture();
  const proxy = createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on("data", (part) => parts.push(part));
    request.on("end", async () => {
      await fetch(`${f.desktop.url}/v1/voice`, {
        method: "POST",
        headers: { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" },
        body: Buffer.concat(parts),
      });
      response.destroy();
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Missing port.");
  await expect(
    new ScopeClient(`http://127.0.0.1:${address.port}`, f.token).submitVoice({
      requestId: "lost",
      text: "hold",
    }),
  ).rejects.toThrow("Cannot reach");
  await expect.poll(() => f.calls).toBe(1);
  const duplicates = await Promise.all(
    Array.from({ length: 8 }, () =>
      f.client.submitVoice({ requestId: "lost", text: "hold", voice: "Aoede" }),
    ),
  );
  expect(duplicates.every((receipt) => receipt.state === "generating")).toBe(true);
  await expect(
    f.client.submitVoice({ requestId: "lost", text: "different" }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(f.client.voiceResult("lost")).rejects.toMatchObject({ status: 409 });
  expect((await f.client.cancelVoice("lost")).state).toBe("canceled");
  f.release();
  expect((await f.client.submitVoice({ requestId: "lost", text: "hold" })).state).toBe("canceled");
  expect(f.calls).toBe(1);
});

test("actual cost is retained when provider metadata is null and later refresh supplies its name", async () => {
  const f = await fixture();
  f.bill(null);
  await f.client.submitVoice({ requestId: "metadata", text: "Hello" });
  await finished(f.client, "metadata");
  await expect
    .poll(async () => (await f.client.voiceStatus("metadata")).billingStatus)
    .toBe("known");
  expect(await f.client.voiceStatus("metadata")).toMatchObject({
    costUsd: 0.001234,
    model: "google/gemini-3.8-flash-tts-20260922",
    provider: null,
  });
  f.bill();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 6000);
  await f.client.refreshVoiceBilling("metadata");
  await expect
    .poll(async () => (await f.client.voiceStatus("metadata")).provider)
    .toBe("Google AI Studio");
  expect(f.calls).toBe(1);
});

test("CLI timeout leaves generation running and recovers the result using its recorded ID", async () => {
  const f = await fixture();
  const text = join(f.directory, "hold.txt");
  await writeFile(text, "hold");
  const command = f.cli(
    f.desktop.url,
    f.token,
    "generate",
    text,
    "--request-id",
    "timeout",
    "--output",
    join(f.directory, "timed.wav"),
    "--timeout-ms",
    "1000",
  );
  await expect.poll(() => f.calls).toBe(1);
  await expect(command).rejects.toMatchObject({
    stderr: expect.stringContaining("voice status timeout"),
  });
  expect((await f.client.voiceStatus("timeout")).state).toBe("generating");
  f.release();
  await finished(f.client, "timeout");
  await f.cli(
    f.desktop.url,
    f.token,
    "result",
    "timeout",
    "--output",
    join(f.directory, "recovered.wav"),
  );
  expect(f.calls).toBe(1);
});

test("cancellation still aborts local provider work if saving its receipt fails", async () => {
  const f = await fixture();
  await f.client.submitVoice({ requestId: "cancel-save", text: "hold" });
  await expect.poll(() => f.calls).toBe(1);
  vi.spyOn(f.store, "saveVoice").mockRejectedValueOnce(new Error("Synthetic database failure"));
  await expect(f.client.cancelVoice("cancel-save")).rejects.toMatchObject({ status: 500 });
  await expect
    .poll(async () => (await f.client.voiceStatus("cancel-save")).elapsedGenerationMs)
    .not.toBeNull();
  expect((await f.client.voiceStatus("cancel-save")).state).toBe("canceled");
  f.release();
  expect((await f.client.submitVoice({ requestId: "cancel-save", text: "hold" })).state).toBe(
    "canceled",
  );
  expect(f.calls).toBe(1);
});

test("expiry during generation cannot overwrite a reused request ID or restore expired rows", async () => {
  const f = await fixture();
  await f.client.submitVoice({ requestId: "reuse", text: "hold" });
  await expect.poll(() => f.calls).toBe(1);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + VOICE_LIFETIME_MS + 1);
  await f.client.submitVoice({ requestId: "reuse", text: "New narration" });
  f.release();
  expect(await finished(f.client, "reuse")).toMatchObject({
    state: "succeeded",
    generationId: "gen-tts-2",
  });
  expect((await f.client.voiceResult("reuse")).byteLength).toBe(4844);
  const rows = await f.store.voiceRows();
  expect(rows).toHaveLength(1);
  expect(JSON.parse(rows[0].receipt)).toMatchObject({
    state: "succeeded",
    generationId: "gen-tts-2",
  });
  await f.restart();
  expect((await f.client.voiceStatus("reuse")).state).toBe("succeeded");
  expect((await f.client.submitVoice({ requestId: "reuse", text: "New narration" })).state).toBe(
    "succeeded",
  );
  expect(f.calls).toBe(2);
});

test("paired hub uses short requests and recovers speech after relay disconnection", async () => {
  const f = await fixture();
  const state = await HubState.open(join(f.directory, "hub"));
  cleanup.push(() => state.close());
  const connectionFile = join(f.directory, "hub-connection.json");
  await state.configure({ endpoint: "http://127.0.0.1:1", port: 1, connectionFile });
  const hub = await startPairedHub(state, 0);
  cleanup.push(hub.close);
  await state.configure({ endpoint: hub.url, port: Number(new URL(hub.url).port), connectionFile });
  const local = decodeLocalConnection(JSON.parse(await readFile(connectionFile, "utf8")));
  const remotes = new Remotes(f.store, { url: f.desktop.url, token: f.token }, () => {});
  cleanup.push(() => remotes.close());
  await remotes.start();
  await remotes.pair(state.pairUrl());
  await expect.poll(() => remotes.snapshot()[0]?.connection).toBe("connected");
  const client = new ScopeClient(hub.url, local.token);
  expect((await client.submitVoice({ requestId: "remote", text: "hold" })).state).toBe(
    "generating",
  );
  await expect.poll(() => f.calls).toBe(1);
  await remotes.setEnabled(remotes.snapshot()[0].id, false);
  await expect(client.voiceStatus("remote")).rejects.toMatchObject({ status: 503 });
  f.release();
  await finished(f.client, "remote");
  await remotes.setEnabled(remotes.snapshot()[0].id, true);
  await expect.poll(() => remotes.snapshot()[0].connection).toBe("connected");
  const output = join(f.directory, "remote.wav");
  await f.cli(hub.url, local.token, "result", "remote", "--output", output);
  expect((await readFile(output)).toString("ascii", 0, 4)).toBe("RIFF");
  expect((await client.submitVoice({ requestId: "remote", text: "hold" })).state).toBe("succeeded");
  expect(f.calls).toBe(1);
  for (const [method, path] of [
    ["POST", "/v1/voice"],
    ["GET", "/v1/voice/remote"],
    ["GET", "/v1/voice/remote/result"],
    ["POST", "/v1/voice/remote/billing"],
    ["DELETE", "/v1/voice/remote"],
  ]) {
    expect(
      (await fetch(`${hub.url}${path}`, { method, headers: { Authorization: "Bearer invalid" } }))
        .status,
    ).toBe(401);
    expect(
      (
        await fetch(`${hub.url}${path}`, {
          method,
          headers: { Authorization: `Bearer ${local.token}`, Origin: "https://example.invalid" },
        })
      ).status,
    ).toBe(403);
  }
  expect(
    (
      await fetch(`${hub.url}/v1/voice/remote?anything=1`, {
        headers: { Authorization: `Bearer ${local.token}` },
      })
    ).status,
  ).toBe(404);
});

test.for(["error", "bad-format", "odd", "large"])(
  "provider failure %s retains its ID and never retries",
  async (text) => {
    const f = await fixture();
    await f.client.submitVoice({ requestId: text, text });
    expect(await finished(f.client, text)).toMatchObject({ state: "failed", costUsd: null });
    await f.client.submitVoice({ requestId: text, text });
    await expect(f.client.voiceResult(text)).rejects.toMatchObject({ status: 409 });
    expect(f.calls).toBe(1);
  },
);

test("speech keeps concurrency and expiry limits without a retained request count limit", async () => {
  const f = await fixture();
  await f.store.saveSettings({ voiceGenerationEnabled: false, diagramGenerationEnabled: true });
  await expect(f.client.submitVoice({ requestId: "off", text: "Hello" })).rejects.toMatchObject({
    status: 403,
  });
  await f.store.saveSettings({ voiceGenerationEnabled: true, diagramGenerationEnabled: false });
  expect((await f.credentials.read()).apiKey).toBe("synthetic-shared-key");
  await expect(
    f.client.submitVoice({ requestId: "too-big", text: "界".repeat(6000) }),
  ).rejects.toMatchObject({ status: 413 });
  await expect(f.client.submitVoice({ requestId: "empty", text: " " })).rejects.toMatchObject({
    status: 400,
  });
  await f.client.submitVoice({ requestId: "one", text: "hold" });
  await expect.poll(() => f.calls).toBe(1);
  await f.client.submitVoice({ requestId: "two", text: "hold-second" });
  await expect.poll(() => f.calls).toBe(2);
  await expect(f.client.submitVoice({ requestId: "three", text: "Hello" })).rejects.toMatchObject({
    status: 429,
  });
  f.release();
  await finished(f.client, "one");
  await finished(f.client, "two");
  for (let i = 2; i < 20; i++) {
    const id = `retained-${i}`;
    await f.client.submitVoice({ requestId: id, text: "Hello" });
    expect((await finished(f.client, id)).state).toBe("succeeded");
  }
  expect((await f.store.voiceRows()).length).toBe(20);
  const firstAudio = await f.client.voiceResult("one");
  await f.restart();
  expect(await f.client.voiceResult("one")).toEqual(firstAudio);
  expect((await f.client.submitVoice({ requestId: "one", text: "hold" })).state).toBe("succeeded");
  expect(f.calls).toBe(20);
  await f.client.submitVoice({ requestId: "after-restart", text: "Hello" });
  expect((await finished(f.client, "after-restart")).state).toBe("succeeded");
  expect((await f.client.voiceResult("after-restart")).byteLength).toBeGreaterThan(44);
  expect((await f.store.voiceRows()).length).toBe(21);
  const calls = f.calls;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + VOICE_LIFETIME_MS + 1);
  await expect(f.client.voiceStatus("one")).rejects.toMatchObject({ status: 404 });
  await f.client.submitVoice({ requestId: "after-expiry", text: "Hello" });
  await finished(f.client, "after-expiry");
  expect((await f.store.voiceRows()).length).toBe(1);
  expect(f.calls).toBe(calls + 1);
});
