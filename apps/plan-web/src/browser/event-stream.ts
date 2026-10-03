import { planEventsUrl, type PlanEvent, type PlanStreamPresence } from "../contracts.ts";
import { LocalDatabase } from "./local-database.ts";
import type { PGlite } from "@electric-sql/pglite";

export type StreamMessage =
  | { kind: "stream"; event: "plan"; data: PlanEvent }
  | { kind: "stream"; event: "presence"; data: PlanStreamPresence["people"] }
  | { kind: "stream"; event: "connection"; data: boolean }
  | { kind: "stream"; event: "error"; data: string };
export type StreamRequest = { kind: "watch" | "unwatch"; plan: string };
type DatabaseWork = <T>(work: (database: PGlite) => Promise<T>) => Promise<T>;

export class PlanEventStream {
  private watchers = new Map<string, Map<MessagePort, number>>();
  private stream: EventSource | null = null;
  private connected = false;
  private epoch = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private batches = new Map<string, PlanEvent[]>();
  private batchTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private database: DatabaseWork) {
    setInterval(() => {
      const expired = Date.now() - 20_000;
      for (const [name, ports] of this.watchers)
        for (const [port, lastSeen] of ports)
          if (lastSeen < expired) {
            this.send(port, { kind: "stream", event: "connection", data: false });
            this.unwatch(name, port);
          }
    }, 10_000);
  }

  watch(name: string, port: MessagePort) {
    const existing = this.watchers.get(name);
    if (existing) {
      existing.set(port, Date.now());
      this.send(port, { kind: "stream", event: "connection", data: this.connected });
      return;
    }
    try {
      planEventsUrl(
        [...this.watchers.keys(), name].map((plan) => ({
          name: plan,
          after: Number.MAX_SAFE_INTEGER,
        })),
      );
    } catch (error) {
      this.send(port, {
        kind: "stream",
        event: "error",
        data: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    this.watchers.set(name, new Map([[port, Date.now()]]));
    this.restart();
  }

  unwatch(name: string, port: MessagePort) {
    const ports = this.watchers.get(name);
    if (!ports?.delete(port) || ports.size) return;
    this.watchers.delete(name);
    this.restart();
  }

  private send(port: MessagePort, message: StreamMessage) {
    try {
      port.postMessage(message);
    } catch {
      /* A closed tab cannot stop the durable event receiver. */
    }
  }

  private broadcast(name: string, message: StreamMessage) {
    for (const port of this.watchers.get(name)?.keys() ?? []) this.send(port, message);
  }

  private connection(connected: boolean) {
    this.connected = connected;
    for (const name of this.watchers.keys())
      this.broadcast(name, { kind: "stream", event: "connection", data: connected });
  }

  private restart(delay = 100) {
    this.stream?.close();
    this.stream = null;
    this.connection(false);
    const epoch = ++this.epoch;
    clearTimeout(this.restartTimer);
    if (!this.watchers.size) return;
    this.restartTimer = setTimeout(() => {
      void this.open(epoch);
    }, delay);
  }

  private async open(epoch: number) {
    try {
      const subscriptions = await this.database(async (db) => {
        const plans = [];
        for (const name of this.watchers.keys()) {
          const { cursor } = await new LocalDatabase(db, name, "stream").read();
          plans.push({ name, after: cursor });
        }
        return plans;
      });
      if (epoch !== this.epoch || !subscriptions.length) return;
      const stream = new EventSource(planEventsUrl(subscriptions));
      this.stream = stream;
      stream.onopen = () => {
        if (epoch === this.epoch) this.connection(true);
      };
      stream.onerror = () => {
        // Delivered SSE IDs can lead uncommitted work; reconnect only from database cursors.
        if (epoch === this.epoch) this.restart(500);
      };
      stream.addEventListener("plan", (message) => {
        const event = JSON.parse((message as MessageEvent).data) as PlanEvent;
        const name = event.snapshot.name;
        const events = this.batches.get(name) ?? [];
        events.push(event);
        this.batches.set(name, events);
        this.flush();
      });
      stream.addEventListener("presence", (message) => {
        const presence = JSON.parse((message as MessageEvent).data) as PlanStreamPresence;
        this.broadcast(presence.name, { kind: "stream", event: "presence", data: presence.people });
      });
    } catch {
      if (epoch === this.epoch) this.restart(1000);
    }
  }

  private flush() {
    if (this.batchTimer) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined;
      const batches = this.batches;
      this.batches = new Map();
      void this.database(async (db) => {
        for (const [name, events] of batches) {
          const latest = events.at(-1)!;
          await new LocalDatabase(db, name, "stream").accept(
            latest.snapshot,
            events.map((event) => event.requestId),
          );
          this.broadcast(name, { kind: "stream", event: "plan", data: latest });
        }
      }).catch((error: unknown) => {
        for (const name of batches.keys())
          this.broadcast(name, {
            kind: "stream",
            event: "error",
            data: error instanceof Error ? error.message : String(error),
          });
        this.restart(1000);
      });
    }, 25);
  }
}
