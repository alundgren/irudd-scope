import type { ServerResponse } from "node:http";
import {
  planStreamLimits,
  type PlanEvent,
  type PlanSubscription,
  type Presence,
} from "../contracts.ts";
import { PlanStore } from "./store.ts";
import { InvalidInput, validatePlanName } from "./validation.ts";

function cursor(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new InvalidInput("Invalid revision cursor.");
  return value;
}
function parseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    throw new InvalidInput("Invalid event stream JSON.");
  }
}
export function parseSubscriptions(
  rawQuery: string,
  lastEventId: string | null,
): PlanSubscription[] {
  let query: string | null = null;
  let encodedLength = 0;
  for (const parameter of rawQuery.replace(/^\?/, "").split("&")) {
    const decoded = new URLSearchParams(parameter);
    if (!decoded.has("subscriptions")) continue;
    query = decoded.get("subscriptions");
    const equals = parameter.indexOf("=");
    encodedLength = equals === -1 ? 0 : parameter.length - equals - 1;
    break;
  }
  if (query === null) throw new InvalidInput("Plan subscriptions are required.");
  if (
    encodedLength > planStreamLimits.encodedQueryLength ||
    rawQuery.length + (lastEventId?.length ?? 0) > planStreamLimits.requestLength
  )
    throw new InvalidInput("Event stream subscriptions and cursors exceed the request limit.");
  const value = parseJson(query);
  if (!Array.isArray(value) || !value.length || value.length > planStreamLimits.subscriptions)
    throw new InvalidInput(`Subscribe to between 1 and ${planStreamLimits.subscriptions} plans.`);
  const subscriptions = new Map<string, number>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new InvalidInput("Invalid plan subscription.");
    const item = entry as Record<string, unknown>;
    const name = validatePlanName(item.name);
    const after = cursor(item.after);
    subscriptions.set(name, Math.min(subscriptions.get(name) ?? after, after));
  }
  if (lastEventId !== null) {
    if (!lastEventId.startsWith("v1."))
      throw new InvalidInput("Unknown event stream cursor encoding.");
    let decoded: string;
    try {
      decoded = decodeURIComponent(lastEventId.slice(3));
    } catch {
      throw new InvalidInput("Invalid event stream cursor encoding.");
    }
    const cursors = parseJson(decoded);
    if (!cursors || typeof cursors !== "object" || Array.isArray(cursors))
      throw new InvalidInput("Invalid event stream cursor map.");
    for (const [name, revision] of Object.entries(cursors)) {
      validatePlanName(name);
      const after = cursor(revision);
      if (subscriptions.has(name))
        subscriptions.set(name, Math.max(subscriptions.get(name)!, after));
    }
  }
  return [...subscriptions].map(([name, after]) => ({ name, after }));
}
function cursorId(cursors: Map<string, number>) {
  return `v1.${encodeURIComponent(JSON.stringify(Object.fromEntries(cursors)))}`;
}
type Frames = {
  plan(event: PlanEvent, cursors: Map<string, number>): string;
  presence(name: string, people: Presence[]): string;
};
export type WatchPresence = (changed: (name: string) => void) => () => void;
function stream(
  response: ServerResponse,
  store: PlanStore,
  subscriptions: PlanSubscription[],
  getPresence: (name: string) => Presence[],
  frames: Frames,
  watchPresence: WatchPresence,
) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
  const cursors = new Map(subscriptions.map(({ name, after }) => [name, after]));
  const lastPresence = new Map<string, string>();
  let nextPlan = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stall: ReturnType<typeof setTimeout> | undefined;
  let heartbeat = Date.now();
  let stopped = false;
  let waitingForDrain = false;
  const unwatch = watchPresence((name) => {
    if (!cursors.has(name) || stopped || waitingForDrain) return;
    schedule(0);
  });
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(stall);
    unwatch();
  };
  const schedule = (delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(tick, delay);
  };
  const write = (text: string) => {
    if (response.write(text)) return true;
    waitingForDrain = true;
    stall = setTimeout(() => response.destroy(), 5000);
    response.once("drain", () => {
      clearTimeout(stall);
      waitingForDrain = false;
      if (!stopped) schedule(0);
    });
    return false;
  };
  const tick = () => {
    if (stopped) return;
    try {
      let remaining = 20;
      let more = false;
      for (let visited = 0; visited < subscriptions.length && remaining > 0; visited++) {
        const { name } = subscriptions[nextPlan];
        nextPlan = (nextPlan + 1) % subscriptions.length;
        const people = getPresence(name);
        const encoded = JSON.stringify(people);
        if (lastPresence.get(name) !== encoded) {
          lastPresence.set(name, encoded);
          remaining--;
          if (!write(frames.presence(name, people))) return;
        }
        if (!remaining) break;
        const limit = Math.min(4, remaining);
        const events = store.events(name, cursors.get(name)!, limit);
        more ||= events.length === limit;
        for (const event of events) {
          cursors.set(name, event.revision);
          remaining--;
          if (!write(frames.plan(event, cursors))) return;
        }
      }
      if (Date.now() - heartbeat > 15_000) {
        heartbeat = Date.now();
        if (!write(": heartbeat\n\n")) return;
      }
      schedule(more || remaining === 0 ? 0 : 50);
    } catch {
      response.destroy();
    }
  };
  response.on("close", stop);
  tick();
}
export function subscribePlans(
  response: ServerResponse,
  store: PlanStore,
  subscriptions: PlanSubscription[],
  getPresence: (name: string) => Presence[],
  watchPresence: WatchPresence,
) {
  stream(
    response,
    store,
    subscriptions,
    getPresence,
    {
      plan: (event, cursors) =>
        `id: ${cursorId(cursors)}\nevent: plan\ndata: ${JSON.stringify(event)}\n\n`,
      presence: (name, people) => `event: presence\ndata: ${JSON.stringify({ name, people })}\n\n`,
    },
    watchPresence,
  );
}
export function subscribePlan(
  response: ServerResponse,
  store: PlanStore,
  name: string,
  after: number,
  getPresence: (name: string) => Presence[],
  watchPresence: WatchPresence,
) {
  stream(
    response,
    store,
    [{ name, after }],
    getPresence,
    {
      plan: (event) => `id: ${event.revision}\nevent: plan\ndata: ${JSON.stringify(event)}\n\n`,
      presence: (_name, people) => `event: presence\ndata: ${JSON.stringify(people)}\n\n`,
    },
    watchPresence,
  );
}
