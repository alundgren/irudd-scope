import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "../renderer/components/ui/button.tsx";
import type { TrashEntry } from "./retention.ts";

export function EmptyTrash({ entries }: { entries: readonly TrashEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const [unlocked, setUnlocked] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function empty() {
    setPending(true);
    setError("");
    try {
      await window.scope.emptyTrash(entries);
      setExpanded(false);
    } catch {
      setError("Could not empty Trashcan. Slide again to retry.");
    } finally {
      setPending(false);
      setUnlocked(0);
    }
  }
  return (
    <div className="empty-trash">
      {!expanded ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={!entries.length}
          onClick={() => setExpanded(true)}
        >
          <Trash2 /> Empty Trashcan…
        </Button>
      ) : (
        <>
          <p>
            Permanently delete {entries.length} {entries.length === 1 ? "tab" : "tabs"}. Content and
            drafts cannot be recovered.
          </p>
          <label className="trash-unlock">
            <span>{unlocked === 100 ? "Ready to delete" : "Slide to enable deletion"}</span>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={unlocked}
              aria-label="Slide to enable deletion"
              disabled={pending}
              onChange={(event) => setUnlocked(Number(event.target.value))}
            />
          </label>
          <div className="trash-confirm-actions">
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => {
                setExpanded(false);
                setUnlocked(0);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={unlocked !== 100 || pending}
              onClick={() => void empty()}
            >
              {pending
                ? "Deleting…"
                : `Delete ${entries.length} ${entries.length === 1 ? "tab" : "tabs"} forever`}
            </Button>
          </div>
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </div>
  );
}
