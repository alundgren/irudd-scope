import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "../../renderer/components/ui/button.tsx";
import { FileViews, type FileContent, type MarkedLines } from "../../renderer/file-views.tsx";
import type { FolderViewEvent } from "./contract.ts";

/** Text previews show at most this much of a file. */
export const MAX_PREVIEW_TEXT_BYTES = 2 * 1024 * 1024;
/** Larger images are described instead of shown; one IPC read carries at most 8 MiB. */
const MAX_PREVIEW_IMAGE_BYTES = 8 * 1024 * 1024;
/** The first read: enough to tell text from binary and to show most files whole. */
const FIRST_READ_BYTES = 64 * 1024;

const KINDS: Record<string, [kind: string, mediaType: string]> = {
  md: ["markdown", "text/markdown"],
  markdown: ["markdown", "text/markdown"],
  html: ["html", "text/html"],
  htm: ["html", "text/html"],
  png: ["image", "image/png"],
  jpg: ["image", "image/jpeg"],
  jpeg: ["image", "image/jpeg"],
  gif: ["image", "image/gif"],
  webp: ["image", "image/webp"],
  avif: ["image", "image/avif"],
};

function kindFor(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? KINDS[name.slice(dot + 1).toLowerCase()] : undefined;
}

/** Text has no NUL bytes and decodes as UTF-8, allowing a character cut at the end. */
function looksLikeText(bytes: Uint8Array) {
  if (bytes.subarray(0, 8000).includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
    return true;
  } catch {
    return false;
  }
}

function formatSize(size: number) {
  if (size < 1024) return `${size} bytes`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

type Loaded =
  | { status: "loading" }
  | { status: "shown"; content: FileContent; size: number; truncated: boolean }
  | { status: "info"; size: number; modifiedAt: number }
  | { status: "deleted" }
  | { status: "error"; message: string };

async function loadPreview(tabId: string, path: string): Promise<Loaded> {
  const read = (start: number, end: number) => window.scope.folderRead({ tabId, path, start, end });
  const first = await read(0, FIRST_READ_BYTES);
  const known = kindFor(path);
  const info = { status: "info" as const, size: first.size, modifiedAt: first.modifiedAt };
  const isImage = known?.[0] === "image";
  if (isImage ? first.size > MAX_PREVIEW_IMAGE_BYTES : !looksLikeText(first.bytes)) return info;
  const limit = isImage ? first.size : Math.min(first.size, MAX_PREVIEW_TEXT_BYTES);
  let bytes = first.bytes;
  if (limit > bytes.length) {
    // Only the bytes the preview shows are read, which matters for remote folders.
    const rest = await read(bytes.length, limit);
    const joined = new Uint8Array(bytes.length + rest.bytes.length);
    joined.set(bytes);
    joined.set(rest.bytes, bytes.length);
    bytes = joined;
  }
  const truncated = first.size > limit;
  const [kind, mediaType] = known && !truncated ? known : ["text", "text/plain"];
  return {
    status: "shown",
    size: first.size,
    truncated,
    content: {
      bytes,
      kind,
      mediaType,
      title: path.slice(path.lastIndexOf("/") + 1),
      fileName: path.slice(path.lastIndexOf("/") + 1),
      version: `${first.size}:${first.modifiedAt}`,
    },
  };
}

/**
 * How a change batch affects the previewed file, including through a parent folder: a
 * deleted or renamed `docs` deletes `docs/notes.txt`, and a created one may bring it back.
 */
function touches(event: FolderViewEvent["event"], path: string): "changed" | "deleted" | null {
  if (event.type !== "changes") return null;
  if (event.overflow) return "changed";
  const covers = (changed: string) => changed === path || path.startsWith(`${changed}/`);
  let result: "changed" | "deleted" | null = null;
  for (const change of event.changes) {
    if (change.type === "renamed") {
      if (covers(change.to)) result = "changed";
      else if (covers(change.from)) result = "deleted";
    } else if (change.type === "deleted") {
      if (covers(change.path)) result = "deleted";
    } else if (change.type === "created" ? covers(change.path) : change.path === path)
      result = "changed";
  }
  return result;
}

/**
 * A read-only preview of one file in a Folder tab, using the published-file viewers. It
 * reloads when the file changes on disk and says so when it is deleted. Nothing is kept
 * after the preview closes. Key it by path so another file starts fresh.
 */
export function FolderPreview({
  tabId,
  path,
  lines,
}: {
  tabId: string;
  path: string;
  /** A search match's line or an agent's marked lines: shows the file's text and scrolls to them. */
  lines: MarkedLines | undefined;
}) {
  const start = lines?.start;
  const end = lines?.end;
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [source, setSource] = useState(false);
  const [reloads, setReloads] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Counts reads and deletions; a read that finishes after a newer one or a deletion is dropped.
  const generation = useRef(0);

  useEffect(() => setSource(start !== undefined), [path, start, end]);
  useEffect(() => {
    const run = ++generation.current;
    const current = () => run === generation.current;
    if (!reloads) setLoaded({ status: "loading" });
    loadPreview(tabId, path).then(
      (result) => current() && setLoaded(result),
      (error: unknown) => {
        if (!current()) return;
        const message = error instanceof Error ? error.message : "";
        setLoaded(
          /does not exist/.test(message)
            ? { status: "deleted" }
            : { status: "error", message: "Could not read this file." },
        );
      },
    );
    return () => {
      generation.current++;
    };
  }, [tabId, path, reloads]);
  useEffect(() => {
    const stop = window.scope.onFolderEvent(({ tabId: id, event }) => {
      if (id !== tabId) return;
      const change = touches(event, path);
      if (change === "deleted") {
        clearTimeout(timer.current);
        generation.current++;
        setLoaded({ status: "deleted" });
      } else if (change === "changed") {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setReloads((count) => count + 1), 100);
      }
    });
    return () => {
      stop();
      clearTimeout(timer.current);
    };
  }, [tabId, path]);

  const name = path.slice(path.lastIndexOf("/") + 1);
  const rendered = loaded.status === "shown" && loaded.content.kind !== "text" ? loaded : undefined;
  const sourceToggle = rendered && rendered.content.kind !== "image";
  return (
    <section className="folder-preview" aria-label={`Preview of ${name}`}>
      <header className="folder-preview-bar">
        <code title={path}>{path}</code>
        {sourceToggle && (
          <Button
            variant={source ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={source}
            onClick={() => setSource((value) => !value)}
          >
            Source
          </Button>
        )}
      </header>
      {loaded.status === "shown" && loaded.truncated && (
        <p className="folder-notice" role="status">
          Showing the first {formatSize(MAX_PREVIEW_TEXT_BYTES)} of {formatSize(loaded.size)}.
        </p>
      )}
      <div className="folder-preview-body">
        {loaded.status === "loading" && <p className="folder-state">Reading file…</p>}
        {loaded.status === "deleted" && (
          <p className="folder-state" role="status">
            This file was deleted.
          </p>
        )}
        {loaded.status === "error" && (
          <p className="folder-state" role="alert">
            {loaded.message}
          </p>
        )}
        {loaded.status === "info" && (
          <dl className="folder-file-info">
            <dt>Name</dt>
            <dd>{name}</dd>
            <dt>Size</dt>
            <dd>{formatSize(loaded.size)}</dd>
            <dt>Modified</dt>
            <dd>
              {Number.isFinite(loaded.modifiedAt)
                ? new Date(loaded.modifiedAt).toLocaleString()
                : "Unknown"}
            </dd>
            <dd className="folder-file-note">Scope cannot preview this file.</dd>
            <dd>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void window.scope.saveFolderFile({ tabId, path }).catch(() => {})}
              >
                <Download /> Save to computer…
              </Button>
            </dd>
          </dl>
        )}
        {loaded.status === "shown" && (
          <FileViews
            content={
              source && rendered
                ? { ...loaded.content, kind: "text", mediaType: "text/plain" }
                : loaded.content
            }
            {...(start && end ? { lines: { start, end } } : {})}
            fallback={null}
          />
        )}
      </div>
    </section>
  );
}
