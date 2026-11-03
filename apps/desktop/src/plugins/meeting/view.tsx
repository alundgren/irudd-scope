import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import DOMPurify from "dompurify";
import { Download, Eraser, Presentation, Undo2, X } from "lucide-react";
import { decode } from "@irudd-scope/protocol";
import type { Tab } from "../../workspace/contract.ts";
import type { TabContext } from "../api.ts";
import { Button } from "../../renderer/components/ui/button.tsx";
import { Input } from "../../renderer/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "../../renderer/components/ui/native-select.tsx";
import { Switch } from "../../renderer/components/ui/switch.tsx";
import { operationError } from "../../renderer/operation-error.ts";
import {
  type Block,
  defaultMeetingSettings,
  type EditOp,
  type MeetingSettings,
  MeetingTabState,
  type Page,
} from "./contract.ts";
import { standaloneHtml } from "./export.ts";
import { MeetingLoop, type Rejection } from "./loop.ts";
import { applyOps, emptyPage } from "./page.ts";
import { renderPage } from "./render.ts";
import { BlockEditor } from "./block-editor.tsx";
import { SettingsPopover, useCodexLookup } from "./settings-popover.tsx";
import { SidePanel } from "./side-panel.tsx";
import pageCss from "./page.css?raw";
import katexCss from "katex/dist/katex.min.css?raw";
import "katex/dist/katex.min.css";
import "./page.css";
import "./view.css";

const PURIFY = { USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true } };
const MAX_UNDO = 50;
const FRESH_MS = 2_000;
const TITLE = "@title";

/** Model and agent text becomes HTML here; this window has the `window.scope` bridge. */
const safeHtml = (page: Page) => DOMPurify.sanitize(renderPage(page), PURIFY);

/** Keys of blocks, and the title, that differ between two pages. */
function changedKeys(before: Page, after: Page) {
  const keys = new Set<string>();
  if (before.title !== after.title) keys.add(TITLE);
  const old = new Map(before.blocks.map((block) => [block.id, JSON.stringify(block)]));
  for (const block of after.blocks) {
    if (old.get(block.id) !== JSON.stringify(block)) keys.add(block.id);
    old.delete(block.id);
  }
  for (const id of old.keys()) keys.add(id);
  return keys;
}

type Editing = { original: Block; draft: Block };

export function MeetingView({
  tab,
  context,
  active,
}: {
  tab: Tab;
  context: TabContext;
  active: boolean;
}) {
  // This view is the only writer of its state, so the saved value is read once.
  const [saved] = useState(() => decode(MeetingTabState, tab.state).data);
  const pageRef = useRef<Page>(saved.page ?? emptyPage());
  const settingsRef = useRef<MeetingSettings>(saved.settings ?? defaultMeetingSettings());
  const undoRef = useRef<Page[]>([]);
  const editedAt = useRef(new Map<string, number>());
  const editCount = useRef(0);
  const pageElement = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(pageRef.current);
  const [settings, setSettings] = useState(settingsRef.current);
  const [undoDepth, setUndoDepth] = useState(0);
  const [editing, setEditing] = useState<Editing>();
  const [present, setPresent] = useState(false);
  const [fresh, setFresh] = useState<{ ids: string[]; at: number }>({ ids: [], at: 0 });
  const [title, setTitle] = useState(pageRef.current.title);
  const [notice, setNotice] = useState<{ text: string; kept?: boolean; error?: boolean }>();
  const [keeping, setKeeping] = useState(false);

  function save(nextPage: Page, nextSettings: MeetingSettings) {
    context.updateState({ version: 1, data: { page: nextPage, settings: nextSettings } });
  }
  function commit(next: Page, byPerson: boolean) {
    const previous = pageRef.current;
    if (next === previous) return;
    if (byPerson) {
      editCount.current++;
      for (const key of changedKeys(previous, next)) editedAt.current.set(key, editCount.current);
    }
    undoRef.current = [...undoRef.current, previous].slice(-MAX_UNDO);
    pageRef.current = next;
    setUndoDepth(undoRef.current.length);
    setPage(next);
    setTitle(next.title);
    save(next, settingsRef.current);
  }
  function updateSettings(patch: Partial<MeetingSettings>) {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    save(pageRef.current, next);
  }
  function applyModelOps(ops: readonly EditOp[], mark: number) {
    const touched = (op: EditOp) => (op.op === "title" ? TITLE : op.id);
    const skipped: Rejection[] = [];
    const allowed = ops.filter((op) => {
      const key = touched(op);
      if (key && (editedAt.current.get(key) ?? 0) > mark) {
        skipped.push({ op, reason: "You changed this while the model was working." });
        return false;
      }
      return true;
    });
    const result = applyOps(pageRef.current, allowed);
    if (allowed.length > result.rejected.length) {
      commit(result.page, false);
      if (result.changed.length) setFresh({ ids: result.changed, at: Date.now() });
    }
    return {
      applied: allowed.length - result.rejected.length,
      rejected: [...skipped, ...result.rejected],
    };
  }

  // The loop outlives renders, so it reaches the latest page and handlers through refs.
  const applyRef = useRef(applyModelOps);
  applyRef.current = applyModelOps;
  const [loop] = useState(
    () =>
      new MeetingLoop({
        page: () => pageRef.current,
        settings: () => settingsRef.current,
        editMark: () => editCount.current,
        apply: (ops, mark) => applyRef.current(ops, mark),
      }),
  );
  useEffect(() => {
    loop.resume();
    return () => loop.dispose();
  }, [loop]);
  const loopState = useSyncExternalStore(loop.subscribe, loop.snapshot);
  const listening = loopState.listening !== "off";

  function finishEditing(keep: boolean) {
    const current = editing;
    setEditing(undefined);
    if (!current || !keep) return;
    const { original, draft } = current;
    if (JSON.stringify(original) === JSON.stringify(draft)) return;
    commit(
      {
        ...pageRef.current,
        blocks: pageRef.current.blocks.map((block) => (block.id === original.id ? draft : block)),
      },
      true,
    );
  }
  const finishRef = useRef(finishEditing);
  finishRef.current = finishEditing;

  useEffect(() => {
    if (!active) {
      loop.stop();
      setPresent(false);
    }
  }, [active, loop]);
  useEffect(
    () =>
      context.onBeforeClose(async () => {
        loop.stop();
        finishRef.current(true);
      }),
    [context, loop],
  );

  const shown = useMemo(
    () =>
      editing
        ? {
            ...page,
            blocks: page.blocks.map((block) =>
              block.id === editing.original.id ? editing.draft : block,
            ),
          }
        : page,
    [page, editing],
  );
  const html = useMemo(() => safeHtml(shown), [shown]);
  useLayoutEffect(() => {
    const element = pageElement.current;
    if (!element) return;
    element.innerHTML = html;
    for (const block of element.querySelectorAll<HTMLElement>("[data-block]")) {
      if (present) continue;
      block.tabIndex = 0;
      block.setAttribute("role", "button");
      block.setAttribute("aria-label", `Edit block ${block.dataset.block}`);
      if (block.dataset.block === editing?.original.id) block.classList.add("is-editing");
    }
    if (Date.now() - fresh.at < FRESH_MS)
      for (const id of fresh.ids)
        element.querySelector(`[data-block="${CSS.escape(id)}"]`)?.classList.add("is-fresh");
  }, [html, present, editing?.original.id, fresh]);
  useEffect(() => {
    if (!fresh.ids.length) return;
    const last = fresh.ids.at(-1)!;
    pageElement.current
      ?.querySelector(`[data-block="${CSS.escape(last)}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const timer = setTimeout(() => {
      for (const element of pageElement.current?.querySelectorAll(".is-fresh") ?? [])
        element.classList.remove("is-fresh");
    }, FRESH_MS);
    return () => clearTimeout(timer);
  }, [fresh]);
  useEffect(() => {
    if (!present) return;
    const exit = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPresent(false);
    };
    window.addEventListener("keydown", exit);
    return () => window.removeEventListener("keydown", exit);
  }, [present]);

  const codex = useCodexLookup(settings.codexPath, settings.backend === "codex");

  function openBlock(target: EventTarget | null) {
    if (present || !(target instanceof Element)) return;
    const id = target.closest<HTMLElement>("[data-block]")?.dataset.block;
    const block = pageRef.current.blocks.find((entry) => entry.id === id);
    if (!block || block.id === editing?.original.id) return;
    finishEditing(true);
    setEditing({ original: block, draft: block });
  }
  function undo() {
    const previous = undoRef.current.at(-1);
    if (!previous) return;
    setEditing(undefined);
    const current = pageRef.current;
    undoRef.current = undoRef.current.slice(0, -1);
    editCount.current++;
    for (const key of changedKeys(current, previous)) editedAt.current.set(key, editCount.current);
    pageRef.current = previous;
    setUndoDepth(undoRef.current.length);
    setPage(previous);
    setTitle(previous.title);
    save(previous, settingsRef.current);
  }
  function commitTitle() {
    const next = title.trim().slice(0, 160);
    if (next === pageRef.current.title) return setTitle(next);
    commit({ ...pageRef.current, title: next }, true);
  }
  async function keep() {
    finishEditing(true);
    setKeeping(true);
    setNotice(undefined);
    const current = pageRef.current;
    const name = current.title.trim() || "Meeting canvas";
    try {
      await window.scope.keepMeetingPage({
        title: name,
        html: standaloneHtml({
          page: current,
          bodyHtml: safeHtml(current),
          css: `${katexCss}\n${pageCss}`,
        }),
      });
      setNotice({ text: `Kept “${name}” as HTML. It opened as a new tab.`, kept: true });
    } catch (cause) {
      setNotice({ text: operationError(cause, "Could not keep the page. Retry."), error: true });
    } finally {
      setKeeping(false);
    }
  }
  function clearPage() {
    setEditing(undefined);
    commit(emptyPage(), true);
    setNotice({ text: "Page cleared. Undo brings it back." });
  }

  const indicator = listening && (
    <span className="mc-listening" role="status">
      <span className="mc-listening-dot" aria-hidden="true" />
      {loopState.listening === "starting" ? "Starting…" : "Listening"}
    </span>
  );

  return (
    <div className={present ? "mc-view is-present" : "mc-view"}>
      {!present && (
        <header className="mc-header">
          <Input
            className="mc-title"
            aria-label="Page title"
            placeholder="Untitled meeting"
            maxLength={160}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <Switch
            label="Listen"
            checked={listening}
            disabled={!active}
            onCheckedChange={(checked) => (checked ? void loop.start() : loop.stop())}
          />
          {indicator}
          <NativeSelect
            size="sm"
            aria-label="Edit backend"
            value={settings.backend}
            onChange={(event) =>
              updateSettings({ backend: event.target.value as MeetingSettings["backend"] })
            }
          >
            <NativeSelectOption value="openrouter">OpenRouter</NativeSelectOption>
            <NativeSelectOption value="codex">Codex (Terra)</NativeSelectOption>
          </NativeSelect>
          <span className="mc-header-actions">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Undo"
              title="Undo"
              disabled={!undoDepth}
              onClick={undo}
            >
              <Undo2 />
            </Button>
            <Button variant="outline" disabled={keeping} onClick={() => void keep()}>
              <Download /> Keep as HTML
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                finishEditing(true);
                setPresent(true);
              }}
            >
              <Presentation /> Present
            </Button>
            <SettingsPopover settings={settings} codex={codex} onChange={updateSettings} />
          </span>
        </header>
      )}
      {!present && (loopState.error || notice) && (
        <div className="mc-notices">
          {loopState.error && (
            <p role="alert" className="mc-error">
              {loopState.error}
            </p>
          )}
          {notice && (
            <p role={notice.error ? "alert" : "status"} className={notice.error ? "mc-error" : ""}>
              {notice.text}
              {notice.kept && page.blocks.length > 0 && (
                <Button variant="ghost" size="sm" onClick={clearPage}>
                  <Eraser /> Clear page
                </Button>
              )}
            </p>
          )}
        </div>
      )}
      {!present && settings.backend === "codex" && codex.state === "missing" && (
        <p role="alert" className="mc-error mc-notices">
          {codex.error} Set the path in Meeting canvas settings.
        </p>
      )}
      <div className="mc-body">
        <main className="mc-page-scroll">
          {!present && page.blocks.length === 0 && !editing && (
            <p className="mc-empty mc-muted">
              Turn on Listen and talk, or ask the canvas for something. Click a block to edit it.
            </p>
          )}
          <div
            ref={pageElement}
            className={present ? "mc-page is-present" : "mc-page"}
            onClick={(event) => {
              // Links would navigate the whole Scope window; the kept HTML opens them instead.
              if (event.target instanceof Element && event.target.closest("a"))
                event.preventDefault();
              openBlock(event.target);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                if (!(event.target instanceof HTMLElement) || !event.target.dataset.block) return;
                event.preventDefault();
                openBlock(event.target);
              }
            }}
          />
          {editing && !present && (
            <BlockEditor
              block={editing.draft}
              onChange={(draft) => setEditing({ ...editing, draft })}
              onDone={() => finishEditing(true)}
              onCancel={() => finishEditing(false)}
              onDelete={() => {
                const id = editing.original.id;
                setEditing(undefined);
                commit(
                  {
                    ...pageRef.current,
                    blocks: pageRef.current.blocks.filter((block) => block.id !== id),
                  },
                  true,
                );
              }}
            />
          )}
        </main>
        {!present && <SidePanel loop={loopState} onAsk={(request) => loop.ask(request)} />}
      </div>
      {present && (
        <div className="mc-present-bar">
          {indicator}
          <Button variant="outline" size="sm" onClick={() => setPresent(false)}>
            <X /> Exit present
          </Button>
        </div>
      )}
    </div>
  );
}
