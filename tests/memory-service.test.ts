import { afterEach, expect, test } from "vite-plus/test";
import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { MemoryService } from "../apps/desktop/src/memory.ts";
import type { Remotes, RemoteCall } from "../apps/desktop/src/remotes.ts";
import type { MemoryConfiguration, MemoryMachineStatus } from "@irudd-scope/protocol/memory";
import { memoryFixture, MEMORY_REPOSITORY } from "./memory-fixture.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(options: { installLater?: boolean } = {}) {
  const f = await memoryFixture(cleanup);
  const store = new DesktopStore(join(f.directory, "desktop"));
  await store.load();
  cleanup.push(() => store.close());
  const controller = new AbortController();
  const remote = {
    id: crypto.randomUUID(),
    name: "Remote",
    endpoint: "https://remote.example.test",
    enabled: true,
    connection: "connected" as const,
    message: "Connected.",
  };
  let configuration: MemoryConfiguration = { enabled: false, repository: null };
  let beforePut: (value: MemoryConfiguration) => Promise<void> = async () => {};
  let beforeSync: () => Promise<void> = async () => {};
  let conflict = false;
  let syncs = 0;
  let active = 0;
  let peak = 0;
  const status = (): MemoryMachineStatus => ({
    machine: "remote",
    repository: configuration.repository,
    phase: !configuration.enabled ? "off" : configuration.repository ? "synced" : "waiting",
    message: "Remote status.",
    bundle: configuration.enabled && configuration.repository ? "registered" : "unavailable",
    ...(configuration.enabled && configuration.repository ? { root: f.clone("hub") } : {}),
    okf: { installed: true, version: "0.1.0" },
    conflicts: conflict
      ? [
          {
            url: `https://github.com/${MEMORY_REPOSITORY}/pull/1`,
            title: "Memory conflict",
            branch: "memory-conflict/remote-test",
          },
        ]
      : [],
  });
  const call: RemoteCall = async (method, path, body) => {
    active++;
    peak = Math.max(active, peak);
    try {
      if (method === "PUT") {
        await beforePut(body as MemoryConfiguration);
        configuration = body as MemoryConfiguration;
      }
      if (path.endsWith("/sync")) {
        syncs++;
        await beforeSync();
      }
      return Response.json(status());
    } finally {
      active--;
    }
  };
  const remotes: Pick<Remotes, "snapshot" | "onSession"> = {
    snapshot: () => [remote],
    onSession: (listener) => {
      listener(remote, call, controller.signal);
      return () => controller.abort();
    },
  };
  const installBin = join(f.directory, "installed-bin");
  await mkdir(installBin);
  const env = f.env("mac", { okf: !options.installLater });
  env.PATH = `${installBin}${delimiter}${env.PATH}`;
  const service = new MemoryService(store, remotes, () => {}, {
    root: f.root("mac"),
    env,
    intervalMs: 60 * 60_000,
    remotePollMs: 20,
  });
  cleanup.push(() => service.close());
  await service.start();
  await expect.poll(() => service.snapshot().machines[1]?.status?.phase).toBe("off");
  return {
    ...f,
    store,
    service,
    configuration: () => configuration,
    peak: () => peak,
    syncs: () => syncs,
    beforePut: (work: typeof beforePut) => {
      beforePut = work;
    },
    beforeSync: (work: typeof beforeSync) => {
      beforeSync = work;
    },
    conflict: () => {
      conflict = true;
    },
    install: () =>
      writeFile(
        join(installBin, "irudd-okf"),
        `#!/usr/bin/env node\nawait import(${JSON.stringify(pathToFileURL(resolve("tests/fixtures/memory/bin/irudd-okf")).href)});\n`,
        { mode: 0o700 },
      ),
  };
}

test(
  "remote configuration updates are serialized and the final off choice wins",
  { tags: ["memory-syncs"] },
  async () => {
    const f = await fixture();
    await f.service.setEnabled(true);
    await f.service.connect(MEMORY_REPOSITORY);
    await f.service.setEnabled(false);
    let entered = false;
    const gate = Promise.withResolvers<void>();
    f.beforePut(async (configuration) => {
      if (configuration.enabled) {
        entered = true;
        await gate.promise;
      }
    });
    const enable = f.service.setEnabled(true);
    try {
      await expect.poll(() => entered).toBe(true);
      const disable = f.service.setEnabled(false);
      await expect.poll(() => f.service.snapshot().configuration.enabled).toBe(false);
      gate.resolve();
      await Promise.all([enable, disable]);
      expect(f.configuration().enabled).toBe(false);
      expect(f.peak()).toBe(1);
    } finally {
      gate.resolve();
    }
  },
);

test(
  "a failed remote off update is retried without waiting for reconnection",
  { tags: ["memory-syncs"] },
  async () => {
    const f = await fixture();
    await f.service.setEnabled(true);
    await f.service.connect(MEMORY_REPOSITORY);
    let failures = 0;
    f.beforePut(async (configuration) => {
      if (!configuration.enabled && failures++ === 0)
        throw new Error("Temporary connection failure");
    });
    await f.service.setEnabled(false);
    await expect.poll(() => f.configuration().enabled).toBe(false);
    expect(failures).toBeGreaterThan(1);
  },
);
