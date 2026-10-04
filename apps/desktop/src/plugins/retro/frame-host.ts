import { decode } from "@irudd-scope/protocol";
import { RetroCommand, type RetroSnapshot } from "@irudd-scope/protocol/retro";
import type { RetroFrameIdentity } from "./frame-sdk.ts";
import { retroError } from "../../renderer/retro-error.ts";

export class RetroFrameHost {
  private element: HTMLIFrameElement | null = null;
  private ready = false;
  private snapshot?: RetroSnapshot;
  private flushes = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private flushing?: Promise<void>;
  constructor(
    private readonly options: {
      identity: RetroFrameIdentity;
      name: string;
      refresh: () => Promise<void>;
      openHistory: (tabId: string) => Promise<void>;
    },
  ) {}
  attach(element: HTMLIFrameElement | null) {
    this.element = element;
  }
  setSnapshot(snapshot: RetroSnapshot) {
    if (snapshot.version < (this.snapshot?.version ?? -1)) return;
    this.snapshot = snapshot;
    if (this.ready) this.post({ type: "scope-retro-snapshot", value: snapshot });
  }
  start() {
    const receive = (event: MessageEvent) => {
      void this.receive(event);
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      for (const flush of this.flushes.values()) {
        clearTimeout(flush.timer);
        flush.reject(new Error("The report closed before its edits were saved."));
      }
      this.flushes.clear();
    };
  }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.element || !this.ready) return Promise.resolve();
    const id = crypto.randomUUID();
    this.flushing = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.flushes.delete(id);
        reject(new Error("The report did not save its edits. Retry before leaving."));
      }, 10_000);
      this.flushes.set(id, { resolve, reject, timer });
      this.post({ type: "scope-retro-close", id });
    }).finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }
  private post(value: Record<string, unknown>) {
    this.element?.contentWindow?.postMessage({ ...this.options.identity, ...value }, "*");
  }
  private async receive(event: MessageEvent) {
    const value = event.data;
    if (
      event.source !== this.element?.contentWindow ||
      value?.channel !== this.options.identity.channel ||
      value?.tabId !== this.options.identity.tabId
    )
      return;
    if (value.type === "scope-retro-ready") {
      this.ready = true;
      if (this.snapshot) this.post({ type: "scope-retro-snapshot", value: this.snapshot });
    }
    if (value.type === "scope-retro-flushed") {
      const flush = this.flushes.get(value.id);
      if (!flush) return;
      this.flushes.delete(value.id);
      clearTimeout(flush.timer);
      if (value.error) flush.reject(new Error(String(value.error)));
      else flush.resolve();
    }
    if (
      value.type !== "scope-retro-call" ||
      typeof value.id !== "string" ||
      !Array.isArray(value.args)
    )
      return;
    try {
      const result = await this.call(value.method, value.args);
      this.post({ type: "scope-retro-reply", id: value.id, value: result });
    } catch (error) {
      this.post({
        type: "scope-retro-reply",
        id: value.id,
        error: { message: retroError(error, "Could not save report edits.") },
      });
    }
  }
  private async call(method: string, args: unknown[]) {
    if (method === "openHistory") {
      if (typeof args[0] !== "string") throw new Error("Choose a completed report.");
      await this.flush();
      let after: string | undefined;
      do {
        const reply = await window.scope.retroCommand({
          action: "history",
          ...(after ? { after } : {}),
        });
        if (reply.type !== "history") throw new Error("Could not read RETRO history.");
        const entry = reply.entries.find((entry) => entry.tabId === args[0]);
        if (entry) {
          await this.options.openHistory(entry.tabId);
          return null;
        }
        after = reply.next ?? undefined;
      } while (after);
      throw new Error("This completed report is no longer available.");
    }
    const write = {
      name: this.options.name,
      tabId: this.options.identity.tabId,
      requestId: crypto.randomUUID(),
    };
    let command: unknown;
    switch (method) {
      case "readState":
        command = { action: "state-read", name: write.name, tabId: write.tabId };
        break;
      case "patchState":
        command = { action: "state-patch", ...write, value: args[0], expectedVersion: args[1] };
        break;
      case "comment":
      case "request":
        command = {
          action: method,
          ...write,
          findingId: args[0],
          text: args[1],
          expectedVersion: args[2],
        };
        break;
      case "decide": {
        const decision =
          typeof args[1] === "string"
            ? { decision: args[1] }
            : (args[1] as { decision?: unknown; text?: unknown; destination?: unknown });
        const finding = this.snapshot?.report.findings.find((entry) => entry.id === args[0]);
        command = {
          action: "decide",
          ...write,
          findingId: args[0],
          decision: decision?.decision,
          text: decision?.text ?? finding?.proposal?.text ?? "",
          ...(decision?.destination ? { destination: decision.destination } : {}),
          expectedVersion: args[2],
        };
        break;
      }
      case "history":
        command = { action: "history", ...(args[0] ? { after: args[0] } : {}) };
        break;
      default:
        throw new Error("This operation is unavailable in a RETRO report.");
    }
    const reply = await window.scope.retroCommand(decode(RetroCommand, command));
    if (["decide", "comment", "request", "patchState"].includes(method))
      await this.options.refresh();
    if (reply.type === "state") return reply.state;
    return reply;
  }
}
