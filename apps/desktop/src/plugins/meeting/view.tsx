import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import DOMPurify from "dompurify";
import { Download, Eraser, Maximize, Minus, Plus, Presentation, Undo2, X } from "lucide-react";
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
  type Canvas,
  type CanvasOp,
  defaultMeetingSettings,
  MAX_SECTIONS,
  type MeetingSettings,
  MeetingTabState,
  type Section,
} from "./contract.ts";
import { CanvasCamera } from "./camera.ts";
import { applyCanvasOps, emptyCanvas, pageToCanvas } from "./canvas.ts";
import { standaloneHtml } from "./export.ts";
import { type CanvasStatus, MeetingLoop, type ModelChange } from "./loop.ts";
import { renderCanvas } from "./render.ts";
import { BlockEditor } from "./block-editor.tsx";
import { SettingsPopover, useCodexLookup } from "./settings-popover.tsx";
import { SidePanel } from "./side-panel.tsx";
import pageCss from "./page.css?raw";
import canvasCss from "./canvas.css?raw";
import katexCss from "katex/dist/katex.min.css?raw";
import "katex/dist/katex.min.css";
import "./page.css";
import "./canvas.css";
import "./view.css";

const PURIFY = { USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true } };
const MAX_UNDO = 50;
const FRESH_MS = 2_000;
const STATUS_MS = 5_000;

/** Model and agent text becomes HTML here; this window has the `window.scope` bridge. */
const safeHtml = (canvas: Canvas) => DOMPurify.sanitize(renderCanvas(canvas), PURIFY);

/**
 * Content keys that differ between two canvases: a section id when its name or size
 * changed or it was added or removed, and `sectionId/blockId` for each changed block.
 * Moving a section is layout, not content, so it is not listed.
 */
function changedKeys(before: Canvas, after: Canvas) {
  const keys = new Set<string>();
  const old = new Map(before.sections.map((section) => [section.id, section]));
  for (const section of after.sections) {
    const previous = old.get(section.id);
    old.delete(section.id);
    if (!previous) {
      keys.add(section.id);
      for (const block of section.blocks) keys.add(`${section.id}/${block.id}`);
      continue;
    }
    if (previous.name !== section.name || previous.size !== section.size) keys.add(section.id);
    const blocks = new Map(previous.blocks.map((block) => [block.id, JSON.stringify(block)]));
    for (const block of section.blocks) {
      if (blocks.get(block.id) !== JSON.stringify(block)) keys.add(`${section.id}/${block.id}`);
      blocks.delete(block.id);
    }
    for (const id of blocks.keys()) keys.add(`${section.id}/${id}`);
  }
  for (const id of old.keys()) keys.add(id);
  return keys;
}

const content = (section: Section) =>
  JSON.stringify({ name: section.name, size: section.size, blocks: section.blocks });

type Editing = { sectionId: string; original: Block; draft: Block };
/** One applied model reply, with copies of the sections it touched as they were before. */
type ModelEntry = {
  id: number;
  mark: number;
  before: { section: Section; index: number }[];
  created: string[];
};

function statusText(status: CanvasStatus) {
  switch (status.kind) {
    case "heard":
      return `Heard “${status.text}”`;
    case "working":
      return `Working on “${status.text}”`;
    case "done":
      return `Done: ${status.text}`;
    case "ignored":
      return `No change for “${status.text}”`;
    case "failed":
      return `Failed: ${status.text}`;
    case "cancelled":
      return `Cancelled “${status.text}”`;
    case "undone":
      return status.text;
  }
}

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
  const canvasRef = useRef<Canvas>(
    saved.canvas ?? (saved.page ? pageToCanvas(saved.page) : emptyCanvas()),
  );
  const settingsRef = useRef<MeetingSettings>(saved.settings ?? defaultMeetingSettings());
  const undoRef = useRef<Canvas[]>([]);
  const editedAt = useRef(new Map<string, number>());
  const editCount = useRef(0);
  const modelChanges = useRef<ModelEntry[]>([]);
  const changeCount = useRef(0);
  const focusRef = useRef<string | null>(canvasRef.current.sections.at(-1)?.id ?? null);
  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const followRef = useRef<string | null>(null);
  const [canvas, setCanvas] = useState(canvasRef.current);
  const [settings, setSettings] = useState(settingsRef.current);
  const [undoDepth, setUndoDepth] = useState(0);
  const [editing, setEditing] = useState<Editing>();
  const editingRef = useRef<string | undefined>(undefined);
  editingRef.current = editing ? `${editing.sectionId}/${editing.original.id}` : undefined;
  const [present, setPresent] = useState(false);
  const presentRef = useRef(present);
  presentRef.current = present;
  const [fresh, setFresh] = useState<{ keys: string[]; at: number }>({ keys: [], at: 0 });
  const [flashed, setFlashed] = useState<{ id: string; at: number }>();
  const [title, setTitle] = useState(canvasRef.current.title);
  const [notice, setNotice] = useState<{ text: string; kept?: boolean; error?: boolean }>();
  const [keeping, setKeeping] = useState(false);

  function save(nextCanvas: Canvas, nextSettings: MeetingSettings) {
    // Writing `canvas` without `page` retires the first test build's saved page.
    context.updateState({ version: 1, data: { canvas: nextCanvas, settings: nextSettings } });
  }
  function commit(next: Canvas, byPerson: boolean) {
    const previous = canvasRef.current;
    if (next === previous) return;
    if (byPerson) {
      editCount.current++;
      for (const key of changedKeys(previous, next)) editedAt.current.set(key, editCount.current);
    }
    undoRef.current = [...undoRef.current, previous].slice(-MAX_UNDO);
    canvasRef.current = next;
    if (focusRef.current && !next.sections.some((section) => section.id === focusRef.current))
      focusRef.current = next.sections.at(-1)?.id ?? null;
    setUndoDepth(undoRef.current.length);
    setCanvas(next);
    setTitle(next.title);
    save(next, settingsRef.current);
  }
  function updateSettings(patch: Partial<MeetingSettings>) {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    save(canvasRef.current, next);
  }

  /** Whether the person changed the section, or any block in it, after `mark`. */
  function sectionEditedAfter(id: string, mark: number) {
    if (editingRef.current?.startsWith(`${id}/`)) return true;
    for (const [key, at] of editedAt.current)
      if (at > mark && (key === id || key.startsWith(`${id}/`))) return true;
    return false;
  }

  function showChange(before: Canvas, after: Canvas, sections: readonly string[]) {
    setFresh({ keys: [...changedKeys(before, after), ...sections], at: Date.now() });
    const last = sections.at(-1);
    if (last) followRef.current = last;
  }

  function applyModelOps(ops: readonly CanvasOp[], mark: number): ModelChange {
    const before = canvasRef.current;
    const blocked = "You changed this while the model was working.";
    const result = applyCanvasOps(before, ops, focusRef.current, (section, block) => {
      if (block === null) return sectionEditedAfter(section, mark) ? blocked : null;
      const key = `${section}/${block}`;
      return key === editingRef.current || (editedAt.current.get(key) ?? 0) > mark ? blocked : null;
    });
    const applied = ops.length - result.rejected.length;
    let change: number | null = null;
    if (applied > 0) {
      const after = result.canvas;
      const touched = before.sections
        .map((section, index) => ({ section, index }))
        .filter(({ section }) => {
          const now = after.sections.find((entry) => entry.id === section.id);
          return !now || content(now) !== content(section);
        });
      const created = result.created.filter(
        (id) => !before.sections.some((section) => section.id === id),
      );
      change = ++changeCount.current;
      modelChanges.current = [
        ...modelChanges.current,
        { id: change, mark: editCount.current, before: touched, created },
      ].slice(-MAX_UNDO);
      commit(after, false);
      if (result.changed.length) focusRef.current = result.changed.at(-1)!;
      showChange(before, after, result.changed);
    }
    const names = result.changed.flatMap(
      (id) => canvasRef.current.sections.find((section) => section.id === id)?.name ?? [],
    );
    return { applied, rejected: result.rejected, sections: names, change };
  }

  /**
   * Voice undo: restores only the sections one model reply touched and removes the ones
   * it created. Sections the person edited since then keep the person's version.
   */
  function undoModelChange(id?: number): string | null {
    const entries = modelChanges.current;
    const index = id === undefined ? entries.length - 1 : entries.findIndex((e) => e.id === id);
    const entry = entries[index];
    if (!entry) return null;
    modelChanges.current = entries.filter((other) => other !== entry);
    const before = canvasRef.current;
    const sections = [...before.sections];
    const restored: { id: string; name: string }[] = [];
    const kept: string[] = [];
    for (const { section: old, index: position } of entry.before) {
      const at = sections.findIndex((section) => section.id === old.id);
      const current = sections[at];
      if (sectionEditedAfter(old.id, entry.mark)) {
        if (current) kept.push(current.name);
        continue;
      }
      if (current) sections[at] = { ...old, pinned: current.pinned, x: current.x, y: current.y };
      else if (sections.length < MAX_SECTIONS)
        sections.splice(Math.min(position, sections.length), 0, old);
      else continue;
      restored.push(old);
    }
    for (const created of entry.created) {
      const at = sections.findIndex((section) => section.id === created);
      if (at < 0) continue;
      if (sectionEditedAfter(created, entry.mark)) kept.push(sections[at]!.name);
      else restored.push(...sections.splice(at, 1));
    }
    const keptText = kept.length ? ` Kept your edits to ${kept.join(", ")}.` : "";
    if (!restored.length) return `Nothing to undo.${keptText}`;
    const after = { ...before, sections };
    commit(after, false);
    showChange(
      before,
      after,
      restored.flatMap(({ id }) => (sections.some((section) => section.id === id) ? [id] : [])),
    );
    return `Undid the change to ${restored.map(({ name }) => name).join(", ")}.${keptText}`;
  }

  // The loop outlives renders, so it reaches the latest canvas and handlers through refs.
  const applyRef = useRef(applyModelOps);
  applyRef.current = applyModelOps;
  const undoModelRef = useRef(undoModelChange);
  undoModelRef.current = undoModelChange;
  const [loop] = useState(
    () =>
      new MeetingLoop({
        canvas: () => canvasRef.current,
        settings: () => settingsRef.current,
        focus: () => focusRef.current,
        editMark: () => editCount.current,
        apply: (ops, mark) => applyRef.current(ops, mark),
        undoModelChange: (id) => undoModelRef.current(id),
      }),
  );
  useEffect(() => {
    loop.resume();
    return () => loop.dispose();
  }, [loop]);
  const loopState = useSyncExternalStore(loop.subscribe, loop.snapshot);
  const listening = loopState.listening !== "off";

  function replaceSection(id: string, change: (section: Section) => Section | null): Canvas {
    const current = canvasRef.current;
    return {
      ...current,
      sections: current.sections.flatMap((section) => {
        if (section.id !== id) return [section];
        const next = change(section);
        return next ? [next] : [];
      }),
    };
  }

  function finishEditing(keep: boolean) {
    const current = editing;
    setEditing(undefined);
    if (!current || !keep) return;
    const { sectionId, original, draft } = current;
    if (JSON.stringify(original) === JSON.stringify(draft)) return;
    commit(
      replaceSection(sectionId, (section) => ({
        ...section,
        blocks: section.blocks.map((block) => (block.id === original.id ? draft : block)),
      })),
      true,
    );
  }
  const finishRef = useRef(finishEditing);
  finishRef.current = finishEditing;

  useEffect(
    () =>
      context.onBeforeClose(async () => {
        loop.stop();
        finishRef.current(true);
      }),
    [context, loop],
  );

  const shown = useMemo(() => {
    if (!editing) return canvas;
    return {
      ...canvas,
      sections: canvas.sections.map((section) =>
        section.id === editing.sectionId
          ? {
              ...section,
              blocks: section.blocks.map((block) =>
                block.id === editing.original.id ? editing.draft : block,
              ),
            }
          : section,
      ),
    };
  }, [canvas, editing]);
  const html = useMemo(() => safeHtml(shown), [shown]);

  // The camera outlives renders, so it reaches the latest handlers through refs.
  const openRef = useRef(openBlock);
  openRef.current = openBlock;
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const [camera] = useState(
    () =>
      new CanvasCamera({
        present: () => presentRef.current,
        editing: () => editingRef.current !== undefined,
        press: (target) => openRef.current(target),
        drop: (id, x, y) =>
          commitRef.current(
            replaceSection(id, (section) => ({ ...section, pinned: true, x, y })),
            true,
          ),
        skipped: (id) => setFlashed({ id, at: Date.now() }),
      }),
  );

  // Runs before the render effect below so the camera has its elements when it first places.
  // Wheel needs a non-passive listener to keep the page from scrolling or zooming.
  useLayoutEffect(() => {
    const area = viewport.current;
    camera.viewport = area;
    camera.world = world.current;
    if (!area) return;
    area.addEventListener("wheel", camera.wheel, { passive: false });
    return () => area.removeEventListener("wheel", camera.wheel);
  }, [camera]);
  useEffect(() => {
    if (active) return camera.place();
    loop.stop();
    setPresent(false);
  }, [active, camera, loop]);
  useLayoutEffect(() => {
    const element = world.current;
    if (!element) return;
    element.innerHTML = html;
    for (const block of element.querySelectorAll<HTMLElement>("[data-block]")) {
      if (present) continue;
      block.tabIndex = 0;
      block.setAttribute("role", "button");
      block.setAttribute("aria-label", `Edit block ${block.dataset.block}`);
      if (block.dataset.block === editingRef.current) block.classList.add("is-editing");
    }
    if (Date.now() - fresh.at < FRESH_MS)
      for (const key of fresh.keys)
        element
          .querySelector(`[data-block="${CSS.escape(key)}"], [data-section="${CSS.escape(key)}"]`)
          ?.classList.add("is-fresh");
    camera.markOverlaps();
    camera.place();
    const target = followRef.current;
    followRef.current = null;
    if (target) camera.follow(target);
  }, [camera, html, present, editing?.original.id, fresh]);
  useEffect(() => {
    if (!fresh.keys.length) return;
    const timer = setTimeout(() => {
      for (const element of world.current?.querySelectorAll(".is-fresh") ?? [])
        element.classList.remove("is-fresh");
    }, FRESH_MS);
    return () => clearTimeout(timer);
  }, [fresh]);
  useEffect(() => {
    if (!present) return;
    camera.fitAll();
    const exit = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPresent(false);
    };
    window.addEventListener("keydown", exit);
    return () => window.removeEventListener("keydown", exit);
  }, [camera, present]);
  const [, setStatusClock] = useState(0);
  useEffect(() => {
    const status = loopState.status;
    if (!status || status.kind === "heard" || status.kind === "working") return;
    const timer = setTimeout(() => setStatusClock((n) => n + 1), STATUS_MS);
    return () => clearTimeout(timer);
  }, [loopState.status]);

  const codex = useCodexLookup(settings.codexPath, settings.backend === "codex");

  function openBlock(target: EventTarget | null) {
    if (present || !(target instanceof Element)) return;
    const key = target.closest<HTMLElement>("[data-block]")?.dataset.block;
    if (!key || key === editingRef.current) return;
    const [sectionId, blockId] = key.split("/");
    const section = canvasRef.current.sections.find((entry) => entry.id === sectionId);
    const block = section?.blocks.find((entry) => entry.id === blockId);
    if (!section || !block) return;
    finishEditing(true);
    setEditing({ sectionId: section.id, original: block, draft: block });
  }
  function undo() {
    const previous = undoRef.current.at(-1);
    if (!previous) return;
    setEditing(undefined);
    const current = canvasRef.current;
    undoRef.current = undoRef.current.slice(0, -1);
    editCount.current++;
    for (const key of changedKeys(current, previous)) editedAt.current.set(key, editCount.current);
    canvasRef.current = previous;
    setUndoDepth(undoRef.current.length);
    setCanvas(previous);
    setTitle(previous.title);
    save(previous, settingsRef.current);
  }
  function commitTitle() {
    const next = title.trim().slice(0, 160);
    if (next === canvasRef.current.title) return setTitle(next);
    commit({ ...canvasRef.current, title: next }, true);
  }
  async function keep() {
    finishEditing(true);
    setKeeping(true);
    setNotice(undefined);
    const current = canvasRef.current;
    const name = current.title.trim() || "Meeting canvas";
    try {
      await window.scope.keepMeetingPage({
        title: name,
        html: standaloneHtml({
          canvas: current,
          bodyHtml: safeHtml(current),
          css: `${katexCss}\n${pageCss}\n${canvasCss}`,
        }),
      });
      setNotice({ text: `Kept “${name}” as HTML. It opened as a new tab.`, kept: true });
    } catch (cause) {
      setNotice({ text: operationError(cause, "Could not keep the canvas. Retry."), error: true });
    } finally {
      setKeeping(false);
    }
  }
  function clearCanvas() {
    setEditing(undefined);
    commit({ ...emptyCanvas(), title: canvasRef.current.title }, true);
    setNotice({ text: "Canvas cleared. Undo brings it back." });
  }

  const indicator = listening && (
    <span className="mc-listening" role="status">
      <span className="mc-listening-dot" aria-hidden="true" />
      {loopState.listening === "starting" ? "Starting…" : "Listening"}
    </span>
  );
  const status = loopState.status;
  const showStatus =
    present &&
    status !== null &&
    (status.kind === "heard" || status.kind === "working" || Date.now() - status.at < STATUS_MS);
  const blockCount = canvas.sections.reduce((sum, section) => sum + section.blocks.length, 0);

  return (
    <div className={present ? "mc-view is-present" : "mc-view"}>
      {!present && (
        <header className="mc-header">
          <Input
            className="mc-title"
            aria-label="Canvas title"
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
              {notice.kept && canvas.sections.length > 0 && (
                <Button variant="ghost" size="sm" onClick={clearCanvas}>
                  <Eraser /> Clear canvas
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
        <main className="mc-stage">
          <div
            ref={viewport}
            className="mc-page mc-viewport"
            role="region"
            aria-label="Canvas"
            onPointerDown={(event) => camera.pointerDown(event)}
            onPointerMove={(event) => camera.pointerMove(event)}
            onPointerUp={(event) => camera.pointerUp(event)}
            onPointerCancel={() => camera.pointerCancel()}
            onClick={(event) => {
              // Links would navigate the whole Scope window; the kept HTML opens them instead.
              if (event.target instanceof Element && event.target.closest("a"))
                event.preventDefault();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                if (!(event.target instanceof HTMLElement) || !event.target.dataset.block) return;
                event.preventDefault();
                openBlock(event.target);
              }
            }}
          >
            <div ref={world} className="mc-world" />
          </div>
          {!present && canvas.sections.length === 0 && !editing && (
            <p className="mc-empty mc-muted">
              Turn on Listen and say “Canvas, draw …”, or ask the canvas in the side panel. Drag a
              section by its name to move it; click a block to edit it.
            </p>
          )}
          {!present && (
            <div className="mc-zoom" role="toolbar" aria-label="Zoom">
              <Button variant="ghost" size="sm" onClick={() => camera.fitAll()}>
                <Maximize /> Fit all
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Zoom out"
                title="Zoom out"
                onClick={() => camera.zoomBy(1 / 1.25)}
              >
                <Minus />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                title="Zoom to 100%"
                aria-label="Zoom to 100%"
                onClick={() => camera.zoomReset()}
              >
                <span ref={(label) => camera.showZoomIn(label)} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Zoom in"
                title="Zoom in"
                onClick={() => camera.zoomBy(1.25)}
              >
                <Plus />
              </Button>
            </div>
          )}
          {showStatus && (
            <p className={`mc-status is-${status.kind}`} role="status">
              {statusText(status)}
            </p>
          )}
          {editing && !present && (
            <BlockEditor
              block={editing.draft}
              onChange={(draft) => setEditing({ ...editing, draft })}
              onDone={() => finishEditing(true)}
              onCancel={() => finishEditing(false)}
              onDelete={() => {
                const { sectionId, original } = editing;
                setEditing(undefined);
                commit(
                  replaceSection(sectionId, (section) => ({
                    ...section,
                    blocks: section.blocks.filter((block) => block.id !== original.id),
                  })),
                  true,
                );
              }}
            />
          )}
        </main>
        {!present && (
          <SidePanel
            loop={loopState}
            sections={canvas.sections}
            flashed={flashed}
            blockCount={blockCount}
            onAsk={(request) => loop.ask(request)}
            onSelectSection={(id) => camera.showSection(id)}
          />
        )}
      </div>
      {present && (
        <div className="mc-present-bar">
          {!listening && loopState.error && (
            <span role="alert" className="mc-error">
              {loopState.error}
            </span>
          )}
          {indicator}
          <Button variant="outline" size="sm" onClick={() => setPresent(false)}>
            <X /> Exit present
          </Button>
        </div>
      )}
    </div>
  );
}
