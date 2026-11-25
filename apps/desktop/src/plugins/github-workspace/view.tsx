import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceSnapshot } from "@irudd-scope/protocol/github-workspace";
import type { TabProps } from "../api.ts";
import { Button } from "../../renderer/components/ui/button.tsx";
import { githubWorkspaceDocument } from "./frame-sdk.ts";
import { WorkspaceFrameHost } from "./frame-host.ts";
import { WorkspaceContentWindow } from "./content-window.tsx";
import type { ContentWindow } from "./window-content.ts";

const failureMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Could not load the workspace.";

export function GitHubWorkspaceTabView({ artifact, active, theme, context }: TabProps) {
  const name = artifact?.name;
  const [content, setContent] = useState<{ html: string; revision: number }>();
  const [readError, setReadError] = useState("");
  const [contentError, setContentError] = useState("");
  const [linkError, setLinkError] = useState("");
  const [retry, setRetry] = useState(0);
  const [freshness, setFreshness] = useState<WorkspaceSnapshot["sync"]>();
  const [counts, setCounts] = useState({ issues: 0, prs: 0 });
  const [windows, setWindows] = useState<ContentWindow[]>([]);
  const [now, setNow] = useState(Date.now());
  const snapshot = useRef<WorkspaceSnapshot | undefined>(undefined);
  const refresh = useRef<() => Promise<void>>(async () => {});

  const identity = useMemo(
    () => ({ channel: crypto.randomUUID(), tabId: context.tabId }),
    [context.tabId, content?.revision],
  );
  const host = useMemo(
    () =>
      new WorkspaceFrameHost({
        name: name ?? "",
        identity,
        refresh: () => refresh.current(),
        onSnapshot: (value) => {
          snapshot.current = value;
          setFreshness(value.sync);
          setCounts({ issues: value.issues.length, prs: value.prs.length });
        },
        onWindows: setWindows,
        onError: setReadError,
        onLinkError: setLinkError,
      }),
    [identity, name],
  );
  const document = useMemo(
    () => (content ? githubWorkspaceDocument(content.html, identity) : undefined),
    [content, identity],
  );
  const flushFrame = useRef<() => Promise<void>>(async () => {});
  flushFrame.current = () => host.flushAll("close");

  useEffect(() => {
    setWindows([]);
    const stop = host.start();
    const stopClosing = context.onBeforeClose((purpose) => host.flushAll(purpose));
    return () => {
      stopClosing();
      stop();
    };
  }, [host, context.tabId]);

  useEffect(() => {
    if (!name) return;
    let mounted = true;
    let requested = 0;
    let reading: Promise<void> | undefined;
    async function reload(): Promise<void> {
      requested++;
      if (reading) return reading;
      reading = (async () => {
        let read: number;
        do {
          read = requested;
          try {
            const reply = await window.scope.githubWorkspaceCommand({
              action: "read",
              name: name!,
            });
            if (!mounted) return;
            if (reply.type !== "snapshot" || reply.snapshot.tabId !== context.tabId)
              throw new Error("This workspace no longer matches the saved tab.");
            if (reply.snapshot.generation >= (snapshot.current?.generation ?? -1)) {
              host.setSnapshot(reply.snapshot);
              setReadError("");
            }
          } catch (error) {
            if (mounted) setReadError(failureMessage(error));
          }
        } while (mounted && read !== requested);
      })().finally(() => {
        reading = undefined;
      });
      return reading;
    }
    refresh.current = reload;
    const stopChanges = window.scope.onGitHubWorkspaceChanged((event) => {
      if (event.name === name && event.id === artifact?.id) {
        if (event.stateChange && event.tabId === context.tabId)
          host.stateChanged(event.stateChange);
        if (event.nodeStateChange && event.tabId === context.tabId)
          host.nodeStateChanged(event.nodeStateChange);
        void reload();
      }
    });
    const stopReconnect = window.scope.onGitHubWorkspaceReconnected(() => {
      void reload().then(() => host.refreshNodeStates());
      void host.refreshInterest().catch(() => {});
    });
    void reload();
    return () => {
      mounted = false;
      stopChanges();
      stopReconnect();
    };
  }, [name, context.tabId, retry, host, artifact?.id]);

  useEffect(() => {
    if (!artifact) return;
    let mounted = true;
    void window.scope
      .content(artifact.id, artifact.revision)
      .then(async (item) => {
        if (content && content.revision !== artifact.revision) await flushFrame.current();
        if (mounted) {
          setContent((current) =>
            current?.revision === artifact.revision
              ? current
              : { html: new TextDecoder().decode(item.bytes), revision: artifact.revision },
          );
        }
      })
      .catch((error: unknown) => {
        if (mounted) setContentError(failureMessage(error));
      });
    return () => {
      mounted = false;
    };
  }, [artifact?.id, artifact?.revision, retry]);

  useEffect(() => {
    host.setTheme(theme);
  }, [theme, host]);

  useEffect(() => {
    if (!name) return;
    void host.setActive(active).catch((error: unknown) => setReadError(failureMessage(error)));
    return () => {
      void host.setActive(false).catch(() => {});
    };
  }, [active, name, host]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  const age = freshness?.lastSuccessAt
    ? Math.max(0, Math.floor((now - Date.parse(freshness.lastSuccessAt)) / 1000))
    : null;
  const interval = freshness?.intervalMs;
  const updated =
    age === null
      ? "Waiting for first refresh"
      : age < 60
        ? `Updated ${age}s ago`
        : age < 3600
          ? `Updated ${Math.floor(age / 60)}m ago`
          : `Updated ${Math.floor(age / 3600)}h ago`;
  const target = interval
    ? interval < 60_000
      ? `${Math.ceil(interval / 1000)}s`
      : `${Math.ceil(interval / 60_000)}m`
    : "";
  const status =
    freshness?.state === "error"
      ? `${updated} · ${freshness.error ?? "Refresh failed"}`
      : freshness?.state === "syncing"
        ? `${updated} · Refreshing…`
        : `${updated} · ${counts.issues} issues · ${counts.prs} PRs`;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", position: "relative" }}>
      {freshness && (
        <div
          role="status"
          aria-live="off"
          className="pull-requests-freshness"
          title={freshness.reason ?? undefined}
        >
          {status}
          {freshness.boardError ? ` · Board: ${freshness.boardError}` : ""}
          {target ? ` · Target ${target}` : ""}
        </div>
      )}
      {linkError && (
        <div role="alert">
          {linkError}{" "}
          <Button variant="ghost" onClick={() => setLinkError("")}>
            Dismiss
          </Button>
        </div>
      )}
      {(contentError || readError) && (
        <div role="alert">
          {contentError || readError}{" "}
          <Button variant="ghost" onClick={() => setRetry((value) => value + 1)}>
            Retry
          </Button>
        </div>
      )}
      <div
        style={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {document && (
          <iframe
            key={identity.channel}
            ref={(element) => host.attach("main", element)}
            name={`scope-github-workspace-${context.tabId}-${identity.channel}`}
            title={artifact?.title ?? "GitHub Workspace"}
            className="html-preview pull-requests-document"
            style={{ flex: 1, minHeight: 0 }}
            srcDoc={document}
            onLoad={() => {
              if (content?.revision === artifact?.revision) setContentError("");
            }}
          />
        )}
        {windows.map((entry) => (
          <WorkspaceContentWindow
            key={entry.environment.id}
            content={entry}
            host={host}
            onError={setReadError}
          />
        ))}
      </div>
    </div>
  );
}
