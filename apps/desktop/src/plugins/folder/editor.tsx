import { useCallback, useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "../../renderer/components/ui/button.tsx";
import { hasPrimaryModifier } from "../../renderer/shortcuts.ts";
import { loadPreview, touches } from "./preview.tsx";

/**
 * One file open for editing. The text uses `\n` line ends and has no byte order mark, as
 * a textarea does; saving restores the file's own line ends and mark.
 */
export type FolderEdit = {
  text: string;
  /** The text as read or last saved, to tell whether there are unsaved changes. */
  base: string;
  /** The file's version on its machine when `base` was read or saved. */
  version: string;
  lineEnd: "\n" | "\r\n";
  bom: boolean;
  /** The file changed or was deleted on its machine after `version`. */
  changed?: "changed" | "deleted";
  saving?: boolean;
  error?: string;
};

const BOM = [0xef, 0xbb, 0xbf];
const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Reads a file's version, then its text, so a change between the two fails the next save. */
async function readEditable(tabId: string, path: string): Promise<FolderEdit | { error: string }> {
  const version = await window.scope.folderFileVersion({ tabId, path });
  if (version.status === "failed") return { error: version.message };
  const loaded = await loadPreview(tabId, path);
  if (loaded.status !== "shown" || loaded.truncated || loaded.content.kind === "image")
    return { error: "Scope can edit text files up to 2 MiB." };
  const bytes = loaded.content.bytes;
  const bom = BOM.every((byte, index) => bytes[index] === byte);
  // The decoder drops a leading byte order mark.
  const raw = new TextDecoder().decode(bytes);
  const text = raw.replace(/\r\n/g, "\n");
  return {
    text,
    base: text,
    version: version.version,
    lineEnd: raw.includes("\r\n") ? "\r\n" : "\n",
    bom,
  };
}

/**
 * The files being edited in one Folder tab, by path. Unsaved text stays in this view only,
 * across file and tab switches, and is never stored by Scope. Changes on the file's machine
 * reload a file without unsaved changes and are reported for one with them.
 */
export function useFolderEdits(tabId: string) {
  const [edits, setEdits] = useState<ReadonlyMap<string, FolderEdit>>(new Map());
  const latest = useRef(edits);
  latest.current = edits;
  const change = useCallback(
    (path: string, update: (edit: FolderEdit) => FolderEdit | undefined) =>
      setEdits((current) => {
        const edit = current.get(path);
        if (!edit) return current;
        const next = new Map(current);
        const updated = update(edit);
        if (updated) next.set(path, updated);
        else next.delete(path);
        return next;
      }),
    [],
  );
  const [opening, setOpening] = useState<{ path: string; error?: string }>();

  const open = useCallback(
    async (path: string) => {
      setOpening({ path });
      const read = await readEditable(tabId, path).catch(() => ({
        error: "Could not read this file.",
      }));
      if ("error" in read) {
        setOpening({ path, error: read.error });
        return;
      }
      setOpening(undefined);
      setEdits((current) => new Map(current).set(path, read));
    },
    [tabId],
  );

  /** Reads the file again, replacing the editor's text. */
  const reload = useCallback(
    async (path: string) => {
      const read = await readEditable(tabId, path).catch(() => ({
        error: "Could not read this file.",
      }));
      change(path, (edit) => ("error" in read ? { ...edit, error: read.error } : read));
    },
    [tabId, change],
  );

  // Paths whose files changed while they were saved, checked once the save finishes.
  const recheck = useRef(new Set<string>());
  const check = useCallback(
    async (path: string) => {
      const edit = latest.current.get(path);
      if (!edit) return;
      if (edit.saving) {
        recheck.current.add(path);
        return;
      }
      const now = await window.scope.folderFileVersion({ tabId, path }).catch(() => undefined);
      if (now?.status !== "ok") return;
      const current = latest.current.get(path);
      if (!current || current.saving || now.version === current.version) return;
      if (now.version === "missing") change(path, (edit) => ({ ...edit, changed: "deleted" }));
      else if (current.text === current.base && !current.changed) void reload(path);
      else change(path, (edit) => ({ ...edit, changed: "changed" }));
    },
    [tabId, change, reload],
  );

  const save = useCallback(
    async (path: string, overwrite = false) => {
      const edit = latest.current.get(path);
      if (!edit || edit.saving) return;
      change(path, (edit) => ({ ...edit, saving: true, error: undefined }));
      const sent = edit.text;
      let expectedVersion = edit.version;
      if (overwrite) {
        const now = await window.scope.folderFileVersion({ tabId, path }).catch(() => undefined);
        if (now?.status !== "ok") {
          change(path, (edit) => ({
            ...edit,
            saving: false,
            error: now?.message ?? "Could not check the file. Try again.",
          }));
          return;
        }
        expectedVersion = now.version;
      }
      const result = await window.scope
        .saveFolderText({
          tabId,
          path,
          text: (edit.bom ? "﻿" : "") + sent.replaceAll("\n", edit.lineEnd),
          expectedVersion,
        })
        .catch(() => ({ status: "failed" as const, message: "The file could not be saved." }));
      change(path, (edit) =>
        result.status === "saved"
          ? { ...edit, saving: false, base: sent, version: result.version, changed: undefined }
          : result.status === "conflict"
            ? {
                ...edit,
                saving: false,
                changed: result.version === "missing" ? "deleted" : "changed",
              }
            : { ...edit, saving: false, error: result.message },
      );
      if (recheck.current.delete(path)) setTimeout(() => void check(path));
    },
    [tabId, change, check],
  );

  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const stop = window.scope.onFolderEvent(({ tabId: id, event }) => {
      if (id !== tabId) return;
      for (const path of latest.current.keys()) {
        if (!touches(event, path)) continue;
        clearTimeout(timers.get(path));
        timers.set(
          path,
          setTimeout(() => void check(path), 100),
        );
      }
    });
    return () => {
      stop();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [tabId, check]);

  return {
    edits,
    opening,
    open,
    reload,
    save,
    update: (path: string, text: string) => change(path, (edit) => ({ ...edit, text })),
    close: (path: string) => {
      change(path, () => undefined);
      setOpening((current) => (current?.path === path ? undefined : current));
    },
    /** Paths with unsaved changes. */
    unsaved: () =>
      [...latest.current].filter(([, edit]) => edit.text !== edit.base).map(([path]) => path),
  };
}
export type FolderEdits = ReturnType<typeof useFolderEdits>;

/** Edit in a preview's bar, or Save and Done while the file is being edited. */
export function FolderEditActions({
  path,
  editable,
  edits,
}: {
  path: string;
  /** The preview shows the whole file as text, Markdown, or HTML. */
  editable: boolean;
  edits: FolderEdits;
}) {
  const edit = edits.edits.get(path);
  if (!edit) {
    const opening = edits.opening?.path === path ? edits.opening : undefined;
    if (!editable) return null;
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled={opening && !opening.error}
        onClick={() => void edits.open(path)}
      >
        <Pencil /> Edit
      </Button>
    );
  }
  const unsaved = edit.text !== edit.base;
  return (
    <>
      <span className="folder-edit-status" role="status">
        {edit.saving ? "Saving…" : unsaved ? "Unsaved changes" : ""}
      </span>
      <Button
        size="sm"
        disabled={!unsaved || edit.saving || edit.changed === "changed"}
        onClick={() => void edits.save(path, edit.changed === "deleted")}
      >
        Save
      </Button>
      <Button variant="ghost" size="sm" onClick={() => edits.close(path)}>
        {unsaved ? "Discard" : "Done"}
      </Button>
    </>
  );
}

/** The editor for one file, shown in place of its preview. */
export function FolderEditor({
  path,
  edit,
  edits,
}: {
  path: string;
  edit: FolderEdit;
  edits: FolderEdits;
}) {
  const name = fileName(path);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => area.current?.focus(), []);
  return (
    <>
      {edit.changed && (
        <div className="folder-notice folder-edit-notice" role="alert">
          <span>
            {edit.changed === "deleted"
              ? `${name} was deleted. Save creates it again.`
              : `${name} changed on its machine since you started editing.`}
          </span>
          {edit.changed === "changed" && (
            <>
              <Button variant="ghost" size="sm" onClick={() => void edits.reload(path)}>
                Reload and discard my changes
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={edit.saving}
                onClick={() => void edits.save(path, true)}
              >
                Overwrite with my changes
              </Button>
            </>
          )}
        </div>
      )}
      {edit.error && (
        <p className="folder-notice folder-edit-notice" role="alert">
          {edit.error}
        </p>
      )}
      <textarea
        ref={area}
        className="folder-editor"
        aria-label={`Edit ${name}`}
        spellCheck={false}
        value={edit.text}
        onChange={(event) => edits.update(path, event.target.value)}
        onKeyDown={(event) => {
          if (!hasPrimaryModifier(event.nativeEvent) || event.key.toLowerCase() !== "s") return;
          event.preventDefault();
          // A changed or deleted file is saved only through Overwrite or after a reload.
          if (edit.changed === "changed") return;
          void edits.save(path, edit.changed === "deleted");
        }}
      />
    </>
  );
}
