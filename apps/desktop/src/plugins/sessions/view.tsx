import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { SESSION_DAYS, type SessionDays, type SessionsReply } from "@irudd-scope/sessions/contract";
import { Button } from "../../renderer/components/ui/button.tsx";
import { NativeSelect, NativeSelectOption } from "../../renderer/components/ui/native-select.tsx";
import { localMachineName } from "../../renderer/remote-names.ts";
import { operationError } from "../../renderer/operation-error.ts";
import { ToolCalls } from "./calls.tsx";
import { buildModel, descendants, type ThreadNode } from "./model.ts";
import { ThreadPage } from "./thread-page.tsx";
import { ThreadsList } from "./threads.tsx";
import "./style.css";

const ALL = "";

function useSessions(days: SessionDays) {
  const [reply, setReply] = useState<SessionsReply | null>(null);
  const [reading, setReading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const read = useCallback(() => {
    const id = ++latest.current;
    setReading(true);
    setError(null);
    window.scope.readSessions({ days }).then(
      (next) => {
        if (id !== latest.current) return;
        setReply(next);
        setReading(false);
      },
      (failure: unknown) => {
        if (id !== latest.current) return;
        setError(operationError(failure, "Scope could not read this computer's agent sessions."));
        setReading(false);
      },
    );
  }, [days]);
  useEffect(() => {
    read();
    return () => {
      latest.current++;
    };
  }, [read]);
  return { reply, reading, error, read };
}

/** Which machine, project and time span the tab shows. */
function ScopePicker({
  days,
  setDays,
  project,
  setProject,
  projects,
}: {
  days: SessionDays;
  setDays: (days: SessionDays) => void;
  project: string;
  setProject: (project: string) => void;
  projects: string[];
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === "Escape"
          : !box.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const machine = localMachineName(window.scope.platform);
  return (
    <div className="sessions-scope" ref={box}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {machine} · {project || "All projects"} · last {days} day{days > 1 ? "s" : ""} ▾
      </button>
      {open && (
        <div className="sessions-pop">
          <div className="sessions-pop-field">
            <span>Machine</span>
            <span className="sessions-pop-value">{machine}</span>
          </div>
          <label className="sessions-pop-field">
            <span>Project</span>
            <NativeSelect value={project} onChange={(event) => setProject(event.target.value)}>
              <NativeSelectOption value={ALL}>All projects</NativeSelectOption>
              {projects.map((name) => (
                <NativeSelectOption key={name} value={name}>
                  {name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <label className="sessions-pop-field">
            <span>Time span</span>
            <NativeSelect
              value={days}
              onChange={(event) => setDays(Number(event.target.value) as SessionDays)}
            >
              {SESSION_DAYS.map((value) => (
                <NativeSelectOption key={value} value={value}>
                  Last {value} day{value > 1 ? "s" : ""}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        </div>
      )}
    </div>
  );
}

export function SessionsView() {
  const [days, setDays] = useState<SessionDays>(3);
  const [project, setProject] = useState(ALL);
  const [view, setView] = useState<"threads" | "calls">("threads");
  const [openId, setOpenId] = useState<string | null>(null);
  const { reply, reading, error, read } = useSessions(days);
  const model = useMemo(() => (reply ? buildModel(reply) : null), [reply]);
  const roots = useMemo(
    () => model?.roots.filter((node) => !project || node.project === project) ?? [],
    [model, project],
  );
  const shown = useMemo(() => roots.flatMap(descendants), [roots]);
  const calls = useMemo(() => shown.flatMap((node) => node.calls), [shown]);
  const titles = useMemo(
    () => new Map(shown.map((node) => [node.id, node.title || "Untitled thread"])),
    [shown],
  );
  const opened = openId ? model?.byId.get(openId) : undefined;
  const scroller = useRef<HTMLDivElement>(null);
  const open = (node: ThreadNode | null) => {
    setOpenId(node?.id ?? null);
    scroller.current?.scrollTo(0, 0);
  };

  return (
    <div className="sessions-view" ref={scroller}>
      <div className="sessions-nav">
        {!opened &&
          (
            [
              ["threads", "Threads"],
              ["calls", "Tool calls"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              onClick={() => setView(value)}
            >
              {label}
            </button>
          ))}
        <span className="sessions-grow" />
        {reading && reply && <span className="sessions-muted">Reading…</span>}
        <ScopePicker
          days={days}
          setDays={setDays}
          project={project}
          setProject={setProject}
          projects={model?.projects ?? []}
        />
        <Button variant="outline" size="sm" onClick={read} disabled={reading}>
          <RefreshCw />
          Reload
        </Button>
      </div>
      <main className="sessions-main">
        {error && (
          <div className="sessions-error" role="alert">
            {error}
            <Button variant="outline" size="sm" onClick={read}>
              Retry
            </Button>
          </div>
        )}
        {!reply && reading && (
          <p className="sessions-empty">Reading T3 Code history on this computer…</p>
        )}
        {model &&
          (opened ? (
            <ThreadPage node={opened} byId={model.byId} onOpen={open} onBack={() => open(null)} />
          ) : !roots.length ? (
            <p className="sessions-empty">
              No T3 Code threads {project ? `in ${project} ` : ""}in the last {days} day
              {days > 1 ? "s" : ""}.
            </p>
          ) : view === "threads" ? (
            <ThreadsList roots={roots} all={shown} onOpen={open} />
          ) : (
            <ToolCalls calls={calls} title={(call) => titles.get(call.threadId) ?? ""} />
          ))}
      </main>
    </div>
  );
}
