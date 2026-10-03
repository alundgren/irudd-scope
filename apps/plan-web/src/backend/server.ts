import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Presence } from "../contracts.ts";
import { PlanStore } from "./store.ts";
import {
  InvalidInput,
  parseCommand,
  parseCursor,
  parsePresence,
  validatePlanName,
} from "./validation.ts";
import { parseSubscriptions, subscribePlan, subscribePlans } from "./stream.ts";

type Options = { databasePath: string; port?: number; host?: string; assetsDirectory?: string };
const presenceLease = 15_000;
async function openStore(path: string): Promise<PlanStore> {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      return new PlanStore(path);
    } catch (error) {
      const code = (error as { errcode?: number }).errcode;
      const primaryCode = typeof code === "number" ? code & 255 : 0;
      const remaining = deadline - Date.now();
      if ((primaryCode !== 5 && primaryCode !== 6) || remaining <= 0) throw error;
      await delay(Math.min(25, remaining));
    }
  }
}
function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
function planName(encoded: string) {
  return validatePlanName(decodeURIComponent(encoded));
}
async function body(request: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    const bytes = Buffer.from(part);
    size += bytes.length;
    if (size > 2 * 1024 * 1024) throw new InvalidInput("Command body exceeds 2 MiB.");
    parts.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new InvalidInput("Invalid JSON body.");
  }
}
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
async function staticFile(response: ServerResponse, pathname: string, assetsDirectory?: string) {
  if (!assetsDirectory) {
    json(response, 404, { error: "Client assets have not been built." });
    return;
  }
  const directory = resolve(assetsDirectory);
  const filename = resolve(directory, `.${pathname}`);
  if (!filename.startsWith(`${directory}${sep}`)) throw new InvalidInput("Invalid asset path.");
  try {
    const bytes = await readFile(filename);
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(filename)] ?? "application/octet-stream",
    });
    response.end(bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    json(response, 404, { error: "Not found." });
  }
}
export async function startPlanWebServer(
  options: Options,
): Promise<{ url: string; close(): Promise<void> }> {
  const store = await openStore(options.databasePath);
  const presence = new Map<string, Map<string, Presence>>();
  const presenceListeners = new Set<(name: string) => void>();
  const watchPresence = (changed: (name: string) => void) => {
    presenceListeners.add(changed);
    return () => {
      presenceListeners.delete(changed);
    };
  };
  const getPresence = (name: string) => {
    const sessions = presence.get(name);
    if (!sessions) return [];
    for (const [id, entry] of sessions)
      if (Date.now() - entry.updatedAt > presenceLease) sessions.delete(id);
    return [...sessions.values()];
  };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/api/events") {
      if (request.method !== "GET") {
        json(response, 405, { error: "Method not allowed." });
        return;
      }
      const header =
        typeof request.headers["last-event-id"] === "string"
          ? request.headers["last-event-id"]
          : null;
      const subscriptions = parseSubscriptions(url.search, header);
      for (const { name, after } of subscriptions) {
        if (after > store.snapshot(name).revision)
          throw new InvalidInput("Replay cursor exceeds the latest revision.");
      }
      subscribePlans(response, store, subscriptions, getPresence, watchPresence);
      return;
    }
    const route =
      /^\/api\/plans\/([^/]+)(?:\/(commands|events|versions|presence)(?:\/(\d+))?)?$/.exec(
        url.pathname,
      );
    if (!route) {
      if (request.method !== "GET") {
        json(response, 405, { error: "Method not allowed." });
        return;
      }
      if (url.pathname === "/") {
        response.writeHead(302, { Location: "/plans/welcome" });
        response.end();
        return;
      }
      const planRoute = /^\/plans\/([^/]+)$/.exec(url.pathname);
      if (planRoute) {
        store.snapshot(planName(planRoute[1]));
        await staticFile(response, "/index.html", options.assetsDirectory);
      } else await staticFile(response, decodeURIComponent(url.pathname), options.assetsDirectory);
      return;
    }
    const name = planName(route[1]);
    const action = route[2];
    if (request.method === "GET") {
      const snapshot = store.snapshot(name);
      if (!action) {
        json(response, 200, snapshot);
        return;
      }
      if (action === "events") {
        const header =
          typeof request.headers["last-event-id"] === "string"
            ? request.headers["last-event-id"]
            : null;
        const after = Math.max(
          parseCursor(url.searchParams.get("after"), 0),
          parseCursor(header, 0),
        );
        if (after > snapshot.revision)
          throw new InvalidInput("Replay cursor exceeds the latest revision.");
        subscribePlan(response, store, name, after, getPresence, watchPresence);
        return;
      }
      if (action === "versions") {
        if (route[3]) {
          const version = store.version(name, parseCursor(route[3], 0));
          json(response, version ? 200 : 404, version ?? { error: "Version not found." });
          return;
        }
        const before = parseCursor(url.searchParams.get("before"), snapshot.revision + 1);
        const limit = parseCursor(url.searchParams.get("limit"), 20);
        if (limit < 1 || limit > 100)
          throw new InvalidInput("History limit must be between 1 and 100.");
        json(response, 200, store.versions(name, before, limit));
        return;
      }
    }
    if (request.method === "POST") {
      if (action === "commands") {
        const outcome = store.command(name, parseCommand(await body(request)));
        json(response, outcome.status, outcome.receipt);
        return;
      }
      if (action === "presence") {
        if (!presence.has(name)) store.snapshot(name);
        const entry = parsePresence(await body(request));
        let sessions = presence.get(name);
        if (!sessions) {
          sessions = new Map();
          presence.set(name, sessions);
        }
        const previous = sessions.get(entry.sessionId);
        const current = previous && Date.now() - previous.updatedAt <= presenceLease;
        if (
          !current ||
          previous.sequence === undefined ||
          (entry.sequence !== undefined && entry.sequence > previous.sequence)
        ) {
          sessions.set(entry.sessionId, entry);
          for (const changed of presenceListeners) changed(name);
        }
        json(response, 200, getPresence(name));
        return;
      }
    }
    json(response, 405, { error: "Method not allowed." });
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const invalid = error instanceof InvalidInput || error instanceof URIError;
      json(response, invalid ? 400 : 500, {
        error: invalid ? (error as Error).message : "Internal server error.",
      });
    });
  });
  try {
    await new Promise<void>((resolveReady, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
        server.off("error", reject);
        resolveReady();
      });
    });
  } catch (error) {
    store.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Server did not bind a TCP address.");
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  let closed = false;
  return {
    url: `http://${host}:${address.port}`,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolveClosed, reject) => {
        server.close((error) => (error ? reject(error) : resolveClosed()));
        server.closeAllConnections();
      });
      store.close();
    },
  };
}
