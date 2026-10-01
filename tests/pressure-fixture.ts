import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import type { ElectronApplication } from "@playwright/test";
import { decode, decodeLocalConnection } from "@irudd-scope/protocol";
import { ShrinkReceipt } from "@irudd-scope/protocol/maintenance";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { HubState } from "../apps/hub/src/state.ts";
import { startPairedHub } from "../apps/hub/src/paired-server.ts";

const exec = promisify(execFile);

export async function pressureHub(directory: string) {
  const state = await HubState.open(join(directory, "hub"));
  const connectionFile = join(directory, "hub-connection.json");
  let hub: Awaited<ReturnType<typeof startPairedHub>> | undefined;
  try {
    await state.configure({ endpoint: "http://127.0.0.1:1", port: 1, connectionFile });
    hub = await startPairedHub(state, 0);
    await state.configure({
      endpoint: hub.url,
      port: Number(new URL(hub.url).port),
      connectionFile,
    });
    const { token } = decodeLocalConnection(JSON.parse(await readFile(connectionFile, "utf8")));
    const client = new ScopeClient(hub.url, token);
    return {
      client,
      pairingUrl: state.pairUrl(),
      renewPairing: () => {
        state.unpair();
        return state.pairUrl();
      },
      cli: (...args: string[]) =>
        exec(process.execPath, [resolve("packages/cli/dist/main.mjs"), ...args], {
          env: {
            ...process.env,
            SCOPE_CONNECTION_FILE: connectionFile,
            SCOPE_ENDPOINT: undefined,
            SCOPE_TOKEN: undefined,
            SCOPE_TOKEN_FILE: undefined,
          },
          timeout: 120_000,
        }),
      shrink: async () => {
        const response = await fetch(`${hub!.url}/v1/hub/shrink`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify({ timeoutMs: 120_000 }),
        });
        if (!response.ok) throw new Error("Test hub shrink failed.");
        return decode(ShrinkReceipt, await response.json());
      },
      close: async () => {
        await hub!.close();
        state.close();
      },
    };
  } catch (error) {
    await hub?.close();
    state.close();
    throw error;
  }
}

export function contentCounts(directory: string) {
  const db = new DatabaseSync(join(directory, "artifacts/scope.db"), { readOnly: true });
  try {
    const tables = [
      "live_tabs",
      "artifacts",
      "tab_blobs",
      "tab_drafts",
      "blobs",
      "plan_state",
      "plan_revisions",
      "plan_images",
      "plan_records",
      "plan_receipts",
      "plan_drafts",
      "pull_requests_state",
      "pull_requests_current",
      "pull_requests_receipts",
    ];
    const databaseTables = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const tableRows = Object.fromEntries(
      databaseTables.map(({ name }) => [
        name,
        Number(db.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get()?.n),
      ]),
    );
    const unreferenced = db
      .prepare(
        "SELECT count(*) AS rows, coalesce(sum(length(content)), 0) AS bytes FROM blobs WHERE NOT EXISTS (SELECT 1 FROM tab_blobs WHERE tab_blobs.blob_id = blobs.id)",
      )
      .get();
    return {
      integrity: db.prepare("PRAGMA integrity_check").get()?.integrity_check,
      foreignKeys: db.prepare("PRAGMA foreign_key_check").all(),
      rows: Object.fromEntries(
        tables.map((table) => [
          table,
          Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n),
        ]),
      ),
      tableRows,
      unreferencedBlobs: { rows: Number(unreferenced?.rows), bytes: Number(unreferenced?.bytes) },
      open: Number(db.prepare("SELECT count(*) AS n FROM live_tabs WHERE opened = 1").get()?.n),
    };
  } finally {
    db.close();
  }
}

export async function pressureSample(
  application: ElectronApplication,
  directory: string,
  desktop: string,
) {
  const paths = {
    "scope.db": join(desktop, "artifacts/scope.db"),
    "desktop.db": join(desktop, "desktop.db"),
    "hub.db": join(directory, "hub/hub.db"),
  };
  const databases = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, path]) => {
        const sizes = await Promise.all(
          [path, `${path}-wal`, `${path}-shm`].map(async (file) => {
            const info = await stat(file).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
              return undefined;
            });
            return { bytes: info?.size ?? 0, allocated: (info?.blocks ?? 0) * 512 };
          }),
        );
        return [
          name,
          {
            main: sizes[0].bytes,
            wal: sizes[1].bytes,
            shm: sizes[2].bytes,
            allocated: sizes.reduce((total, value) => total + value.allocated, 0),
          },
        ];
      }),
    ),
  );
  const metrics = await application.evaluate(({ app }) => app.getAppMetrics());
  const pids = metrics.map((metric) => String(metric.pid));
  const { stdout } = await exec("ps", ["-o", "rss=", "-p", pids.join(",")]);
  const rssBytes = stdout
    .trim()
    .split(/\s+/)
    .reduce((sum, kb) => sum + Number(kb) * 1024, 0);
  let physicalFootprintBytes: number | null = null;
  if (process.platform === "darwin") {
    const sample = await exec("python3", [resolve("tools/mac-process-usage.py"), ...pids]);
    physicalFootprintBytes = JSON.parse(sample.stdout).physicalFootprintBytes;
  }
  return { databases, processCount: pids.length, rssBytes, physicalFootprintBytes };
}

export function pressureContent(index: number, cycle: number, revision: number, kib: number) {
  // Adjacent publications share bytes in each eight-item block; cycles use fresh bytes.
  const contentIndex = index % 8 === 1 ? index - 1 : index;
  const kind = ["text", "markdown", "html", "image", "file", "excalidraw"][contentIndex % 6];
  const text = `Synthetic cycle ${cycle}, item ${contentIndex}, revision ${revision}.\n`;
  const padding = text.repeat(Math.ceil((kib * 1024) / text.length)).slice(0, kib * 1024);
  switch (kind) {
    case "markdown":
      return {
        kind,
        mediaType: "text/markdown",
        fileName: "note.md",
        bytes: Buffer.from(`# Synthetic note\n\n${padding}`),
      };
    case "html":
      return {
        kind,
        mediaType: "text/html",
        fileName: "preview.html",
        bytes: Buffer.from(`<h1>Synthetic preview</h1><p>${padding}</p>`),
      };
    case "image":
      return {
        kind,
        mediaType: "image/png",
        fileName: "image.png",
        bytes: Buffer.concat([
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jw8sAAAAASUVORK5CYII=",
            "base64",
          ),
          Buffer.from(padding),
        ]),
      };
    case "file":
      return {
        kind,
        mediaType: "application/octet-stream",
        fileName: "data.bin",
        bytes: Buffer.from(padding),
      };
    case "excalidraw":
      return {
        kind,
        mediaType: "application/vnd.excalidraw+json",
        fileName: "diagram.excalidraw",
        bytes: Buffer.from(
          JSON.stringify({
            type: "excalidraw",
            version: 2,
            source: "synthetic-pressure-test",
            elements:
              contentIndex % 12 === 5
                ? []
                : [
                    {
                      id: "pressure-box",
                      type: "rectangle",
                      x: 30,
                      y: 30,
                      width: 220,
                      height: 100,
                      angle: 0,
                      strokeColor: "#1e1e1e",
                      backgroundColor: "#a5d8ff",
                      fillStyle: "solid",
                      strokeWidth: 2,
                      strokeStyle: "solid",
                      roughness: 0,
                      opacity: 100,
                      seed: 1,
                      version: 1,
                      versionNonce: 1,
                      isDeleted: false,
                      boundElements: null,
                      updated: 1,
                      link: null,
                      locked: false,
                    },
                  ],
            files: {},
            appState: { viewBackgroundColor: "#ffffff" },
            testContent: padding,
          }),
        ),
      };
    default:
      return {
        kind: "text",
        mediaType: "text/plain",
        fileName: "note.txt",
        bytes: Buffer.from(padding),
      };
  }
}

export async function pressureWorkers(count: number, action: (index: number) => Promise<void>) {
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, async (_, worker) => {
      for (let index = worker; index < count; index += 4) await action(index);
    }),
  );
  for (const result of results) if (result.status === "rejected") throw result.reason;
}
