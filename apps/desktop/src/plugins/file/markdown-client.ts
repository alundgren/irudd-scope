import type { Root } from "hast";
import { parseMarkdown } from "./markdown-parse.ts";

type Request = { markdown: string; resolve: (tree: Root) => void };
let worker: Worker | undefined;
let workerFailed = false;
let nextId = 0;
const requests = new Map<number, Request>();

function switchToMainThread() {
  workerFailed = true;
  worker?.terminate();
  worker = undefined;
  for (const { markdown, resolve } of requests.values()) resolve(parseMarkdown(markdown));
  requests.clear();
}

function markdownWorker() {
  if (workerFailed) return undefined;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./markdown-worker.ts", import.meta.url), { type: "module" });
  } catch {
    workerFailed = true;
    return undefined;
  }
  worker.addEventListener("message", ({ data }: MessageEvent<{ id: number; tree: Root }>) => {
    requests.get(data.id)?.resolve(data.tree);
    requests.delete(data.id);
  });
  worker.addEventListener("error", switchToMainThread);
  worker.addEventListener("messageerror", switchToMainThread);
  return worker;
}

/** Parses Markdown into a hast tree in a worker, or on the main thread when the worker fails. */
export function parseMarkdownInBackground(markdown: string): Promise<Root> {
  const target = markdownWorker();
  if (!target) return Promise.resolve(parseMarkdown(markdown));
  const id = nextId++;
  return new Promise((resolve) => {
    requests.set(id, { markdown, resolve });
    target.postMessage({ id, markdown });
  });
}
