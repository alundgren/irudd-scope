import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { MemorySync, defaultMemoryRoot } from "@irudd-scope/memory-sync";
import { ScopeError, decode } from "@irudd-scope/protocol";
import {
  MemoryMachineStatus,
  MemoryRepository,
  type MemoryConfiguration,
  type MemoryMachine,
  type MemoryStatus,
} from "@irudd-scope/protocol/memory";
import { readRemoteJson } from "@irudd-scope/protocol/remote";
import type { DesktopStore } from "./desktop-store.ts";
import type { RemoteCall, Remotes } from "./remotes.ts";
import { LOCAL_MEMORY_MACHINE, type MemoryPreferences } from "./memory-contract.ts";

const REMOTE_POLL_MS = 60_000;

type RemoteMemory = { call?: RemoteCall; status?: MemoryMachineStatus; message?: string };

/** Owns the Mac's memory sync and distributes the configuration to paired hubs. */
export class MemoryService {
  private readonly sync: MemorySync;
  private readonly remoteMemory = new Map<string, RemoteMemory>();
  private preferences?: MemoryPreferences;
  private okfInstalled = false;
  private stopSessions?: () => void;

  constructor(
    private readonly store: DesktopStore,
    private readonly remotes: Remotes,
    private readonly onChange: (status: MemoryStatus) => void,
    options: { root?: string; env?: NodeJS.ProcessEnv; intervalMs?: number } = {},
  ) {
    this.sync = new MemorySync({
      root: options.root ?? defaultMemoryRoot(options.env),
      machine: hostname(),
      env: options.env,
      intervalMs: options.intervalMs,
      onChange: (status) => {
        void this.observe(LOCAL_MEMORY_MACHINE, status);
        this.changed();
      },
    });
  }

  async start() {
    this.preferences = await this.store.memory();
    this.stopSessions = this.remotes.onSession(
      (remote, call, signal) => void this.watchRemote(remote.id, call, signal),
    );
    this.okfInstalled = await this.sync.checkOkf();
    this.sync.configure(this.configuration());
    this.changed();
  }

  private configuration(): MemoryConfiguration {
    const { enabled = false, repository = null } = this.preferences ?? {};
    return { enabled, repository };
  }

  snapshot(): MemoryStatus {
    const local: MemoryMachine = {
      id: LOCAL_MEMORY_MACHINE,
      name: hostname().slice(0, 160) || "This Mac",
      local: true,
      status: this.sync.status(),
    };
    const machines = [
      local,
      ...this.remotes.snapshot().map((remote): MemoryMachine => {
        const memory = this.remoteMemory.get(remote.id);
        return {
          id: remote.id,
          name: remote.name,
          local: false,
          ...(memory?.status ? { status: memory.status } : {}),
          ...(memory?.message || !memory?.call
            ? { message: memory?.message ?? "Not connected. Memory syncs on its own when online." }
            : {}),
        };
      }),
    ];
    return {
      configuration: this.configuration(),
      machines,
      conflicts: this.configuration().enabled ? this.sync.status().conflicts : [],
      okfInstalled: this.okfInstalled,
    };
  }

  private changed() {
    this.onChange(this.snapshot());
  }

  /** Text the operator pastes into their coding agent. */
  agentRequest(kind: "create" | "conflicts") {
    if (kind === "create")
      return "Set up my Scope memory repository. Use the irudd-scope skill's memory reference: suggest personal-memory under my GitHub account, wait for my approval, create it as a private repository, initialize the irudd-okf bundle, push it, and connect it with irudd-scope memory connect.";
    const conflicts = this.sync.status().conflicts;
    return [
      "Resolve my Scope memory sync conflicts. Use the irudd-scope skill's memory reference and resolve each pull request in a separate temporary clone:",
      ...conflicts.map((conflict) => `- ${conflict.url}`),
    ].join("\n");
  }

  async setEnabled(enabled: boolean) {
    if (enabled) {
      this.okfInstalled = await this.sync.checkOkf();
      if (!this.okfInstalled)
        throw new Error("Install irudd-okf on this Mac before turning on memory.");
    }
    return this.save({ ...this.configuration(), enabled });
  }

  async connect(repository: string) {
    if (!this.configuration().enabled)
      throw new ScopeError(409, "Turn on Memory in Scope Settings on the Mac first.");
    return this.save({ enabled: true, repository: decode(MemoryRepository, repository) });
  }

  async retry() {
    await Promise.all([
      this.sync.sync(),
      ...[...this.remoteMemory.entries()].map(([id, memory]) =>
        memory.call ? this.refreshRemote(id, memory.call) : Promise.resolve(),
      ),
    ]);
    return this.snapshot();
  }

  private async save(configuration: MemoryConfiguration) {
    this.preferences = await this.store.saveMemory({ configuration });
    this.sync.configure(configuration);
    await Promise.all(
      [...this.remoteMemory.entries()].map(([id, memory]) =>
        memory.call ? this.pushRemote(id, memory.call) : Promise.resolve(),
      ),
    );
    this.changed();
    return this.snapshot();
  }

  /** Records a machine's personal bundle so retros offer it while that machine is briefly offline. */
  private async observe(machine: string, status: MemoryMachineStatus) {
    if (!this.preferences?.enabled || status.phase !== "synced") return;
    const root = status.bundle === "registered" && status.root ? status.root : null;
    if ((this.preferences.bundles[machine]?.root ?? null) === root) return;
    this.preferences = await this.store
      .saveMemory({ bundle: { machine, root, verifiedAt: new Date().toISOString() } })
      .catch(() => this.preferences);
  }

  private async watchRemote(id: string, call: RemoteCall, signal: AbortSignal) {
    this.remoteMemory.set(id, { call });
    await this.pushRemote(id, call);
    while (!signal.aborted) {
      await delay(REMOTE_POLL_MS, undefined, { signal }).catch(() => {});
      if (!signal.aborted) await this.refreshRemote(id, call);
    }
    const memory = this.remoteMemory.get(id);
    if (memory?.call === call) this.remoteMemory.set(id, { status: memory.status });
    this.changed();
  }

  private pushRemote(id: string, call: RemoteCall) {
    return this.exchange(id, call, () => call("PUT", "/v1/relay/memory", this.configuration()));
  }

  private refreshRemote(id: string, call: RemoteCall) {
    return this.exchange(id, call, () => call("GET", "/v1/relay/memory"));
  }

  private async exchange(id: string, call: RemoteCall, request: () => Promise<Response>) {
    let next: RemoteMemory;
    try {
      const response = await request();
      if (response.status === 404) {
        await response.body?.cancel();
        next = { call, message: "Update Scope on this machine to sync memory." };
      } else if (!response.ok) {
        await response.body?.cancel();
        next = { call, message: "The hub could not report memory status. Scope will retry." };
      } else {
        const status = decode(MemoryMachineStatus, await readRemoteJson(response, 65_536));
        next = { call, status };
        await this.observe(id, status);
      }
    } catch {
      next = { call, message: "Could not reach this machine's hub. Scope will retry." };
    }
    if (this.remoteMemory.get(id)?.call !== call) return;
    this.remoteMemory.set(id, next);
    this.changed();
  }

  async close() {
    this.stopSessions?.();
    await this.sync.close();
  }
}
