import { expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import type { RetroConfiguration } from "@irudd-scope/protocol/retro";

function configure(store: DesktopStore, configuration: RetroConfiguration) {
  return store.saveRetroConfiguration({
    action: "configure",
    requestId: randomUUID(),
    expectedVersion: configuration.version,
    configuration,
  });
}

test("retrospective machines follow pairing membership and reject manual or stale machine lists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-retro-machines-"));
  const store = new DesktopStore(directory);
  await store.load();
  try {
    const initial = await store.retroConfiguration();
    expect(initial.sources.map((source) => source.id)).toEqual(["local"]);
    const remote = {
      id: randomUUID(),
      name: "Synthetic remote",
      endpoint: "https://dev.example.test:8450",
      enabled: false,
    };
    await store.saveRemote(remote);
    const paired = await store.retroConfiguration();
    expect(paired.sources[1]).toMatchObject({
      id: remote.id,
      name: remote.name,
      included: true,
      sshAlias: null,
      location: { type: "remote", remoteId: remote.id, endpoint: remote.endpoint },
    });
    await expect(configure(store, initial)).rejects.toMatchObject({ status: 409 });
    await expect(
      configure(store, {
        ...paired,
        sources: [...paired.sources, { ...paired.sources[0], id: "unpaired" }],
      }),
    ).rejects.toMatchObject({ status: 409 });
    const saved = await configure(store, {
      ...paired,
      sources: paired.sources.map((source) =>
        source.id === remote.id
          ? {
              ...source,
              included: false,
              runtimes: ["claude"],
              runtimeRoots: { codex: null, claude: "/synthetic/claude" },
            }
          : source,
      ),
    });
    await store.saveRemote({ ...remote, name: "Renamed remote", enabled: true });
    const renamed = await store.retroConfiguration();
    expect(renamed.sources[1]).toMatchObject({
      id: remote.id,
      name: "Renamed remote",
      included: false,
      runtimes: ["claude"],
      runtimeRoots: { claude: "/synthetic/claude" },
    });
    await store.removeRemote(remote.id);
    expect((await store.retroConfiguration()).sources.map((source) => source.id)).toEqual([
      "local",
    ]);
    await expect(configure(store, saved)).rejects.toMatchObject({ status: 409 });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("existing local source IDs, preferences and destinations survive automatic machine discovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-retro-legacy-machines-"));
  let store = new DesktopStore(directory);
  await store.load();
  const initial = await store.retroConfiguration();
  await store.close();
  const legacy: RetroConfiguration = {
    ...initial,
    version: 5,
    sources: [
      {
        id: "saved-mac-id",
        name: "My Mac",
        sshAlias: null,
        included: false,
        runtimes: ["codex"],
        runtimeRoots: { codex: "/synthetic/codex", claude: null },
      },
      {
        id: "unpaired-server",
        name: "Unpaired server",
        sshAlias: "old-server",
        included: true,
        runtimes: ["claude"],
        runtimeRoots: { codex: null, claude: null },
      },
    ],
    memory: {
      enabled: true,
      destinations: [
        {
          id: "mac-rules",
          type: "instructions",
          scope: "operator",
          sourceId: "saved-mac-id",
          path: "/synthetic/AGENTS.md",
          available: true,
          verifiedAt: "2026-10-04T08:00:00.000Z",
        },
        {
          id: "server-rules",
          type: "instructions",
          scope: "operator",
          sourceId: "unpaired-server",
          path: "/synthetic/AGENTS.md",
          available: true,
          verifiedAt: "2026-10-04T08:00:00.000Z",
        },
      ],
    },
  };
  const db = new DatabaseSync(join(directory, "desktop.db"));
  db.prepare("INSERT INTO preferences(name, document) VALUES ('retro-configuration', ?)").run(
    JSON.stringify(legacy),
  );
  db.close();
  store = new DesktopStore(directory);
  await store.load();
  try {
    const discovered = await store.retroConfiguration();
    expect(discovered.version).toBe(5);
    expect(discovered.sources).toMatchObject([
      {
        id: "saved-mac-id",
        name: "This machine",
        included: false,
        runtimes: ["codex"],
        runtimeRoots: { codex: "/synthetic/codex" },
        location: { type: "desktop" },
      },
    ]);
    expect(discovered.memory.destinations.map((destination) => destination.id)).toEqual([
      "mac-rules",
    ]);
    const saved = await configure(store, {
      ...discovered,
      sources: discovered.sources.map(({ location: _location, ...source }) => ({
        ...source,
        sshAlias: "mac-access",
      })),
    });
    expect(saved.sources[0]).toMatchObject({
      id: "saved-mac-id",
      sshAlias: null,
      location: { type: "desktop" },
    });
    await store.close();
    store = new DesktopStore(directory);
    await store.load();
    expect((await store.retroConfiguration()).sources[0].id).toBe("saved-mac-id");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("saving retrospective preferences while memory sync is off preserves hidden OKF destinations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-retro-memory-"));
  const store = new DesktopStore(directory);
  await store.load();
  try {
    await store.saveMemory({ configuration: { enabled: true, repository: null } });
    const initial = await store.retroConfiguration();
    const destination = {
      id: "my-existing-okf",
      type: "okf" as const,
      scope: "operator" as const,
      sourceId: initial.sources[0].id,
      path: "/synthetic/my-memory",
      available: true,
      verifiedAt: "2026-10-04T08:00:00.000Z",
    };
    await configure(store, { ...initial, memory: { enabled: true, destinations: [destination] } });
    await store.saveMemory({ configuration: { enabled: false, repository: null } });
    const hidden = await store.retroConfiguration();
    expect(hidden.memory.destinations).toEqual([]);
    const saved = await configure(store, {
      ...hidden,
      sources: hidden.sources.map((source) => ({ ...source, included: false })),
      memory: { ...hidden.memory, enabled: false },
    });
    expect(saved.memory.destinations).toEqual([]);
    await store.saveMemory({ configuration: { enabled: true, repository: null } });
    const restored = await store.retroConfiguration();
    expect(restored.memory.destinations).toEqual([destination]);
    expect(restored.sources[0].included).toBe(false);
    expect(restored.memory.enabled).toBe(false);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
