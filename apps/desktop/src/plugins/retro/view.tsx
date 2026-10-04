import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type { RetroSnapshot } from "@irudd-scope/protocol/retro";
import type { TabProps } from "../api.ts";
import { Button } from "../../renderer/components/ui/button.tsx";
import { RetroHistory } from "../../renderer/retro-history.tsx";
import { retroError } from "../../renderer/retro-error.ts";
import { WorkspaceNavigationContext } from "../../workspace/navigation-context.ts";
import { RetroFrameHost } from "./frame-host.ts";
import { retroDocument } from "./frame-sdk.ts";

const message = (error: unknown) => retroError(error, "Could not load this RETRO report.");
export function RetroView({ artifact, context }: TabProps) {
  const navigation = useContext(WorkspaceNavigationContext);
  const [content, setContent] = useState<{ html: string; revision: number }>();
  const [snapshot, setSnapshot] = useState<RetroSnapshot>();
  const [readError, setReadError] = useState("");
  const [contentError, setContentError] = useState("");
  const [notice, setNotice] = useState("");
  const [history, setHistory] = useState(false);
  const [retry, setRetry] = useState(0);
  const latest = useRef<RetroSnapshot | undefined>(undefined);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const openHistory = useRef<(id: string) => Promise<void>>(async () => {});
  openHistory.current = async (id) => {
    if (!navigation) throw new Error("Open this report from the workspace.");
    await navigation.openSavedTab(id);
  };
  const identity = useMemo(
    () => ({ channel: crypto.randomUUID(), tabId: context.tabId }),
    [context.tabId, content?.revision],
  );
  const host = useMemo(
    () =>
      new RetroFrameHost({
        identity,
        name: artifact?.name ?? "",
        refresh: () => refresh.current(),
        openHistory: (id) => openHistory.current(id),
      }),
    [identity, artifact?.name],
  );
  const document = useMemo(
    () => (content ? retroDocument(content.html, identity) : undefined),
    [content, identity],
  );
  const flush = useRef<() => Promise<void>>(async () => {});
  flush.current = () => host.flush();
  useEffect(() => {
    const stop = host.start();
    const stopClosing = context.onBeforeClose(() => host.flush());
    const stopFinishing = window.scope.onRetroFinishFlush(async (request) => {
      if (request.tabId === context.tabId) await host.flush();
    });
    return () => {
      stopFinishing();
      stopClosing();
      stop();
    };
  }, [host, context.tabId]);
  useEffect(() => {
    if (!artifact?.name) return;
    let mounted = true;
    let requested = 0;
    let reading: Promise<void> | undefined;
    const name = artifact.name;
    async function reload(): Promise<void> {
      requested++;
      if (reading) return reading;
      reading = (async () => {
        let read: number;
        let conflicts = 0;
        do {
          read = requested;
          try {
            const reply = await window.scope.retroCommand({
              action: "read",
              name,
              tabId: context.tabId,
            });
            if (!mounted) return;
            if (reply.type !== "snapshot" || reply.snapshot.tabId !== context.tabId)
              throw new Error(
                "This report no longer matches the saved tab. Your edits remain here.",
              );
            let value = reply.snapshot;
            while (value.next) {
              const page = await window.scope.retroCommand({
                action: "read",
                name,
                tabId: context.tabId,
                after: value.next,
                version: value.version,
              });
              if (!mounted) return;
              if (
                page.type !== "snapshot" ||
                page.snapshot.tabId !== context.tabId ||
                page.snapshot.version !== value.version
              )
                throw new Error("The report changed while reading sessions. Retry.");
              value = {
                ...value,
                sessions: [...value.sessions, ...page.snapshot.sessions],
                next: page.snapshot.next,
              };
            }
            if (value.version >= (latest.current?.version ?? -1)) {
              latest.current = value;
              host.setSnapshot(value);
              setSnapshot(value);
              setReadError("");
            }
          } catch (error) {
            if (mounted && /version|changed|conflict/i.test(message(error)) && conflicts++ < 3)
              requested++;
            else if (mounted) setReadError(message(error));
          }
        } while (mounted && read !== requested);
      })().finally(() => {
        reading = undefined;
      });
      return reading;
    }
    refresh.current = reload;
    const stopChanges = window.scope.onRetroChanged((event) => {
      if (event.name === name && event.id === artifact?.id && event.tabId === context.tabId)
        void reload();
    });
    const stopReconnect = window.scope.onRetroReconnected(() => {
      void reload();
    });
    void reload();
    return () => {
      mounted = false;
      stopChanges();
      stopReconnect();
    };
  }, [artifact?.name, artifact?.id, context.tabId, retry, host]);
  useEffect(() => {
    if (!artifact) return;
    let mounted = true;
    void window.scope
      .content(artifact.id, artifact.revision)
      .then(async (item) => {
        if (content && content.revision !== artifact.revision) await flush.current();
        if (mounted) {
          setContent((previous) =>
            previous?.revision === artifact.revision
              ? previous
              : { html: new TextDecoder().decode(item.bytes), revision: artifact.revision },
          );
          setContentError("");
        }
      })
      .catch((error: unknown) => {
        if (mounted) setContentError(message(error));
      });
    return () => {
      mounted = false;
    };
  }, [artifact?.id, artifact?.revision, retry]);
  async function copyRequest() {
    try {
      await host.flush();
      await navigator.clipboard.writeText(
        `Please read the current RETRO report and respond to its decisions and investigation requests: irudd-scope retro read ${artifact?.name ?? ""}`,
      );
      setNotice("Agent request copied.");
    } catch (error) {
      setNotice(message(error));
    }
  }
  return (
    <div className="retro-view">
      <div className="retro-status">
        <span role="status">
          {snapshot?.status === "finished"
            ? "Saved final report · Read only"
            : "Review with your coding agent"}
        </span>
        <div className="retro-status-actions">
          {snapshot?.status !== "finished" && (
            <Button size="sm" variant="ghost" onClick={() => void copyRequest()}>
              Copy agent request
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setHistory(true)}>
            History
          </Button>
        </div>
      </div>
      {notice && (
        <p className="retro-notice" role="status">
          {notice}
        </p>
      )}
      {(readError || contentError) && (
        <div className="retro-notice" role="alert">
          {contentError || readError}{" "}
          <Button size="sm" variant="secondary" onClick={() => setRetry((value) => value + 1)}>
            Retry
          </Button>
        </div>
      )}
      {!document && !contentError && (
        <p className="empty-state" role="status">
          Opening report…
        </p>
      )}
      {document && (
        <iframe
          key={identity.channel}
          ref={(element) => host.attach(element)}
          title={artifact?.title ?? "RETRO report"}
          className="html-preview retro-document"
          srcDoc={document}
        />
      )}
      <RetroHistory open={history} onOpenChange={setHistory} />
    </div>
  );
}
