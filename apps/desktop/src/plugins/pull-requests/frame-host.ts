import { decode } from "@irudd-scope/protocol";
import type { PullRequestsSnapshot } from "@irudd-scope/protocol/pull-requests";
import type { WorkspaceFlushPurpose } from "../../workspace/contract.ts";
import { PullRequestsInterest } from "./interest.ts";
import { frameCommand, type FrameCall } from "./frame-command.ts";
import type { FrameIdentity } from "./frame-sdk.ts";
import { windowContent, windowJSON, type ContentWindow } from "./window-content.ts";

const message = (failure: unknown) =>
  failure instanceof Error ? failure.message : "Could not complete the inbox operation.";
type Details = NonNullable<PullRequestsInterest["details"]>;
type Frame = {
  identity: FrameIdentity;
  element: HTMLIFrameElement | null;
  ready: boolean;
  signature: string;
  details: Details;
  reads: Set<string>;
  commands: Promise<void>;
  registration?: Promise<void>;
  openerElement?: Element | null;
  closing?: Promise<void>;
  flushing?: Promise<void>;
};
type Options = {
  name: string;
  identity: FrameIdentity;
  refresh: () => Promise<void>;
  onSnapshot: (snapshot: PullRequestsSnapshot) => void;
  onWindows: (windows: ContentWindow[]) => void;
  onError: (error: string) => void;
  onLinkError: (error: string) => void;
};

export class PullRequestsFrameHost {
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
  private snapshot?: PullRequestsSnapshot;
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
      details: [],
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
    const stopLinks = window.scope.onPullRequestsLinkResult((result) => {
      const frame = [...this.frames.values()].find(
        (entry) =>
          entry.identity.channel === result.channel && entry.identity.tabId === result.tabId,
      );
      if (!frame) return;
      this.options.onLinkError(
        result.error ? `Could not open the browser. ${result.error} Retry the link.` : "",
      );
      this.post(frame, {
        type: "scope-pull-requests-link-result",
        url: result.url,
        error: result.error,
      });
    });
    const stopDetails = window.scope.onPullRequestsDetailUpdate((update) => {
      if (update.tabId !== this.options.identity.tabId) return;
      for (const frame of this.frames.values()) {
        if (
          frame.details.some(
            (entry) =>
              entry.nodeId === update.nodeId &&
              entry.headOid === update.headOid &&
              entry.baseOid === update.baseOid,
          )
        )
          this.post(frame, { type: "scope-pull-requests-detail-update", value: update });
      }
    });
    return () => {
      this.disposed = true;
      window.removeEventListener("message", receive);
      stopLinks();
      stopDetails();
      for (const frame of this.frames.values()) this.release(frame);
      this.frames.clear();
      for (const pending of this.flushes.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("The PR app closed before saving completed."));
      }
      this.flushes.clear();
      void this.reportInterest().catch(() => {});
    };
  }
  setSnapshot(snapshot: PullRequestsSnapshot) {
    if (
      snapshot.tabId !== this.options.identity.tabId ||
      snapshot.generation < (this.snapshot?.generation ?? -1)
    )
      return;
    this.snapshot = snapshot;
    this.options.onSnapshot(snapshot);
    for (const frame of this.frames.values()) this.sendSnapshot(frame);
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
    const details = new Map<string, Details[number]>();
    for (const frame of this.frames.values())
      for (const entry of frame.details)
        details.set(`${entry.nodeId}/${entry.headOid}/${entry.baseOid}`, entry);
    return window.scope.pullRequestsInterest({
      tabId: this.options.identity.tabId,
      active: !this.disposed && this.active,
      details: [...details.values()],
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
      type: "scope-pull-requests-snapshot",
      generation: snapshot.generation,
      value: {
        pullRequests: snapshot.prs,
        context: {
          name: this.options.name,
          repository: snapshot.repository,
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
  private restoreFocus(id: string, previous?: Element | null) {
    // Wait for the closed iframe to leave the DOM before restoring its opener.
    requestAnimationFrame(() => {
      if (this.disposed) return;
      const frame = this.frames.get(id) ?? this.frames.get("main");
      if (!frame) return;
      const element = previous?.isConnected
        ? previous
        : frame.element?.contentDocument?.activeElement;
      frame.element?.contentWindow?.focus();
      if (element && "focus" in element && typeof element.focus === "function") element.focus();
    });
  }
  private open(value: unknown, openerId: string) {
    if (this.closingFlushes > 0 || this.frames.get(openerId)?.closing)
      throw new Error("The inbox is closing. Retry after it finishes saving.");
    if (this.windows.size >= 8)
      throw new Error("Close a window before opening another. This inbox supports eight windows.");
    const content = windowContent(value);
    const id = crypto.randomUUID();
    const identity = { ...this.options.identity, channel: crypto.randomUUID() };
    this.frames.set(id, {
      ...this.frame(identity),
      openerElement: this.frames.get(openerId)?.element?.contentDocument?.activeElement,
    });
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
    const content = this.windows.get(id);
    if (!frame || !content) throw new Error("This content window is no longer open.");
    if (!frame.closing)
      frame.closing = (async () => {
        try {
          await this.flush(frame);
          if (this.disposed || this.frames.get(id) !== frame) return;
          this.frames.delete(id);
          this.windows.delete(id);
          this.release(frame);
          this.publishWindows();
          await this.reportInterest();
          this.restoreFocus(content.environment.openerId ?? "main", frame.openerElement);
        } finally {
          frame.closing = undefined;
        }
      })();
    return frame.closing;
  }
  async flushAll(purpose: WorkspaceFlushPurpose = "save") {
    if (purpose === "close") this.closingFlushes++;
    try {
      const results = await Promise.allSettled(
        [...this.frames.values()].map((frame) => this.flush(frame)),
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    } finally {
      if (purpose === "close") this.closingFlushes--;
    }
  }
  private flush(frame: Frame): Promise<void> {
    if (!frame.ready) return Promise.resolve();
    if (frame.flushing) return frame.flushing;
    const id = crypto.randomUUID();
    frame.flushing = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.flushes.delete(id);
        reject(new Error("The PR app did not finish saving. Retry before closing."));
      }, 8_000);
      this.flushes.set(id, { frame, resolve, reject, timer });
      this.post(frame, { type: "scope-pull-requests-close", id });
    }).finally(() => {
      frame.flushing = undefined;
    });
    return frame.flushing;
  }
  private release(frame: Frame) {
    if (frame.registration)
      void frame.registration
        .then(() =>
          window.scope.unregisterPullRequestsFrame({ ...frame.identity, name: this.options.name }),
        )
        .catch(() => {});
    if (frame.reads.size)
      void window.scope
        .pullRequestsCancelReads({ tabId: frame.identity.tabId, requestIds: [...frame.reads] })
        .catch(() => {});
  }
  private receive(event: MessageEvent) {
    const call = event.data;
    const entry = [...this.frames.entries()].find(
      ([, frame]) =>
        event.source === frame.element?.contentWindow &&
        call?.channel === frame.identity.channel &&
        call?.tabId === frame.identity.tabId,
    );
    if (!entry) return;
    const [id, frame] = entry;
    if (call.type === "scope-window-focus") {
      this.focus(id);
      return;
    }
    if (call.type === "scope-pull-requests-flushed") {
      const pending = this.flushes.get(call.id);
      if (!pending || pending.frame !== frame) return;
      clearTimeout(pending.timer);
      this.flushes.delete(call.id);
      if (call.error) pending.reject(new Error(call.error));
      else pending.resolve();
      return;
    }
    if (call.type === "scope-pull-requests-ready") {
      if (!frame.registration) {
        frame.registration = window.scope.registerPullRequestsFrame({
          ...frame.identity,
          name: this.options.name,
        });
        void frame.registration.catch(() => {
          if (!this.disposed)
            this.options.onLinkError("Could not set up browser links. Reopen the inbox.");
        });
      }
      frame.ready = true;
      frame.signature = "";
      this.sendSnapshot(frame);
      return;
    }
    if (call.type === "scope-pull-requests-interest") {
      try {
        frame.details =
          decode(PullRequestsInterest, {
            tabId: frame.identity.tabId,
            active: this.active,
            details: call.details,
          }).details ?? [];
        void this.reportInterest().catch((failure: unknown) =>
          this.options.onError(message(failure)),
        );
      } catch (failure) {
        this.options.onError(message(failure));
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
    const execute = () => this.execute(id, frame, call);
    if (
      [
        "sync",
        "detail",
        "loadDetails",
        "openWindow",
        "closeWindow",
        "broadcast",
        "openExternal",
      ].includes(call.method)
    )
      void execute();
    else frame.commands = frame.commands.then(execute);
  }
  private async execute(id: string, frame: Frame, call: FrameCall) {
    const reply = (value?: unknown, error?: string) =>
      this.post(frame, { type: "scope-pull-requests-reply", id: call.id, value, error });
    if (this.disposed || this.frames.get(id) !== frame) return;
    let readId: string | undefined;
    try {
      if (call.method === "openWindow") {
        reply(this.open(call.args[0], id));
        return;
      }
      if (call.method === "closeWindow") {
        if (typeof call.args[0] !== "string") throw new Error("Choose a content window to close.");
        await this.close(call.args[0]);
        reply();
        return;
      }
      if (call.method === "broadcast") {
        const value = windowJSON(call.args[0]);
        for (const recipient of this.frames.values())
          this.post(recipient, { type: "scope-window-message", value: { senderId: id, value } });
        reply();
        return;
      }
      if (call.method === "openExternal") {
        if (typeof call.args[0] !== "string") throw new Error("Choose a valid PR inbox link.");
        await window.scope.openPullRequestsLink({
          name: this.options.name,
          tabId: frame.identity.tabId,
          url: call.args[0],
        });
        this.options.onLinkError("");
        reply();
        return;
      }
      if (!this.snapshot) await this.options.refresh();
      if (this.disposed || this.frames.get(id) !== frame) return;
      if (!this.snapshot) throw new Error("The inbox is still loading. Retry in a moment.");
      const command = frameCommand(call, this.snapshot, frame.identity.tabId);
      if (command.action === "detail" || command.action === "details") {
        readId = command.requestId;
        frame.reads.add(readId);
      }
      const result = await window.scope.pullRequestsCommand(command);
      if (this.frames.get(id) !== frame || this.disposed) return;
      if (
        (result.type === "snapshot" ? result.snapshot.tabId : result.tabId) !== frame.identity.tabId
      )
        throw new Error("This reply belongs to another PR inbox.");
      if (result.type === "detail" && result.nodeId !== call.args[0])
        throw new Error("These details belong to another pull request.");
      if (result.type === "details") {
        const nodeIds = command.action === "details" ? command.nodeIds : [];
        if (
          result.results.length !== nodeIds.length ||
          result.results.some((entry, index) => entry.nodeId !== nodeIds[index])
        )
          throw new Error("These details do not match the requested pull requests.");
        reply(result.results);
        return;
      }
      if (result.type === "detail") {
        reply(result.detail);
        return;
      }
      this.setSnapshot(result.snapshot);
      const local = result.snapshot.prs.find((pr) => pr.nodeId === call.args[0])?.local;
      const version =
        call.method === "saveNote"
          ? local?.noteVersion
          : call.method === "setSnooze"
            ? local?.snoozeVersion
            : local?.reviewVersion;
      reply(version === undefined ? undefined : { version });
    } catch (failure) {
      if (!["openWindow", "closeWindow", "broadcast", "openExternal"].includes(call.method))
        await this.options.refresh();
      if (call.method === "closeWindow") this.options.onError(message(failure));
      if (call.method === "openExternal")
        this.options.onLinkError(`Could not open the browser. ${message(failure)} Retry the link.`);
      reply(undefined, message(failure));
    } finally {
      if (readId) frame.reads.delete(readId);
    }
  }
}
