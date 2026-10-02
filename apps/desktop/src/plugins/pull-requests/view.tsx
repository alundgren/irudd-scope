import { useEffect, useMemo, useRef, useState } from "react";
import { decode } from "@irudd-scope/protocol";
import {
  PullRequestsCommand,
  type PullRequestsSnapshot,
} from "@irudd-scope/protocol/pull-requests";
import type { TabProps } from "../api.ts";
import { Button } from "../../renderer/components/ui/button.tsx";
import { pullRequestsDocument, type FrameIdentity } from "./frame-sdk.ts";
import { PullRequestsInterest } from "./interest.ts";

const failureMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Could not load the PR inbox.";
type FrameCall = FrameIdentity & { id: string; method: string; args: unknown[] };

function frameCommand(
  call: FrameCall,
  snapshot: PullRequestsSnapshot,
  tabId: string,
): PullRequestsCommand {
  const base = { name: snapshot.artifact.name!, requestId: crypto.randomUUID(), tabId };
  if (call.method === "sync") return { ...base, action: "sync" };
  const pr = snapshot.prs.find((row) => row.nodeId === call.args[0]);
  if (!pr) throw new Error("This pull request is no longer open. Refresh the inbox.");
  const row = { ...base, nodeId: pr.nodeId };
  switch (call.method) {
    case "detail":
      return { ...row, action: "detail" };
    case "saveNote":
      return decode(PullRequestsCommand, {
        ...row,
        action: "note",
        expectedVersion: call.args[2],
        text: call.args[1],
      });
    case "setSnooze": {
      const value = call.args[1];
      if (!value || typeof value !== "object" || !("until" in value))
        throw new Error("Choose a snooze date or clear the snooze.");
      return decode(PullRequestsCommand, {
        ...row,
        action: "snooze",
        expectedVersion: call.args[2],
        snooze:
          value.until === null
            ? null
            : { ...value, headOid: "headOid" in value ? value.headOid : pr.headOid },
      });
    }
    case "markReviewed":
    case "inspect":
      return decode(PullRequestsCommand, {
        ...row,
        action: "review",
        expectedVersion: call.args[2],
        baseline: call.method === "inspect" ? "inspected" : "reviewed",
        headOid: call.args[1],
      });
    default:
      throw new Error("Unknown PR inbox operation.");
  }
}

export function PullRequestsView({ artifact, active, theme, context }: TabProps) {
  const name = artifact?.name;
  const [content, setContent] = useState<{ html: string; revision: number }>();
  const [readError, setReadError] = useState("");
  const [contentError, setContentError] = useState("");
  const [retry, setRetry] = useState(0);
  const [freshness, setFreshness] = useState<PullRequestsSnapshot["sync"]>();
  const [prCount, setPrCount] = useState(0);
  const [now, setNow] = useState(Date.now());
  const iframe = useRef<HTMLIFrameElement>(null);
  const snapshot = useRef<PullRequestsSnapshot | undefined>(undefined);
  const frameReady = useRef(false);
  const closeRequests = useRef(
    new Map<
      string,
      { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
    >(),
  );
  const flushFrame = useRef<() => Promise<void>>(async () => {});
  const sent = useRef("");
  const refresh = useRef<() => Promise<void>>(async () => {});
  const detailInterest = useRef<PullRequestsInterest["detail"]>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const identity = useMemo(
    () => ({ channel: crypto.randomUUID(), tabId: context.tabId }),
    [context.tabId, content?.revision],
  );
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const document = useMemo(
    () => (content ? pullRequestsDocument(content.html, identity) : undefined),
    [content, identity],
  );
  function reportInterest(forceRefresh = false) {
    return window.scope.pullRequestsInterest({
      tabId: context.tabId,
      active: activeRef.current,
      detail: detailInterest.current,
      ...(forceRefresh ? { refresh: true } : {}),
    });
  }
  function sendSnapshot() {
    const value = snapshot.current;
    if (!value || value.tabId !== context.tabId || !frameReady.current) return;
    const signature = `${identityRef.current.channel}:${value.generation}:${themeRef.current}`;
    if (sent.current === signature) return;
    sent.current = signature;
    iframe.current?.contentWindow?.postMessage(
      {
        ...identityRef.current,
        type: "scope-pull-requests-snapshot",
        generation: value.generation,
        value: {
          pullRequests: value.prs,
          context: {
            name,
            repository: value.repository,
            viewer: value.viewer,
            theme: themeRef.current,
          },
          sync: value.sync,
        },
      },
      "*",
    );
  }
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
              snapshot.current = reply.snapshot;
              setFreshness(reply.snapshot.sync);
              setPrCount(reply.snapshot.prs.length);
              sendSnapshot();
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
      void reportInterest(true).catch(() => {});
    });
    void reload();
    return () => {
      mounted = false;
      stopChanges();
      stopReconnect();
    };
  }, [name, context.tabId, retry]);
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
    let commands = Promise.resolve();
    let mounted = true;
    flushFrame.current = () => {
      if (!frameReady.current) return Promise.resolve();
      const id = crypto.randomUUID();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          closeRequests.current.delete(id);
          reject(new Error("The PR app did not finish saving. Retry before closing."));
        }, 8_000);
        closeRequests.current.set(id, { resolve, reject, timer });
        iframe.current?.contentWindow?.postMessage(
          { ...identity, type: "scope-pull-requests-close", id },
          "*",
        );
      });
    };
    const stopClosing = context.onBeforeClose(() => flushFrame.current());
    function receive(event: MessageEvent) {
      const call = event.data;
      if (
        event.source !== iframe.current?.contentWindow ||
        call?.channel !== identity.channel ||
        call?.tabId !== context.tabId
      )
        return;
      if (call.type === "scope-pull-requests-flushed") {
        const pending = closeRequests.current.get(call.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        closeRequests.current.delete(call.id);
        if (call.error) pending.reject(new Error(call.error));
        else pending.resolve();
        return;
      }
      if (call.type === "scope-pull-requests-ready") {
        sent.current = "";
        frameReady.current = true;
        sendSnapshot();
        return;
      }
      if (call.type === "scope-pull-requests-interest") {
        try {
          const input = decode(PullRequestsInterest, {
            tabId: context.tabId,
            active: activeRef.current,
            detail: call.detail,
          });
          detailInterest.current = input.detail;
          void reportInterest().catch((error: unknown) => {
            if (mounted) setReadError(failureMessage(error));
          });
        } catch (error) {
          setReadError(failureMessage(error));
        }
        return;
      }
      if (
        call.type !== "scope-pull-requests-call" ||
        typeof call.id !== "string" ||
        typeof call.method !== "string" ||
        !Array.isArray(call.args)
      )
        return;
      const execute = async () => {
        if (!mounted) return;
        try {
          if (!snapshot.current) {
            await refresh.current();
            if (!snapshot.current)
              throw new Error("The inbox is still loading. Retry in a moment.");
          }
          const reply = await window.scope.pullRequestsCommand(
            frameCommand(call, snapshot.current, context.tabId),
          );
          if (!mounted) return;
          if ((reply.type === "snapshot" ? reply.snapshot.tabId : reply.tabId) !== context.tabId)
            throw new Error("This reply belongs to another PR inbox.");
          if (reply.type === "detail" && reply.nodeId !== call.args[0])
            throw new Error("These details belong to another pull request.");
          if (
            reply.type === "snapshot" &&
            reply.snapshot.generation >= snapshot.current.generation
          ) {
            snapshot.current = reply.snapshot;
            setFreshness(reply.snapshot.sync);
            setPrCount(reply.snapshot.prs.length);
            sendSnapshot();
          }
          const local =
            reply.type === "snapshot"
              ? reply.snapshot.prs.find((pr) => pr.nodeId === call.args[0])?.local
              : undefined;
          const version =
            call.method === "saveNote"
              ? local?.noteVersion
              : call.method === "setSnooze"
                ? local?.snoozeVersion
                : local?.reviewVersion;
          iframe.current?.contentWindow?.postMessage(
            {
              ...identity,
              type: "scope-pull-requests-reply",
              id: call.id,
              value:
                reply.type === "detail"
                  ? reply.detail
                  : version === undefined
                    ? undefined
                    : { version },
            },
            "*",
          );
        } catch (error) {
          await refresh.current();
          if (mounted)
            iframe.current?.contentWindow?.postMessage(
              {
                ...identity,
                type: "scope-pull-requests-reply",
                id: call.id,
                error: failureMessage(error),
              },
              "*",
            );
        }
      };
      if (call.method === "sync" || call.method === "detail") void execute();
      else commands = commands.then(execute);
    }
    window.addEventListener("message", receive);
    const stopDetails = window.scope.onPullRequestsDetailUpdate((update) => {
      const current = detailInterest.current;
      if (
        !mounted ||
        !frameReady.current ||
        !current ||
        update.tabId !== context.tabId ||
        update.nodeId !== current?.nodeId ||
        update.headOid !== current.headOid ||
        update.baseOid !== current.baseOid
      )
        return;
      iframe.current?.contentWindow?.postMessage(
        { ...identity, type: "scope-pull-requests-detail-update", value: update },
        "*",
      );
    });
    return () => {
      mounted = false;
      frameReady.current = false;
      stopClosing();
      for (const pending of closeRequests.current.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("The PR app closed before saving completed."));
      }
      closeRequests.current.clear();
      window.removeEventListener("message", receive);
      stopDetails();
      detailInterest.current = null;
      void reportInterest().catch(() => {});
    };
  }, [identity, context.tabId]);
  useEffect(() => {
    sendSnapshot();
  }, [theme]);
  useEffect(() => {
    if (!name) return;
    void reportInterest().catch((error: unknown) => setReadError(failureMessage(error)));
    return () => {
      void window.scope
        .pullRequestsInterest({
          tabId: context.tabId,
          active: false,
          detail: null,
        })
        .catch(() => {});
    };
  }, [active, name, context.tabId]);
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
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
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
      {(contentError || readError) && (
        <div role="alert">
          {contentError || readError}{" "}
          <Button variant="ghost" onClick={() => setRetry((value) => value + 1)}>
            Retry
          </Button>
        </div>
      )}
      {document && (
        <iframe
          ref={iframe}
          title={artifact?.title ?? "PR inbox"}
          className="html-preview pull-requests-document"
          style={{ flex: 1, minHeight: 0 }}
          srcDoc={document}
          onLoad={() => {
            if (content?.revision === artifact?.revision) setContentError("");
          }}
        />
      )}
    </div>
  );
}
