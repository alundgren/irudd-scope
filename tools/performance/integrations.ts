import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Session, check, until } from "./session.ts";
import { pressureHub } from "../../tests/pressure-fixture.ts";
import type { Fixtures } from "./artifacts.ts";
import { desktopFixture } from "../../tests/desktop-fixture.ts";
import { rows } from "./report.ts";
import { MEMORY_REPOSITORY } from "../../tests/memory-fixture.ts";

export async function hubFixture(s: Session) {
  const directory = join(
    s.report.directory,
    "data",
    `hub-${process.env.SCOPE_PERFORMANCE_ATTEMPT ?? "0"}`,
  );
  await mkdir(directory);
  const hub = await pressureHub(directory);
  await s.run("pair-isolated-hub", "ipc", async () => {
    await s.page.evaluate((url) => window.scope.pairRemote(url), hub.pairingUrl);
    await until(
      () => s.page.evaluate(() => window.scope.remotes()),
      (remotes) => remotes.some((remote) => remote.connection === "connected"),
    );
  });
  return hub;
}
export async function relay(s: Session, hub: Awaited<ReturnType<typeof pressureHub>>) {
  s.feature = "publication.hub-offline-reconnect";
  const id = `perf-relay-${randomUUID()}`;
  const content = new TextEncoder().encode("Synthetic buffered performance content");
  const metadata = {
    title: "Performance relay",
    expectedRevision: 0,
    kind: "text",
    mediaType: "text/plain",
    fileName: "relay.txt",
  };
  const direct = await s.client();
  const remote = (await s.page.evaluate(() => window.scope.remotes()))[0];
  await s.run("live-hub-api", "api", async () =>
    check(
      (await hub.client.list()).some((item) => item.id === "perf-text"),
      "Hub not forwarding",
    ),
  );
  await s.run("disconnect-queue-reconnect-visible", "interaction", async () => {
    await s.page.evaluate((id) => window.scope.setRemoteEnabled(id, false), remote.id);
    const receipt = await hub.client.publishOrQueue(id, metadata, content);
    check("queued" in receipt && receipt.queued, "Offline publication not queued");
    await s.page.evaluate((id) => window.scope.setRemoteEnabled(id, true), remote.id);
    await until(
      () => hub.client.hubQueue(),
      (queue) => queue.items.length === 0,
    );
    check(Buffer.from(await direct.content(id)).equals(content), "Buffered bytes changed");
    await s.open("Performance relay");
    await s.page
      .getByRole("tabpanel", { name: "Performance relay" })
      .getByText("Synthetic buffered performance content", { exact: true })
      .waitFor();
  });
  await direct.delete(id);
  s.status(
    s.feature,
    "measured",
    "Real paired hub, explicit offline queue and reconnect delivery to visible Electron viewer; local loopback only",
  );
}
export async function settings(s: Session) {
  s.feature = "settings";
  await s.run("search-change-appearance", "interaction", async () => {
    await s.page.keyboard.press("ControlOrMeta+,");
    await s.page.getByLabel("Search settings").fill("appearance");
    const theme = s.page.getByLabel("Appearance", { exact: true });
    await theme.selectOption("dark");
    await until(
      () => s.page.locator("html").getAttribute("data-theme"),
      (value) => value === "dark",
    );
    await theme.selectOption("light");
    await until(
      () => s.page.locator("html").getAttribute("data-theme"),
      (value) => value === "light",
    );
    await s.page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
  });
  s.status(
    s.feature,
    "measured",
    "Visible settings search, persisted appearance and renderer theme update",
  );
}
export async function voice(s: Session) {
  s.feature = "voice.receipts-audio";
  await s.application.evaluate(() => {
    if (
      (globalThis as unknown as { performanceVoiceInstalled?: boolean }).performanceVoiceInstalled
    )
      return;
    Object.assign(globalThis, {
      performanceVoiceInstalled: true,
      performanceProviderIntervals: [],
    });
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const invokedAt = Date.now();
      const intervals = (
        globalThis as unknown as { performanceProviderIntervals: Record<string, unknown>[] }
      ).performanceProviderIntervals;
      const record = (stage: string) =>
        intervals.push({
          stage,
          invokedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - invokedAt,
        });
      const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (url === "https://openrouter.ai/api/v1/audio/speech") {
        record("speech");
        return new Response(new Uint8Array(4800), {
          headers: { "Content-Type": "audio/pcm", "X-Generation-Id": "gen-performance" },
        });
      }
      if (address.startsWith("https://openrouter.ai/api/v1/generation")) {
        record("billing");
        return Response.json({
          data: {
            id: "gen-performance",
            model: "google/gemini-3.8-flash-tts",
            provider_name: "Synthetic provider",
            total_cost: 0,
          },
        });
      }
      if (address.startsWith("https://openrouter.ai/"))
        throw new Error("Unsupported synthetic provider request");
      return original(url, init);
    };
  });
  await s.page.evaluate(() =>
    window.scope.saveSettings({
      voiceGenerationEnabled: true,
      apiKey: "synthetic-performance-key",
    }),
  );
  const client = await s.client();
  const id = `performance-voice-${randomUUID()}`;
  await s.run("submit-receipt-decode", "interaction", async () => {
    await client.submitVoice({ requestId: id, text: "Synthetic speech" });
    await until(
      () => client.voiceStatus(id),
      (receipt) => receipt.state === "succeeded",
    );
    const bytes = await client.voiceResult(id);
    const duration = await s.page.evaluate(async (data) => {
      const audio = new AudioContext();
      try {
        return (await audio.decodeAudioData(new Uint8Array(data).buffer)).duration;
      } finally {
        await audio.close();
      }
    }, Array.from(bytes));
    check(Math.abs(duration - 0.1) < 0.001, "Chromium audio decode duration differs");
    check(
      (await client.submitVoice({ requestId: id, text: "Synthetic speech" })).state === "succeeded",
      "Voice retry missing receipt",
    );
  });
  const intervals = await s.application.evaluate(() =>
    (
      globalThis as unknown as { performanceProviderIntervals: Record<string, unknown>[] }
    ).performanceProviderIntervals.splice(0),
  );
  for (const interval of intervals)
    s.report.event(
      "external-end",
      {
        tool: "synthetic-provider",
        native: false,
        feature: s.feature,
        phase: s.phase,
        workload: s.workload,
        operation: "submit-receipt-decode",
        ...interval,
      },
      "external.jsonl",
    );
  s.status(
    s.feature,
    "measured",
    "Real voice submission/status/result and Chromium WAV decode. Deterministic zero-delay synthetic provider; no live generation/audio hardware claim.",
  );
}
export async function memorySync(s: Session, f: Fixtures) {
  s.feature = "memory.sync";
  const client = await s.client();
  await s.run("connect-sync-local-git", "integration", async () => {
    await client.connectMemory(MEMORY_REPOSITORY);
    const initial = (await client.memory()).machines.find((machine) => machine.local)?.status
      ?.lastSyncAt;
    const completed = await s.page.evaluate(() => window.scope.retryMemory());
    const local = completed.machines.find((machine) => machine.local)?.status;
    check(
      local?.phase === "synced" && local.lastSyncAt && local.lastSyncAt !== initial,
      "Requested memory retry did not complete a new successful sync",
    );
    const context = JSON.parse(
      await readFile(join(s.report.directory, "data", "context.json"), "utf8"),
    ) as { id: string };
    await until(
      async () => {
        const external = rows(s.report.directory, "external.jsonl").filter(
          (row) => row.id === context.id,
        );
        const ended = new Set(
          external.filter((row) => row.type === "external-end").map((row) => row.externalId),
        );
        return external.filter((row) => row.type === "external-start" && !ended.has(row.externalId))
          .length;
      },
      (count) => count === 0,
    );
    await s.page.keyboard.press("ControlOrMeta+,");
    await s.page.getByLabel("Search settings").fill("memory sync");
    await s.page
      .getByRole("list", { name: "Memory sync by machine" })
      .getByText(/^Last sync /)
      .waitFor();
    await s.page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
  });
  await s.page.evaluate(() => window.scope.setMemorySyncEnabled(false));
  await client.librarian({ action: "local", root: f.root, initialize: false });
  s.status(
    s.feature,
    "measured",
    "Real sync queue/clone with local git and synthetic gh/OKF, external command intervals. No GitHub network or native upgrade performance claim.",
  );
}
export async function maintenance(s: Session, hub: Awaited<ReturnType<typeof pressureHub>>) {
  s.feature = "maintenance";
  const client = await s.client();
  await s.run("desktop-shrink-status", "api", async () => {
    await client.shrink(20_000);
    check(await client.maintenanceStatus(), "Missing desktop maintenance status");
  });
  await s.run("hub-shrink-status", "integration", () => hub.shrink());
  s.status(
    s.feature,
    "measured",
    "Real explicit SQLite shrink/status on synthetic desktop and paired hub databases; scheduled expiry clock advancement excluded.",
  );
}
export async function legacyRecovery(s: Session, f: Fixtures) {
  s.feature = "librarian.legacy-recovery";
  await s.close();
  const fixture = await desktopFixture({ env: f.env });
  const legacy = new Session(s.report, fixture);
  legacy.phase = s.phase;
  legacy.workload = s.workload;
  legacy.feature = s.feature;
  try {
    await legacy.launch();
    await (await legacy.client()).librarian({ action: "local", root: f.root, initialize: false });
    await legacy.page.evaluate(async () => {
      const workspace = (await window.scope.workspace())!;
      await window.scope.openTab({
        id: crypto.randomUUID(),
        groupId: workspace.groups[0].id,
        type: "memory",
        title: "Legacy performance memory",
        state: {
          version: 1,
          data: {
            mode: "graph",
            draft: {
              repository: "synthetic/personal-memory",
              path: "recovery.md",
              expectedHash: "a".repeat(64),
              raw: "# Synthetic retained draft\n",
            },
          },
        },
      });
    });
    await legacy.close();
    await legacy.run("migrate-open-copy-legacy", "interaction", async () => {
      await legacy.launch();
      await legacy.open("Librarian");
      await legacy.page
        .getByRole("list", { name: "Memory results", exact: true })
        .locator("button:enabled")
        .first()
        .waitFor();
      await legacy.page.locator('button[aria-label="Search memory"]:enabled').waitFor();
      await legacy.page.getByRole("button", { name: "Recovered draft", exact: true }).click();
      await legacy.page.getByRole("button", { name: "Copy recovered draft", exact: true }).click();
      check(
        (await legacy.application.evaluate(({ clipboard }) => clipboard.readText())).includes(
          "Synthetic retained draft",
        ),
        "Legacy draft not recovered",
      );
      const tab = (await legacy.page.evaluate(() => window.scope.workspace()))!.tabs.find(
        (tab) => tab.type === "memory",
      );
      check(tab?.state.version === 2, "Legacy memory tab was not migrated");
    });
    await legacy.sample("legacy-recovered");
    s.status(
      s.feature,
      "measured",
      "Isolated version-one imported tab migrates after restart and retains a copyable draft through real IPC",
    );
  } finally {
    await legacy.close();
    if (!s.stopping) await s.launch();
  }
}
