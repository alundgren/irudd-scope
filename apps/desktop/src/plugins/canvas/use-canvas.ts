import { useCallback, useEffect, useRef, useState } from "react";
import { applyOps } from "./changes.ts";
import {
  targetScope,
  type CanvasOp,
  type CanvasSnapshot,
  type CanvasTarget,
  type CanvasWriteResult,
  type CardContent,
} from "./contract.ts";

type Confirmed = Record<string, number>;
export type CanvasWrite = (
  target: CanvasTarget,
  label: string,
  ops: CanvasOp[],
) => Promise<CanvasWriteResult>;

const requestId = () => crypto.randomUUID().replaceAll("-", "");

function withOps(snapshot: CanvasSnapshot, target: CanvasTarget, ops: CanvasOp[]): CanvasSnapshot {
  if ("board" in target) {
    const { content } = applyOps(snapshot.board.cards as CardContent, ops);
    return { ...snapshot, board: { ...snapshot.board, cards: content as never } };
  }
  const card = snapshot.cards[target.card];
  if (!card) return snapshot;
  const { content } = applyOps(card.content, ops);
  return { ...snapshot, cards: { ...snapshot.cards, [target.card]: { ...card, content } } };
}

/** How long the records an agent just changed stay lit up. */
const HIGHLIGHT_MS = 4000;

/** Records that are new or different in `after`. */
function changedRecords(before: CardContent | undefined, after: CardContent) {
  return Object.keys(after).filter(
    (id) => JSON.stringify(before?.[id]) !== JSON.stringify(after[id]),
  );
}

const versionOf = (snapshot: CanvasSnapshot, scope: string) =>
  scope === "" ? snapshot.board.version : (snapshot.cards[scope]?.version ?? 0);

/**
 * Loads a canvas and writes changes to it. The person's own changes show at once; main
 * confirms them in order, one target at a time, and a refused change reloads the canvas.
 */
export function useCanvas(tabId: string, onNotice: (text: string) => void) {
  const [snapshot, setSnapshot] = useState<CanvasSnapshot>();
  const [loadError, setLoadError] = useState(false);
  /** Per card, the records an agent changed a moment ago. */
  const [highlights, setHighlights] = useState<Record<string, string[]>>({});
  // What the view shows now, including the person's unconfirmed edits, so only the agent's
  // changes light up.
  const shown = useRef<CanvasSnapshot | undefined>(undefined);
  shown.current = snapshot;
  const agentCards = useRef(new Set<string>());
  const confirmed = useRef<Confirmed>({});
  const queues = useRef(new Map<string, Promise<unknown>>());
  const pending = useRef(0);
  const failed = useRef(false);
  const notice = useRef(onNotice);
  notice.current = onNotice;

  const load = useCallback(async () => {
    try {
      const next = await window.scope.canvasRead(tabId);
      if (!next) throw new Error("This canvas is gone.");
      confirmed.current = {
        "": next.board.version,
        ...Object.fromEntries(Object.entries(next.cards).map(([id, card]) => [id, card.version])),
      };
      const before = shown.current;
      for (const cardId of agentCards.current) {
        const changed = next.cards[cardId]
          ? changedRecords(before?.cards[cardId]?.content, next.cards[cardId].content)
          : [];
        if (!changed.length) continue;
        setHighlights((current) => ({ ...current, [cardId]: changed }));
        setTimeout(
          () =>
            setHighlights((current) =>
              current[cardId] === changed
                ? Object.fromEntries(Object.entries(current).filter(([id]) => id !== cardId))
                : current,
            ),
          HIGHLIGHT_MS,
        );
      }
      agentCards.current.clear();
      setSnapshot(next);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [tabId]);

  useEffect(() => {
    void load();
    return window.scope.onCanvasChanged((event) => {
      if (event.tabId !== tabId) return;
      if (event.actor === "agent" && "card" in event.target)
        agentCards.current.add(event.target.card);
      if (pending.current) return;
      if (event.version > (confirmed.current[targetScope(event.target)] ?? 0)) void load();
    });
  }, [load]);

  const send = useCallback(
    (target: CanvasTarget, run: () => Promise<CanvasWriteResult>) => {
      const scope = targetScope(target);
      pending.current++;
      const task = (queues.current.get(scope) ?? Promise.resolve()).then(async () => {
        let result: CanvasWriteResult;
        try {
          result = await run();
        } catch (error) {
          result = {
            ok: false,
            code: "invalid",
            message: error instanceof Error ? error.message : "Scope could not save the change.",
          };
        }
        if (result.ok) {
          // Each write adds one version. A larger jump means someone else wrote in between, which
          // this view has not seen, so later queued writes keep the older base and main checks
          // them against it too. That holds for undo, which never reports a replay. The reload
          // once the queue drains catches up.
          const base = confirmed.current[scope] ?? 0;
          if (result.version === base + 1) confirmed.current[scope] = result.version;
          failed.current = false;
        } else if (result.code !== "empty") {
          failed.current = result.code !== "conflict";
          notice.current(result.message);
        }
        return result;
      });
      queues.current.set(
        scope,
        task.finally(async () => {
          if (--pending.current === 0) await load();
        }),
      );
      return task;
    },
    [tabId, load],
  );

  const write: CanvasWrite = useCallback(
    (target, label, ops) => {
      // New records wait for main to pick their IDs, so only existing records change at once.
      if (!ops.some((op) => op.id.startsWith("$")))
        setSnapshot((current) => current && withOps(current, target, ops));
      return send(target, () =>
        window.scope.canvasChange({
          tabId,
          requestId: requestId(),
          target,
          base: confirmed.current[targetScope(target)] ?? 0,
          label,
          ops,
        }),
      );
    },
    [tabId, send],
  );

  const step = useCallback(
    (target: CanvasTarget, direction: "undo" | "redo") =>
      send(target, () =>
        window.scope.canvasStep({ tabId, requestId: requestId(), target, direction }),
      ),
    [tabId, send],
  );

  /** Waits for every change sent so far, and fails when one could not be saved. */
  const flush = useCallback(async () => {
    await Promise.all(queues.current.values());
    if (failed.current) throw new Error("A canvas change could not be saved.");
  }, []);

  return {
    snapshot,
    highlights,
    loadError,
    reload: load,
    write,
    step,
    flush,
    version: (scope: string) => (snapshot ? versionOf(snapshot, scope) : 0),
  };
}
