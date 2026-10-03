import { useEffect, useMemo, useRef, useState } from "react";
import { type PullRequestsSnapshot } from "@irudd-scope/protocol/pull-requests";
import type { TabProps } from "../api.ts";
import { Button } from "../../renderer/components/ui/button.tsx";
import { pullRequestsDocument } from "./frame-sdk.ts";
import { PullRequestsFrameHost } from "./frame-host.ts";
import { ContentWindowView } from "./content-window.tsx";
import type { ContentWindow } from "./window-content.ts";

const failureMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Could not load the PR inbox.";
export function PullRequestsView({ artifact, active, theme, context }: TabProps) {
  const name = artifact?.name;
  const [content, setContent] = useState<{ html: string; revision: number }>();
  const [readError, setReadError] = useState("");
  const [contentError, setContentError] = useState("");
  const [linkError, setLinkError] = useState("");
  const [retry, setRetry] = useState(0);
  const [freshness, setFreshness] = useState<PullRequestsSnapshot["sync"]>();
  const [prCount, setPrCount] = useState(0);
  const [windows, setWindows] = useState<ContentWindow[]>([]);
  const [now, setNow] = useState(Date.now());
  const snapshot = useRef<PullRequestsSnapshot | undefined>(undefined);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const identity = useMemo(
    () => ({ channel: crypto.randomUUID(), tabId: context.tabId }),
    [context.tabId, content?.revision],
  );
  const host = useMemo(
    () =>
      new PullRequestsFrameHost({
        name: name ?? "",
        identity,
        refresh: () => refresh.current(),
        onSnapshot: (value) => {
          snapshot.current = value;
          setFreshness(value.sync);
          setPrCount(value.prs.length);
        },
        onWindows: setWindows,
        onError: setReadError,
        onLinkError: setLinkError,
      }),
    [identity, name],
  );
  const document = useMemo(
    () => (content ? pullRequestsDocument(content.html, identity) : undefined),
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
            const reply = await window.scope.pullRequestsCommand({ action: "read", name: name! });
            if (!mounted) return;
            if (reply.type !== "snapshot" || reply.snapshot.tabId !== context.tabId)
              throw new Error(
                "This PR inbox no longer matches the saved tab. Your app edits are kept here.",
              );
            if (
              reply.type === "snapshot" &&
              reply.snapshot.tabId === context.tabId &&
              reply.snapshot.generation >= (snapshot.current?.generation ?? -1)
            ) {
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
    // Subscribe first so a write during the initial read always triggers another full read.
    const stopChanges = window.scope.onPullRequestsChanged((event) => {
      if (event.name === name && event.id === artifact?.id) void reload();
    });
    const stopReconnect = window.scope.onPullRequestsReconnected(() => {
      void reload();
      void host.refreshInterest().catch(() => {});
    });
    void reload();
    return () => {
      mounted = false;
      stopChanges();
      stopReconnect();
    };
  }, [name, context.tabId, retry, host]);
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
        ? `Updated ${age} seconds ago`
        : age < 3600
          ? `Updated ${Math.floor(age / 60)} minutes ago`
          : `Updated ${Math.floor(age / 3600)} hours ago`;
  const target = interval
    ? interval < 60_000
      ? `${Math.ceil(interval / 1000)} seconds`
      : `${Math.ceil(interval / 60_000)} minutes`
    : "";
  const status =
    freshness?.state === "error"
      ? `${updated} · ${freshness.error ?? "Refresh failed"}`
      : freshness?.state === "syncing"
        ? age === null && prCount > 0
          ? `Loaded ${prCount.toLocaleString()} PRs · Reading checks and conversations…`
          : `${updated} · Refreshing…`
        : updated;
  const retryAt =
    freshness?.state === "error" && freshness.nextAttemptAt
      ? ` · Retrying at ${new Date(freshness.nextAttemptAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "";
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
          {retryAt}
          {target ? ` · Refresh target ${target}` : ""}
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
            name={`scope-pull-requests-${context.tabId}-${identity.channel}`}
            title={artifact?.title ?? "PR inbox"}
            className="html-preview pull-requests-document"
            style={{ flex: 1, minHeight: 0 }}
            srcDoc={document}
            onLoad={() => {
              if (content?.revision === artifact?.revision) setContentError("");
            }}
          />
        )}
        {windows.map((content) => (
          <ContentWindowView
            key={content.environment.id}
            content={content}
            host={host}
            onError={setReadError}
          />
        ))}
      </div>
    </div>
  );
}
