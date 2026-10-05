import { MemoryEditor } from "./editor.tsx";
import { useContext, useEffect, useRef, useState } from "react";
import { BookOpen, Network, RefreshCw, Search } from "lucide-react";
import { decode } from "@irudd-scope/protocol";
import type { TabPlugin, TabProps } from "../api.ts";
import { Button } from "../../renderer/components/ui/button.tsx";
import { Input } from "../../renderer/components/ui/input.tsx";
import { SettingsContext } from "../../renderer/settings-context.tsx";
import { useMemory } from "../../renderer/memory-settings.tsx";
import { flushWorkspace } from "../../workspace/persistence.ts";
import {
  MemoryTabState,
  type MemoryConcept,
  type MemoryGraph,
  type MemorySearch,
  type MemoryCommand,
} from "./contract.ts";
import { MemoryGraphView } from "./graph.tsx";
import { MemoryWiki } from "./wiki.tsx";
import "./style.css";

type WithoutTab<T> = T extends unknown ? Omit<T, "tabId"> : never;

function MemoryView({ tab, context, active }: TabProps) {
  const data = decode(MemoryTabState, tab.state).data;
  const latest = useRef(data);
  latest.current = data;
  function change(next: typeof data) {
    latest.current = next;
    context.updateState({ version: 1, data: next });
  }
  const { status, error: statusError } = useMemory();
  const settings = useContext(SettingsContext);
  const repository = status?.configuration.repository ?? null;
  const source = status?.machines.find((machine) => machine.local)?.status;
  const available = !!(
    status?.configuration.enabled &&
    repository &&
    source?.repository === repository &&
    source.root &&
    source.bundle === "registered" &&
    source.okf.installed
  );
  const identity = `${repository ?? ""}:${available}:${source?.root ?? ""}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const path = data.path ?? "index.md";
  const mode = data.mode ?? "wiki";
  const [concept, setConcept] = useState<MemoryConcept>();
  const [graph, setGraph] = useState<MemoryGraph>();
  const [graphFailed, setGraphFailed] = useState(false);
  const [search, setSearch] = useState<MemorySearch>();
  const [query, setQuery] = useState("");
  const [nearby, setNearby] = useState(false);
  const canFocus = !["index.md", "log.md"].includes(path.split("/").at(-1)!);
  const focused = nearby && canFocus;
  const [refresh, setRefresh] = useState(0);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [incoming, setIncoming] = useState<MemoryConcept>();
  const readSequence = useRef(0);
  const graphSequence = useRef(0);
  const graphScope = useRef("");
  const searchSequence = useRef(0);
  const editorGeneration = useRef(0);

  function invalidateComparison() {
    ++editorGeneration.current;
    setIncoming(undefined);
  }

  async function request(command: WithoutTab<MemoryCommand>) {
    const reply = await window.scope.memoryCommand({ ...command, tabId: tab.id } as MemoryCommand);
    if (reply.action === "error") throw new Error(reply.message);
    return reply;
  }
  async function readNote(notePath: string) {
    if (!repository || !available) return;
    const token = ++readSequence.current;
    const captured = identity;
    setReading(true);
    setError("");
    try {
      const reply = await request({ action: "read", repository, path: notePath });
      if (
        token !== readSequence.current ||
        captured !== currentIdentity.current ||
        reply.action !== "read"
      )
        return;
      setConcept(reply.concept);
    } catch (cause) {
      if (token === readSequence.current && captured === currentIdentity.current)
        setError(message(cause));
    } finally {
      if (token === readSequence.current) setReading(false);
    }
  }
  useEffect(() => {
    ++readSequence.current;
    ++graphSequence.current;
    ++searchSequence.current;
    setConcept(undefined);
    setGraph(undefined);
    setGraphFailed(false);
    setSearch(undefined);
    invalidateComparison();
    setError("");
    setNotice("");
    if (available) void readNote(path);
  }, [identity, path, refresh]);
  useEffect(() => {
    if (!available || !repository || mode !== "graph" || !active) return;
    const token = ++graphSequence.current;
    const captured = identity;
    const scope = `${identity}:${focused ? path : "*"}`;
    if (graphScope.current !== scope) {
      graphScope.current = scope;
      setGraph(undefined);
    }
    setGraphFailed(false);
    setError("");
    void request({ action: "graph", repository, ...(focused ? { path } : {}) })
      .then((reply) => {
        if (
          reply.action === "graph" &&
          token === graphSequence.current &&
          captured === currentIdentity.current
        )
          setGraph(reply.graph);
      })
      .catch((cause: unknown) => {
        if (token === graphSequence.current && captured === currentIdentity.current) {
          setGraphFailed(true);
          setError(message(cause));
        }
      });
  }, [identity, mode, path, focused, active, refresh]);

  function open(notePath: string) {
    if (saving) {
      setError("Wait for this note to finish saving before opening another note.");
      return;
    }
    if (
      latest.current.draft &&
      (latest.current.draft.repository !== repository || latest.current.draft.path !== notePath)
    ) {
      setError(
        "Save or discard the retained draft before opening another note. Copy draft keeps a separate copy.",
      );
      return;
    }
    setSearch(undefined);
    setNotice("");
    invalidateComparison();
    change({ ...latest.current, path: notePath, mode: "wiki" });
  }
  function edit() {
    if (!concept || !repository || !available) return;
    invalidateComparison();
    setNotice("");
    change({
      ...latest.current,
      draft: { repository, path: concept.path, expectedHash: concept.hash, raw: concept.raw },
    });
  }
  function clearDraft() {
    const { draft: _draft, ...rest } = latest.current;
    change(rest);
    invalidateComparison();
    setError("");
  }
  async function save() {
    const draft = latest.current.draft;
    if (!draft || draft.repository !== repository || !available || saving) return;
    const captured = identity;
    invalidateComparison();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await flushWorkspace("save", tab.id);
      const reply = await request({ action: "save", ...draft });
      if (reply.action !== "save") return;
      clearDraft();
      if (captured !== currentIdentity.current) return;
      await readNote(draft.path);
      try {
        await flushWorkspace("save", tab.id);
      } catch (cause) {
        change({
          ...latest.current,
          path: draft.path,
          mode: "wiki",
          draft: { ...draft, expectedHash: reply.hash },
        });
        throw new Error(
          `The file was saved, but Scope could not save the editor state. Your draft is kept. ${message(cause)}`,
        );
      }
      setNotice("Saved to personal memory. Scope will sync the change.");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  }
  async function compare() {
    const draft = latest.current.draft;
    if (!draft || draft.repository !== repository) return;
    const captured = identity;
    const generation = ++editorGeneration.current;
    setIncoming(undefined);
    const current = () => {
      const editing = latest.current.draft;
      return (
        captured === currentIdentity.current &&
        generation === editorGeneration.current &&
        editing?.repository === draft.repository &&
        editing.path === draft.path &&
        editing.expectedHash === draft.expectedHash
      );
    };
    try {
      const reply = await request({
        action: "read",
        repository: draft.repository,
        path: draft.path,
      });
      if (current() && reply.action === "read") setIncoming(reply.concept);
    } catch (cause) {
      if (current()) setError(message(cause));
    }
  }
  async function find(offset = 0, text = query) {
    if (!text.trim() || !repository || !available) return;
    const token = ++searchSequence.current;
    const captured = identity;
    setError("");
    setNotice("Searching…");
    try {
      const reply = await request({
        action: "search",
        repository,
        query: text.trim(),
        offset,
      });
      if (
        reply.action === "search" &&
        token === searchSequence.current &&
        captured === currentIdentity.current
      ) {
        setSearch(reply.search);
        setNotice("");
        change({ ...latest.current, mode: "wiki" });
      }
    } catch (cause) {
      if (token === searchSequence.current && captured === currentIdentity.current) {
        setError(message(cause));
        setNotice("");
      }
    }
  }
  const draft = data.draft;
  function validIncoming() {
    const editing = latest.current.draft;
    return available && editing?.repository === repository && incoming?.path === editing.path;
  }
  return (
    <div className="memory-view">
      <header className="memory-toolbar">
        <div className="memory-view-switch">
          <Button
            variant="ghost"
            aria-pressed={mode === "wiki"}
            onClick={() => change({ ...latest.current, mode: "wiki" })}
          >
            <BookOpen /> Wiki
          </Button>
          <Button
            variant="ghost"
            aria-pressed={mode === "graph"}
            onClick={() => change({ ...latest.current, mode: "graph" })}
          >
            <Network /> Graph
          </Button>
        </div>
        <form
          className="memory-search"
          onSubmit={(event) => {
            event.preventDefault();
            void find();
          }}
        >
          <Input
            aria-label="Search personal memory"
            placeholder="Search memory…"
            value={query}
            maxLength={512}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button
            variant="ghost"
            size="icon"
            type="submit"
            aria-label="Search memory"
            disabled={!available || !query.trim()}
          >
            <Search />
          </Button>
        </form>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh memory"
          disabled={!available || saving}
          onClick={() => {
            setSearch(undefined);
            setNotice("");
            setRefresh((value) => value + 1);
          }}
        >
          <RefreshCw />
        </Button>
      </header>
      <div className="memory-location">
        <span>{repository ?? "Personal memory"}</span>
        <Button variant="ghost" size="sm" disabled={!available} onClick={() => open("index.md")}>
          Wiki index
        </Button>
        <Button variant="ghost" size="sm" onClick={() => settings?.openSettings("memory")}>
          Memory settings
        </Button>
      </div>
      {(error || statusError) && (
        <p role="alert" className="memory-error">
          {error || statusError}
        </p>
      )}
      {notice && (
        <p role="status" className="memory-notice">
          {notice}
        </p>
      )}
      {!available && (
        <p role="status" className="memory-notice">
          {!status
            ? "Loading memory status…"
            : !status.configuration.enabled
              ? "Turn on Memory in Settings to browse the connected repository."
              : !repository
                ? "Connect a personal memory repository in Settings."
                : (source?.bundleMessage ??
                  source?.message ??
                  "Personal memory is not ready. Check Memory in Settings and retry.")}
        </p>
      )}
      {draft && (
        <MemoryEditor
          key={`${draft.repository}:${draft.path}:${draft.expectedHash}`}
          draft={draft}
          saving={saving}
          enabled={available && draft.repository === repository}
          incoming={incoming}
          onChange={(raw) => {
            invalidateComparison();
            change({ ...latest.current, draft: { ...draft, raw } });
          }}
          onSave={() => void save()}
          onDiscard={clearDraft}
          onCompare={() => void compare()}
          onUseIncoming={() => {
            if (incoming && validIncoming()) {
              clearDraft();
              setConcept(incoming);
            }
          }}
          onUseBase={() => {
            if (incoming && latest.current.draft && validIncoming()) {
              change({
                ...latest.current,
                draft: { ...latest.current.draft, expectedHash: incoming.hash },
              });
              invalidateComparison();
              setNotice(
                "Your draft is kept. Save note will check the reviewed saved version again.",
              );
            }
          }}
          onNotice={setNotice}
          onError={setError}
        />
      )}
      {available && mode === "graph" ? (
        <>
          <div className="memory-graph-controls">
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={!focused}
              onClick={() => setNearby(false)}
            >
              All notes
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!canFocus}
              aria-pressed={focused}
              onClick={() => setNearby(true)}
            >
              Nearby notes
            </Button>
            <span className="secondary">{focused ? path : "Personal memory"}</span>
          </div>
          {graph ? (
            <MemoryGraphView graph={graph} onOpen={open} />
          ) : (
            <p role="status">
              {graphFailed ? "Graph could not be loaded. Refresh to retry." : "Loading graph…"}
            </p>
          )}
        </>
      ) : search ? (
        <section className="memory-results">
          <div className="memory-note-actions">
            <h2>Search results</h2>
            <Button variant="ghost" size="sm" onClick={() => setSearch(undefined)}>
              Back to wiki
            </Button>
          </div>
          <p>
            {search.total
              ? `${search.offset + 1} to ${Math.min(search.offset + search.results.length, search.total)} of ${search.total}`
              : "No matching notes. Try another word."}
          </p>
          <ul className="memory-link-list">
            {search.results.map((hit) => (
              <li key={hit.path}>
                <button onClick={() => open(hit.path)}>{hit.title}</button>
                <small>{hit.path}</small>
                <p>{hit.excerpt || hit.description}</p>
              </li>
            ))}
          </ul>
          <div className="memory-note-actions">
            <Button
              variant="ghost"
              disabled={!search.offset}
              onClick={() => void find(Math.max(0, search.offset - 30), search.query)}
            >
              Previous
            </Button>
            <Button
              variant="ghost"
              disabled={search.offset + 30 >= search.total}
              onClick={() => void find(search.offset + 30, search.query)}
            >
              Next
            </Button>
          </div>
        </section>
      ) : concept && available ? (
        <section className="memory-note">
          <div className="memory-note-actions">
            <code>{concept.path}</code>
            <Button variant="secondary" size="sm" disabled={!!draft || saving} onClick={edit}>
              Edit Markdown
            </Button>
          </div>
          <MemoryWiki concept={concept} onOpen={open} onError={setError} />
        </section>
      ) : (
        reading && <p role="status">Loading note…</p>
      )}
    </div>
  );
}

function message(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "Memory could not be loaded. Retry. Your draft is kept.";
}

export const memoryPlugin: TabPlugin = { type: "memory", View: MemoryView };
