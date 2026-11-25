import type {
  WorkspaceAppState,
  WorkspaceNodeStateChange,
  WorkspaceSnapshot,
  WorkspaceStateChange,
} from "@irudd-scope/protocol/github-workspace";
import type { WorkspaceFlushPurpose } from "../../workspace/contract.ts";
import { frameCommand, type FrameCall } from "./frame-command.ts";
import type { FrameIdentity } from "./frame-sdk.ts";
import { windowContent, windowJSON, type ContentWindow } from "./window-content.ts";

const message = (failure: unknown) =>
  failure instanceof Error ? failure.message : "Could not complete the workspace operation.";

type Frame = {
  identity: FrameIdentity;
  element: HTMLIFrameElement | null;
  ready: boolean;
  signature: string;
  reads: Set<string>;
  commands: Promise<void>;
  registration?: Promise<void>;
  closing?: Promise<void>;
  flushing?: Promise<void>;
};

type Options = {
  name: string;
  identity: FrameIdentity;
  refresh: () => Promise<void>;
  onSnapshot: (snapshot: WorkspaceSnapshot) => void;
  onWindows: (windows: ContentWindow[]) => void;
  onError: (error: string) => void;
  onLinkError: (error: string) => void;
};

export class WorkspaceFrameHost {
  private readonly frames = new Map<string, Frame>();
  private readonly windows = new Map<string, ContentWindow>();
  private readonly flushes = new Map<
    string,
    {
      frame: Frame;
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private snapshot?: WorkspaceSnapshot;
  private appState?: WorkspaceAppState;
  private theme = "light";
  private active = false;
  private disposed = false;
  private closingFlushes = 0;
  private focused = "main";
  private z = 20;

  constructor(private readonly options: Options) {
    this.frames.set("main", this.frame(options.identity));
  }

  private frame(identity: FrameIdentity): Frame {
    return {
      identity,
      element: null,
      ready: false,
      signature: "",
      reads: new Set(),
      commands: Promise.resolve(),
    };
  }

  attach(id: string, element: HTMLIFrameElement | null) {
    const frame = this.frames.get(id);
    if (frame) frame.element = element;
  }

  start() {
    const receive = (event: MessageEvent) => this.receive(event);
    window.addEventListener("message", receive);
    const stopLinks = window.scope.onGitHubWorkspaceLinkResult((result) => {
      const frame = [...this.frames.values()].find(
        (entry) =>
          entry.identity.channel === result.channel && entry.identity.tabId === result.tabId,
      );
      if (!frame) return;
      this.options.onLinkError(
        result.error ? `Could not open the browser. ${result.error} Retry the link.` : "",
      );
      this.post(frame, {
        type: "scope-github-workspace-link-result",
        url: result.url,
        error: result.error,
      });
    });
    return () => {
      this.disposed = true;
      window.removeEventListener("message", receive);
      stopLinks();
      for (const frame of this.frames.values()) this.release(frame);
      this.frames.clear();
      for (const pending of this.flushes.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("The workspace closed before saving completed."));
      }
      this.flushes.clear();
      void this.reportInterest().catch(() => {});
    };
  }

  setSnapshot(snapshot: WorkspaceSnapshot) {
    if (
      snapshot.tabId !== this.options.identity.tabId ||
      snapshot.generation < (this.snapshot?.generation ?? -1)
    )
      return;
    this.snapshot = snapshot;
    const appState = snapshot.appState ?? { version: 0, value: {} };
    if (appState.version > (this.appState?.version ?? -1)) this.appState = appState;
    this.options.onSnapshot(snapshot);
    for (const frame of this.frames.values()) this.sendSnapshot(frame);
  }

  stateChanged(change: WorkspaceStateChange) {
    if (change.version <= (this.appState?.version ?? -1)) return;
    this.appState = { version: change.version, value: change.value };
    for (const frame of this.frames.values())
      if (frame.ready) this.post(frame, { type: "scope-github-workspace-state", value: change });
  }

  nodeStateChanged(change: WorkspaceNodeStateChange) {
    for (const frame of this.frames.values())
      if (frame.ready)
        this.post(frame, { type: "scope-github-workspace-node-state-change", value: change });
  }

  refreshNodeStates() {
    for (const frame of this.frames.values())
      if (frame.ready) this.post(frame, { type: "scope-github-workspace-node-state-refresh" });
  }

  setTheme(theme: string) {
    this.theme = theme;
    for (const frame of this.frames.values()) this.sendSnapshot(frame);
  }

  setActive(active: boolean, refresh = false) {
    this.active = active;
    return this.reportInterest(refresh);
  }

  refreshInterest() {
    return this.reportInterest(true);
  }

  private reportInterest(refresh = false) {
    return window.scope.githubWorkspaceInterest({
      tabId: this.options.identity.tabId,
      active: !this.disposed && this.active,
      ...(refresh ? { refresh: true } : {}),
    });
  }

  private post(frame: Frame, value: Record<string, unknown>) {
    if (!this.disposed && [...this.frames.values()].includes(frame))
      frame.element?.contentWindow?.postMessage({ ...frame.identity, ...value }, "*");
  }

  private sendSnapshot(frame: Frame) {
    const snapshot = this.snapshot;
    if (!snapshot || !frame.ready) return;
    const signature = `${snapshot.generation}:${this.theme}`;
    if (frame.signature === signature) return;
    frame.signature = signature;
    this.post(frame, {
      type: "scope-github-workspace-snapshot",
      generation: snapshot.generation,
      value: {
        milestones: snapshot.milestones,
        issues: snapshot.issues,
        pullRequests: snapshot.prs,
        board: snapshot.board,
        transitions: snapshot.transitions,
        appState: this.appState,
        context: {
          name: this.options.name,
          repository: snapshot.repository,
          boardRef: snapshot.boardRef,
          viewer: snapshot.viewer,
          theme: this.theme,
        },
        sync: snapshot.sync,
      },
    });
  }

  focus(id: string) {
    if (!this.frames.has(id) || this.focused === id) return;
    this.focused = id;
    const content = this.windows.get(id);
    if (content) {
      content.z = ++this.z;
      this.publishWindows();
    }
  }

  private publishWindows() {
    this.options.onWindows([...this.windows.values()]);
  }

  private open(value: unknown, openerId: string) {
    if (this.closingFlushes > 0 || this.frames.get(openerId)?.closing)
      throw new Error("The workspace is closing. Retry after it finishes saving.");
    if (this.windows.size >= 8)
      throw new Error("Close a window before opening another. Up to eight windows are supported.");
    const content = windowContent(value);
    const id = crypto.randomUUID();
    const identity = { ...this.options.identity, channel: crypto.randomUUID() };
    this.frames.set(id, this.frame(identity));
    this.windows.set(id, {
      ...content,
      identity,
      environment: { id, openerId, context: content.context },
      z: ++this.z,
    });
    this.focused = id;
    this.publishWindows();
    return id;
  }

  async close(id: string) {
    const frame = this.frames.get(id);
    if (!frame || id === "main") return;
    if (frame.closing) return frame.closing;
    frame.closing = (async () => {
      await this.flushFrame(frame);
      this.release(frame);
      this.frames.delete(id);
      this.windows.delete(id);
      if (this.focused === id) this.focused = "main";
      this.publishWindows();
    })().finally(() => {
      frame.closing = undefined;
    });
    return frame.closing;
  }

  private release(frame: Frame) {
    if (frame.reads.size) {
      void window.scope
        .githubWorkspaceCancelReads({
          tabId: this.options.identity.tabId,
          requestIds: [...frame.reads],
        })
        .catch(() => {});
      frame.reads.clear();
    }
    if (frame.registration) {
      void window.scope
        .unregisterGitHubWorkspaceFrame({ name: this.options.name, ...frame.identity })
        .catch(() => {});
      frame.registration = undefined;
    }
  }

  private flushFrame(frame: Frame): Promise<void> {
    if (!frame.ready || !frame.element?.contentWindow) return Promise.resolve();
    if (frame.flushing) return frame.flushing;
    const id = crypto.randomUUID();
    frame.flushing = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.flushes.delete(id);
        reject(new Error("Workspace edits did not finish saving in time."));
      }, 5_000);
      this.flushes.set(id, { frame, resolve, reject, timer });
      this.post(frame, { type: "scope-github-workspace-close", id });
    }).finally(() => {
      frame.flushing = undefined;
    });
    return frame.flushing;
  }

  async flushAll(purpose: WorkspaceFlushPurpose): Promise<void> {
    if (purpose === "close") this.closingFlushes++;
    try {
      await Promise.all([...this.frames.values()].map((frame) => this.flushFrame(frame)));
    } finally {
      if (purpose === "close") this.closingFlushes--;
    }
  }

  private receive(event: MessageEvent) {
    const value = event.data;
    if (!value || typeof value !== "object") return;
    const match = [...this.frames.entries()].find(
      ([, frame]) =>
        frame.element?.contentWindow === event.source &&
        frame.identity.channel === value.channel &&
        frame.identity.tabId === value.tabId,
    );
    if (!match) return;
    const [frameId, frame] = match;
    if (value.type === "scope-window-focus") {
      this.focus(frameId);
      return;
    }
    if (value.type === "scope-github-workspace-ready") {
      frame.ready = true;
      frame.registration = window.scope
        .registerGitHubWorkspaceFrame({ name: this.options.name, ...frame.identity })
        .catch(() => {});
      this.sendSnapshot(frame);
      return;
    }
    if (value.type === "scope-github-workspace-flushed") {
      const pending = this.flushes.get(value.id);
      if (!pending || pending.frame !== frame) return;
      this.flushes.delete(value.id);
      clearTimeout(pending.timer);
      if (value.error) pending.reject(new Error(String(value.error)));
      else pending.resolve();
      return;
    }
    if (value.type === "scope-github-workspace-call") {
      void this.handleCall(frameId, frame, value as FrameCall);
    }
  }

  private async handleCall(frameId: string, frame: Frame, call: FrameCall) {
    const reply = (payload: { value?: unknown; error?: string }) =>
      this.post(frame, { type: "scope-github-workspace-reply", id: call.id, ...payload });
    try {
      if (call.method === "openExternal") {
        await window.scope.openGitHubWorkspaceLink({
          name: this.options.name,
          tabId: this.options.identity.tabId,
          url: typeof call.args[0] === "string" ? call.args[0] : "",
        });
        reply({ value: null });
        return;
      }
      if (call.method === "openWindow") {
        reply({ value: this.open(call.args[0], frameId) });
        return;
      }
      if (call.method === "closeWindow") {
        const target = typeof call.args[0] === "string" ? call.args[0] : frameId;
        await this.close(target);
        reply({ value: null });
        return;
      }
      if (call.method === "broadcast") {
        const payload = windowJSON(call.args[0] ?? null);
        for (const target of this.frames.values())
          if (target.ready)
            this.post(target, {
              type: "scope-window-message",
              value: { senderId: frameId, value: payload },
            });
        reply({ value: null });
        return;
      }
      const snapshot = this.snapshot;
      if (!snapshot) throw new Error("Workspace is still loading.");
      const command = frameCommand(call, snapshot, this.options.identity.tabId);
      const isRead = ["pr-detail", "pr-details", "issue-detail"].includes(command.action);
      if (isRead && "requestId" in command) frame.reads.add(command.requestId);
      try {
        const result = await window.scope.githubWorkspaceCommand(command);
        if (result.type === "snapshot") {
          this.setSnapshot(result.snapshot);
          if (call.method === "readState" || call.method.endsWith("State")) {
            reply({ value: result.snapshot.appState ?? { version: 0, value: {} } });
          } else {
            reply({ value: { generation: result.snapshot.generation } });
          }
          if (command.action === "configure") void this.refreshInterest().catch(() => {});
        } else if (result.type === "pr-detail") {
          reply({ value: result.detail });
        } else if (result.type === "pr-details") {
          reply({ value: result.results });
        } else if (result.type === "issue-detail") {
          reply({ value: result.detail });
        } else if (result.type === "node-state") {
          reply({ value: result.state });
        }
      } finally {
        if (isRead && "requestId" in command) frame.reads.delete(command.requestId);
      }
    } catch (error) {
      reply({ error: message(error) });
    }
  }
}
