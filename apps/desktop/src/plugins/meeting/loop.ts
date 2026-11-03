import { operationError } from "../../renderer/operation-error.ts";
import type { Canvas, CanvasOp, EditRequest, MeetingSettings } from "./contract.ts";
import { captureRoom, type RoomClip } from "./microphone.ts";
import { type WakeRequest, WakeDetector } from "./wake.ts";

const MAX_QUEUED_CLIPS = 3;
const RECENT_LINES = 30;
const MAX_LINE = 4_000;
const MAX_FAILURES = 3;
const KEPT_LINES = 500;
const KEPT_ACTIVITY = 200;
const RETRY_MS = 8_000;
/** "Canvas, never mind" this soon after a change undoes it. */
const CANCEL_UNDO_MS = 5_000;

export type TranscriptLine = { id: number; text: string; wake: boolean };
export type Rejection = { op: CanvasOp; reason: string };
export type Activity = {
  id: number;
  kind: "transcribe" | "edit" | "voice" | "notice";
  backend?: string;
  model?: string;
  ms?: number;
  applied?: number;
  rejected?: readonly Rejection[];
  /** What was sent or heard, shortened for the list. */
  detail?: string;
  error?: string;
};
/** What Present shows the room about the latest request. */
export type CanvasStatus = {
  kind: "heard" | "working" | "done" | "ignored" | "failed" | "cancelled" | "undone";
  text: string;
  at: number;
};
export type LoopSnapshot = {
  listening: "off" | "starting" | "on";
  lines: readonly TranscriptLine[];
  activity: readonly Activity[];
  editing: boolean;
  status: CanvasStatus | null;
  error: string;
};

export type ModelChange = {
  applied: number;
  rejected: Rejection[];
  /** Names of the sections the reply created or changed. */
  sections: string[];
  /** The recorded change, which voice undo and cancel can revert. */
  change: number | null;
};
export type LoopHost = {
  canvas: () => Canvas;
  settings: () => MeetingSettings;
  /** Id of the section changed last. */
  focus: () => string | null;
  /** A number that grows with every change the person makes to the canvas. */
  editMark: () => number;
  /** Applies ops to the latest canvas, skipping what the person changed after `mark`. */
  apply: (ops: readonly CanvasOp[], mark: number) => ModelChange;
  /** Reverts the last model change, or `change` when given; returns a summary or null. */
  undoModelChange: (change?: number) => string | null;
};

type Request = {
  text: string;
  lineIds: number[];
  typed: boolean;
  closedBy?: EditRequest["closedBy"];
  retried: boolean;
  notBefore: number;
};

const short = (text: string, length = 140) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

/**
 * Turns microphone clips into transcript lines and "Canvas, …" requests into canvas
 * edits. Clips are transcribed one at a time. Only wake requests and typed requests
 * reach the edit model, one call at a time, in the order they were made.
 */
export class MeetingLoop {
  private state: LoopSnapshot = {
    listening: "off",
    lines: [],
    activity: [],
    editing: false,
    status: null,
    error: "",
  };
  private listeners = new Set<() => void>();
  private microphone?: AbortController;
  private clips: RoomClip[] = [];
  private transcribing = false;
  private speaking = false;
  private detector = new WakeDetector();
  /** Transcript line id for each chunk pushed to the detector. */
  private chunkLines: number[] = [];
  private lastClipEnd: number | null = null;
  private queue: Request[] = [];
  private inFlight: (Request & { cancelled: boolean }) | null = null;
  private lastApplied: { change: number; at: number } | null = null;
  private transcribeFailures = 0;
  private editFailures = 0;
  private ticker?: ReturnType<typeof setInterval>;
  private nextId = 1;
  private disposed = false;

  private readonly host: LoopHost;

  constructor(host: LoopHost) {
    this.host = host;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.state;

  private set(patch: Partial<LoopSnapshot>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private log(entry: Omit<Activity, "id">) {
    this.set({
      activity: [...this.state.activity, { id: this.nextId++, ...entry }].slice(-KEPT_ACTIVITY),
    });
  }
  private status(kind: CanvasStatus["kind"], text: string) {
    this.set({ status: { kind, text, at: Date.now() } });
  }

  async start() {
    if (this.disposed || this.microphone) return;
    const microphone = new AbortController();
    this.microphone = microphone;
    this.transcribeFailures = 0;
    this.editFailures = 0;
    this.set({ listening: "starting", error: "" });
    try {
      await window.scope.startMeetingListening();
      microphone.signal.throwIfAborted();
      await captureRoom(
        microphone.signal,
        (clip) => this.addClip(clip),
        (message) => this.stop(message),
        (on) => {
          this.speaking = on;
        },
      );
      if (this.microphone !== microphone) return;
      this.ticker = setInterval(() => this.tick(), 1_000);
      this.set({ listening: "on" });
    } catch (cause) {
      if (this.microphone !== microphone) return;
      this.stop(
        cause instanceof DOMException && cause.name === "NotAllowedError"
          ? "Microphone access was denied. Allow Scope in system privacy settings, then turn on Listen."
          : operationError(cause, "Could not start the microphone. Turn on Listen to retry."),
      );
    }
  }

  /** Stops the microphone. A request heard before stopping is still sent. */
  stop(error = "") {
    this.microphone?.abort();
    this.microphone = undefined;
    this.clips = [];
    this.speaking = false;
    clearInterval(this.ticker);
    this.ticker = undefined;
    if (this.state.listening !== "off" || error) this.set({ listening: "off", error });
    if (!this.disposed) this.handle(this.detector.flush());
  }

  /** Ends all work; replies that arrive later are ignored. */
  dispose() {
    this.disposed = true;
    this.stop();
    this.queue = [];
  }

  /** Undoes `dispose` when React mounts the same view again. */
  resume() {
    this.disposed = false;
  }

  /** A typed request skips the wake word and waits behind earlier requests. */
  ask(text: string) {
    const request = text.trim().slice(0, MAX_LINE);
    if (!request || this.disposed) return;
    this.queue.push({ text: request, lineIds: [], typed: true, retried: false, notBefore: 0 });
    this.status("heard", request);
    this.run();
  }

  private busy() {
    return this.speaking || this.clips.length > 0 || this.transcribing;
  }

  private tick() {
    if (this.disposed) return;
    this.handle(this.detector.tick(Date.now(), this.busy()));
    this.run();
  }

  private addClip(clip: RoomClip) {
    if (!this.microphone) return;
    this.clips.push(clip);
    if (this.clips.length > MAX_QUEUED_CLIPS) {
      this.clips.shift();
      this.log({
        kind: "notice",
        detail: "Dropped the oldest audio clip; transcription fell behind.",
      });
    }
    void this.transcribeClips();
  }

  private async transcribeClips() {
    if (this.transcribing) return;
    this.transcribing = true;
    try {
      while (this.clips.length && !this.disposed) {
        const clip = this.clips.shift()!;
        try {
          const result = await window.scope.transcribeMeetingAudio({
            audio: clip.audio,
            language: this.host.settings().language,
          });
          if (this.disposed) return;
          this.transcribeFailures = 0;
          const text = result.text.trim().slice(0, MAX_LINE);
          this.log({
            kind: "transcribe",
            backend: "openrouter",
            model: result.model,
            ms: result.ms,
            detail: text ? short(text) : "No speech.",
          });
          if (text) this.hear(text, clip);
        } catch (cause) {
          if (this.disposed) return;
          const error = operationError(cause, "Transcription failed.");
          this.log({ kind: "transcribe", backend: "openrouter", error });
          if (++this.transcribeFailures >= MAX_FAILURES && this.microphone)
            this.stop(
              `Listening stopped after ${MAX_FAILURES} failed transcriptions in a row. ${error}`,
            );
        }
      }
    } finally {
      this.transcribing = false;
    }
    this.tick();
  }

  private hear(text: string, clip: RoomClip) {
    const line: TranscriptLine = { id: this.nextId++, text, wake: false };
    this.set({ lines: [...this.state.lines, line].slice(-KEPT_LINES) });
    const gapMs =
      this.lastClipEnd === null ? Number.POSITIVE_INFINITY : clip.startedAt - this.lastClipEnd;
    this.lastClipEnd = clip.endedAt;
    this.chunkLines.push(line.id);
    const requests = this.detector.push(text, {
      endedBy: clip.endedBy,
      gapMs,
      endedAt: clip.endedAt,
    });
    const pending = this.detector.pending();
    if (pending) {
      this.markWake(pending.chunks);
      this.status("heard", pending.text || "Canvas…");
    }
    this.handle(requests);
  }

  private markWake(chunks: readonly number[]) {
    const ids = new Set(chunks.map((chunk) => this.chunkLines[chunk]));
    if (!this.state.lines.some((line) => ids.has(line.id) && !line.wake)) return;
    this.set({
      lines: this.state.lines.map((line) => (ids.has(line.id) ? { ...line, wake: true } : line)),
    });
  }

  private handle(requests: readonly WakeRequest[]) {
    for (const request of requests) {
      this.markWake(request.chunks);
      const lineIds = request.chunks.map((chunk) => this.chunkLines[chunk]!);
      if (request.action === "undo") {
        const summary = this.host.undoModelChange();
        this.log({
          kind: "voice",
          detail: summary ?? "Heard undo; there is no model change to undo.",
        });
        this.status("undone", summary ?? "Nothing to undo");
      } else if (request.action === "cancel") {
        this.cancel(request);
      } else if (request.closedBy !== "local" && request.closedBy !== "dropped") {
        this.queue.push({
          text: request.text.slice(0, MAX_LINE),
          lineIds,
          typed: false,
          closedBy: request.closedBy,
          retried: false,
          notBefore: 0,
        });
        this.status("heard", request.text);
      }
    }
    this.run();
  }

  /**
   * Drops the newest queued request; otherwise discards the reply of the call in flight;
   * otherwise undoes a change applied in the last 5 s.
   */
  private cancel(request: WakeRequest) {
    if (request.closedBy === "dropped") {
      this.log({ kind: "voice", detail: `Cancelled before sending: ${short(request.text, 80)}` });
      return this.status("cancelled", request.text);
    }
    const queued = this.queue.pop();
    if (queued) {
      this.log({ kind: "voice", detail: `Cancelled: ${short(queued.text, 80)}` });
      return this.status("cancelled", queued.text);
    }
    if (this.inFlight) {
      this.inFlight.cancelled = true;
      this.log({ kind: "voice", detail: `Cancelling: ${short(this.inFlight.text, 80)}` });
      return this.status("cancelled", this.inFlight.text);
    }
    const last = this.lastApplied;
    if (last && Date.now() - last.at <= CANCEL_UNDO_MS) {
      this.lastApplied = null;
      const summary = this.host.undoModelChange(last.change);
      this.log({ kind: "voice", detail: summary ?? "Heard cancel; the change was already gone." });
      return this.status("undone", summary ?? "Nothing to cancel");
    }
    this.log({ kind: "voice", detail: "Heard cancel; there was nothing to cancel." });
    this.status("cancelled", "Nothing to cancel");
  }

  private run() {
    if (this.disposed || this.inFlight) return;
    const next = this.queue[0];
    if (!next) return;
    if (Date.now() < next.notBefore) return;
    this.queue.shift();
    void this.edit(next);
  }

  private recentFor(request: Request): string[] {
    const own = new Set(request.lineIds);
    const first = request.lineIds[0];
    const before = this.state.lines.filter(
      (line) => !own.has(line.id) && (first === undefined || line.id < first),
    );
    return before.slice(-RECENT_LINES).map((line) => line.text);
  }

  private async edit(request: Request) {
    const flight = { ...request, cancelled: false };
    this.inFlight = flight;
    const settings = this.host.settings();
    const mark = this.host.editMark();
    const detail = `${request.typed ? "Asked" : "Heard"}: ${short(request.text, 80)}`;
    this.set({ editing: true });
    this.status("working", request.text);
    try {
      const result = await window.scope.editMeetingPage({
        canvas: this.host.canvas(),
        request: request.text,
        recent: this.recentFor(request),
        focus: this.host.focus(),
        settings,
        ...(request.closedBy ? { closedBy: request.closedBy } : {}),
      });
      if (this.disposed) return;
      this.editFailures = 0;
      if (flight.cancelled) {
        this.log({
          kind: "edit",
          backend: result.backend,
          model: result.model,
          ms: result.ms,
          detail: `${detail} · discarded after cancel`,
        });
        return;
      }
      const outcome = this.host.apply(result.ops, mark);
      if (outcome.change !== null) this.lastApplied = { change: outcome.change, at: Date.now() };
      this.log({
        kind: "edit",
        backend: result.backend,
        model: result.model,
        ms: result.ms,
        applied: outcome.applied,
        rejected: outcome.rejected,
        detail,
      });
      if (outcome.applied > 0) this.status("done", outcome.sections.join(", ") || "Canvas updated");
      else if (result.ops.length === 0) this.status("ignored", request.text);
      else this.status("failed", outcome.rejected[0]?.reason ?? "The change could not be applied.");
    } catch (cause) {
      if (this.disposed) return;
      const error = operationError(cause, "The canvas edit failed.");
      if (!request.retried && !flight.cancelled) {
        this.queue.unshift({ ...request, retried: true, notBefore: Date.now() + RETRY_MS });
        // The listening ticker may be off, so schedule the retry here.
        setTimeout(() => this.run(), RETRY_MS + 50);
      }
      this.log({
        kind: "edit",
        backend: settings.backend,
        model: settings.backend === "codex" ? undefined : settings.openrouterModel,
        detail,
        error,
      });
      this.status("failed", error);
      if (++this.editFailures >= MAX_FAILURES && this.microphone)
        this.stop(`Listening stopped after ${MAX_FAILURES} failed canvas edits in a row. ${error}`);
    } finally {
      if (this.inFlight === flight) this.inFlight = null;
      this.set({ editing: false });
      this.run();
    }
  }
}
