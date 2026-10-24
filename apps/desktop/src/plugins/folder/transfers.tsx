import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "../../renderer/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../renderer/components/ui/dialog.tsx";
import type { FolderDropChoice, FolderTransfer } from "./contract.ts";

export function formatSize(size: number) {
  if (size < 1024) return `${size} bytes`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MiB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

/** A dropped file whose name exists, and how many more such files the drop has. */
type Question = {
  path: string;
  remaining: number;
  /** The name appeared while Scope was copying, after the person had answered. */
  again: boolean;
  answer: (choice: FolderDropChoice | "cancel", all: boolean) => void;
};

/** The saves and drops of one Folder tab, with failures kept until dismissed. */
function useTransfers(tabId: string) {
  const [transfers, setTransfers] = useState<FolderTransfer[]>([]);
  useEffect(
    () =>
      window.scope.onFolderTransfer((transfer) => {
        if (transfer.tabId !== tabId) return;
        setTransfers((current) => {
          const others = current.filter((entry) => entry.id !== transfer.id);
          // Finished and cancelled transfers leave; failures stay so the person sees why.
          return transfer.state === "running" || transfer.state === "failed"
            ? [...others, transfer]
            : others;
        });
      }),
    [tabId],
  );
  const dismiss = (id: string) =>
    setTransfers((current) => current.filter((entry) => entry.id !== id));
  return { transfers, dismiss };
}

/**
 * Drops files into a Folder tab: checks them, asks about names that already exist, copies
 * them, and asks again about names that appear during the copy. Nothing is overwritten
 * without the person choosing Replace.
 */
export function useFolderDrop(tabId: string, onWritten: (paths: string[]) => void) {
  const [question, setQuestion] = useState<Question | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const written = useRef(onWritten);
  written.current = onWritten;

  function ask(path: string, remaining: number, again: boolean) {
    return new Promise<{ choice: FolderDropChoice | "cancel"; all: boolean }>((resolve) =>
      setQuestion({
        path,
        remaining,
        again,
        answer: (choice, all) => {
          setQuestion(undefined);
          resolve({ choice, all });
        },
      }),
    );
  }
  async function choose(clashes: readonly string[], again: boolean) {
    const choices: Record<string, FolderDropChoice> = {};
    let all: FolderDropChoice | undefined;
    for (const [index, path] of clashes.entries()) {
      if (all) {
        choices[path] = all;
        continue;
      }
      const answer = await ask(path, clashes.length - index - 1, again);
      if (answer.choice === "cancel") return undefined;
      choices[path] = answer.choice;
      if (answer.all) all = answer.choice;
    }
    return choices;
  }

  async function drop(target: string, files: readonly File[]) {
    setNotice(undefined);
    if (!files.length) return;
    const plan = await window.scope.prepareFolderDrop({ tabId, target, files });
    if (plan.status === "failed") {
      setNotice(plan.message);
      return;
    }
    const copied: string[] = [];
    let clashes = plan.clashes;
    let again = false;
    try {
      for (;;) {
        const choices = await choose(clashes, again);
        if (!choices) {
          await window.scope.discardFolderDrop(plan.planId);
          break;
        }
        const result = await window.scope.startFolderDrop({ planId: plan.planId, choices });
        copied.push(...result.written);
        // A failed copy is shown by its transfer row.
        if (!result.clashes.length || result.cancelled || result.failed) break;
        clashes = result.clashes;
        again = true;
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The files could not be copied.");
    }
    if (copied.length) written.current(copied);
  }
  return { drop, question, notice, dismissNotice: () => setNotice(undefined) };
}

function folderOf(path: string) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "this folder" : path.slice(0, index);
}

/** Asks whether to replace a file with a dropped one of the same name. */
export function ClashQuestion({ question: current }: { question: Question | undefined }) {
  const [all, setAll] = useState(false);
  useEffect(() => setAll(false), [current?.path]);
  // The last question stays readable while the dialog closes.
  const last = useRef(current);
  if (current) last.current = current;
  const question = current ?? last.current;
  const name = question ? question.path.slice(question.path.lastIndexOf("/") + 1) : "";
  return (
    <Dialog
      open={current !== undefined}
      onOpenChange={(open) => {
        if (!open) current?.answer("cancel", false);
      }}
    >
      <DialogContent showCloseButton={false} className="folder-clash">
        <DialogTitle>
          {question?.again
            ? `${name} appeared in ${folderOf(question.path)} while Scope was copying`
            : `${name} already exists in ${question ? folderOf(question.path) : ""}`}
        </DialogTitle>
        <DialogDescription>
          Replace it with the dropped file, keep both with a new name, or cancel the drop.
        </DialogDescription>
        {question && question.remaining > 0 && (
          <label className="folder-clash-all">
            <input
              type="checkbox"
              checked={all}
              onChange={(event) => setAll(event.target.checked)}
            />
            Apply to all {question.remaining + 1} files with existing names
          </label>
        )}
        <div className="folder-clash-actions">
          <Button variant="ghost" onClick={() => current?.answer("cancel", false)}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={() => current?.answer("keep", all)}>
            Keep both
          </Button>
          <Button onClick={() => current?.answer("replace", all)}>Replace</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Saves and drops in progress, each with a Cancel button, and drop problems. */
export function FolderTransfers({
  tabId,
  notice,
  onDismissNotice,
}: {
  tabId: string;
  notice: string | undefined;
  onDismissNotice: () => void;
}) {
  const { transfers, dismiss } = useTransfers(tabId);
  if (!transfers.length && !notice) return null;
  return (
    <div className="folder-transfers">
      {notice && (
        <div className="folder-transfer" role="alert">
          <span className="folder-transfer-label">{notice}</span>
          <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={onDismissNotice}>
            <X />
          </Button>
        </div>
      )}
      {transfers.map((transfer) => {
        const verb = transfer.kind === "save" ? "Saving" : "Copying";
        if (transfer.state === "failed")
          return (
            <div key={transfer.id} className="folder-transfer" role="alert">
              <span className="folder-transfer-label">
                {transfer.kind === "save" ? "Could not save" : "Could not copy"} {transfer.name}.{" "}
                {transfer.message}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Dismiss"
                onClick={() => dismiss(transfer.id)}
              >
                <X />
              </Button>
            </div>
          );
        const label = `${verb} ${transfer.name}`;
        return (
          <div key={transfer.id} className="folder-transfer" role="status">
            <span className="folder-transfer-label">
              {label}… {formatSize(transfer.done)}
              {transfer.total > 0 && ` of ${formatSize(transfer.total)}`}
            </span>
            <progress
              aria-label={label}
              max={transfer.total || 1}
              value={transfer.total ? Math.min(transfer.done, transfer.total) : undefined}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void window.scope.cancelFolderTransfer(transfer.id)}
            >
              Cancel
            </Button>
          </div>
        );
      })}
    </div>
  );
}
