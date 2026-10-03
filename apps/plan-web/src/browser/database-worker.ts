import { PGlite } from "@electric-sql/pglite";
import { LocalDatabase } from "./local-database.ts";
import type { StoreRequest } from "./storage.ts";
import { PlanEventStream, type StreamRequest } from "./event-stream.ts";

const operations = new Set([
  "read",
  "initialize",
  "saveDraft",
  "queueHtml",
  "queueCommand",
  "pending",
  "accept",
  "conflict",
  "resolve",
  "drafts",
  "recover",
  "reject",
  "dismissRejected",
  "restoreRejected",
]);
const database = new Promise<PGlite>((resolve, reject) => {
  void navigator.locks
    .request("scope-plan-web-database-v1", async () => {
      try {
        const db = await PGlite.create({
          dataDir: "idb://scope-plan-web-v1",
          relaxedDurability: false,
        });
        await LocalDatabase.initialize(db);
        resolve(db);
        // The browser releases this lock when the worker terminates, including a crash.
        await new Promise<void>(() => {});
      } catch (error) {
        reject(error);
      }
    })
    .catch(reject);
});
let serial: Promise<void> = Promise.resolve();
function databaseWork<T>(work: (db: PGlite) => Promise<T>) {
  const result = serial.then(async () => work(await database));
  serial = result.then(
    () => {},
    () => {},
  );
  return result;
}
const events = new PlanEventStream(databaseWork);
const scope = globalThis as unknown as {
  onconnect: (event: MessageEvent & { ports: MessagePort[] }) => void;
};
scope.onconnect = (event) => {
  const port = event.ports[0];
  port.onmessage = (message: MessageEvent<StoreRequest | StreamRequest>) => {
    const request = message.data;
    if ("kind" in request) {
      if (typeof request.plan !== "string") return;
      if (request.kind === "watch") events.watch(request.plan, port);
      else if (request.kind === "unwatch") events.unwatch(request.plan, port);
      return;
    }
    void databaseWork(async (db) => {
      let response: { id: number; result?: unknown; error?: string };
      try {
        if (
          !operations.has(request.operation) ||
          typeof request.plan !== "string" ||
          typeof request.editor !== "string" ||
          !Array.isArray(request.args)
        )
          throw new Error("Invalid browser database operation.");
        const store = new LocalDatabase(db, request.plan, request.editor);
        const operation = store[request.operation] as (...args: never[]) => Promise<unknown>;
        response = {
          id: request.id,
          result: await operation.apply(store, request.args as never[]),
        };
      } catch (error) {
        response = {
          id: request.id,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      try {
        port.postMessage(response);
      } catch {
        /* Closing a caller cannot cancel committed work or stop other editors. */
      }
    }).catch((error: unknown) => {
      try {
        port.postMessage({
          id: request.id,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        /* A stopped client cannot prevent other database operations. */
      }
    });
  };
  port.start();
};
