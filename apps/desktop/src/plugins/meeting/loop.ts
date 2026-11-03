import { operationError } from "../../renderer/operation-error.ts";
import type { EditOp, MeetingSettings, Page } from "./contract.ts";
import { captureRoom } from "./microphone.ts";

const MAX_QUEUED_CLIPS = 3;
const MIN_FRESH_WORDS = 12;
const PAUSE_MS = 8_000;
const CONTEXT_LINES = 40;
const MAX_FRESH_LINES = 60;
const MAX_LINE = 4_000;
const MAX_FAILURES = 3;
const KEPT_LINES = 500;
const KEPT_ACTIVITY = 200;

export type TranscriptLine = { id: number; text: string; sent: boolean };
export type Rejection = { op: EditOp; reason: string };
export type Activity = {
  id: number;
  kind: "transcribe" | "edit" | "notice";
  backend?: string;
  model?: string;
  ms?: number;
  applied?: number;
  rejected?: readonly Rejection[];
  /** What was sent or heard, shortened for the list. */
  detail?: string;
  error?: string;
};
export type LoopSnapshot = {
  listening: "off" | "starting" | "on";
  lines: readonly TranscriptLine[];
  activity: readonly Activity[];
  editing: boolean;
  error: string;
};

export type LoopHost = {
  page: () => Page;
  settings: () => MeetingSettings;
  /** A number that grows with every change the person makes to the page. */
  editMark: () => number;
  /** Applies ops to the latest page, skipping blocks the person changed after `mark`. */
  apply: (ops: readonly EditOp[], mark: number) => { applied: number; rejected: Rejection[] };
};

const words = (lines: readonly TranscriptLine[]) =>
  lines.reduce((sum, line) => sum + line.text.split(/\s+/).filter(Boolean).length, 0);
const short = (text: string, length = 140) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

/**
 * Turns microphone clips into transcript lines and transcript lines into page edits.
 * Clips are transcribed one at a time; one edit call runs at a time and new lines wait
 * for the next call.
 */
export class MeetingLoop {
  private state: LoopSnapshot = {
    listening: "off",
    lines: [],
    activity: [],
    editing: false,
    error: "",
  };
  private listeners = new Set<() => void>();
  private microphone?: AbortController;
  private clips: string[] = [];
  private transcribing = false;
  private requests: string[] = [];
  /** A typed request whose edit failed once; it is retried once, then dropped. */
  private retried: string | null = null;
  private lastCall = 0;
  private retryAfter = 0;
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
      );
      if (this.microphone !== microphone) return;
      this.lastCall = Date.now();
      this.ticker = setInterval(() => this.pace(), 1_000);
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

  /** Stops the microphone. Lines already heard stay and go with the next edit call. */
  stop(error = "") {
    this.microphone?.abort();
    this.microphone = undefined;
    this.clips = [];
    clearInterval(this.ticker);
    this.ticker = undefined;
    if (this.state.listening !== "off" || error) this.set({ listening: "off", error });
  }

  /** Ends all work; replies that arrive later are ignored. */
  dispose() {
    this.stop();
    this.requests = [];
    this.disposed = true;
  }

  /** Undoes `dispose` when React mounts the same view again. */
  resume() {
    this.disposed = false;
  }

  /** A typed request goes now, or right after the call in flight. */
  ask(text: string) {
    const request = text.trim().slice(0, MAX_LINE);
    if (!request || this.disposed) return;
    this.requests.push(request);
    this.pace();
  }

  private addClip(clip: string) {
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
        const audio = this.clips.shift()!;
        try {
          const result = await window.scope.transcribeMeetingAudio({
            audio,
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
          if (text) {
            this.set({
              lines: [...this.state.lines, { id: this.nextId++, text, sent: false }].slice(
                -KEPT_LINES,
              ),
            });
            this.pace();
          }
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
  }

  /** Starts an edit call when a request waits or enough new speech has arrived. */
  private pace() {
    if (this.disposed || this.state.editing) return;
    const now = Date.now();
    // A request that already failed once waits out the pause like spoken lines do.
    if (this.requests.length && (this.requests[0] !== this.retried || now >= this.retryAfter))
      return void this.edit();
    if (now < this.retryAfter) return;
    const fresh = this.state.lines.filter((line) => !line.sent);
    if (!fresh.length) return;
    if (words(fresh) >= MIN_FRESH_WORDS || now - this.lastCall >= PAUSE_MS) void this.edit();
  }

  private async edit() {
    const request = this.requests.shift() ?? null;
    const unsent = this.state.lines.filter((line) => !line.sent);
    const fresh = unsent.slice(-MAX_FRESH_LINES);
    const skipped = unsent.length - fresh.length;
    const context = this.state.lines.filter((line) => line.sent).slice(-CONTEXT_LINES);
    const settings = this.host.settings();
    const mark = this.host.editMark();
    this.set({ editing: true });
    try {
      const result = await window.scope.editMeetingPage({
        page: this.host.page(),
        context: context.map((line) => line.text),
        fresh: fresh.map((line) => line.text),
        request,
        settings,
      });
      if (this.disposed) return;
      this.editFailures = 0;
      this.retryAfter = 0;
      this.retried = null;
      const outcome = this.host.apply(result.ops, mark);
      const sent = new Set(unsent.map((line) => line.id));
      this.set({
        lines: this.state.lines.map((line) => (sent.has(line.id) ? { ...line, sent: true } : line)),
      });
      this.log({
        kind: "edit",
        backend: result.backend,
        model: result.model,
        ms: result.ms,
        applied: outcome.applied,
        rejected: outcome.rejected,
        detail: [
          request ? `Asked: ${short(request, 80)}` : `${fresh.length} new lines`,
          skipped ? `${skipped} older lines skipped` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      });
    } catch (cause) {
      if (this.disposed) return;
      const error = operationError(cause, "The page edit failed.");
      if (request !== null && this.retried !== request) {
        this.retried = request;
        this.requests.unshift(request);
        // The listening ticker may be off, so schedule the retry here.
        setTimeout(() => this.pace(), PAUSE_MS + 50);
      }
      this.retryAfter = Date.now() + PAUSE_MS;
      this.log({
        kind: "edit",
        backend: settings.backend,
        model: settings.backend === "codex" ? undefined : settings.openrouterModel,
        detail: request ? `Asked: ${short(request, 80)}` : `${fresh.length} new lines`,
        error,
      });
      if (++this.editFailures >= MAX_FAILURES && this.microphone)
        this.stop(`Listening stopped after ${MAX_FAILURES} failed page edits in a row. ${error}`);
    } finally {
      this.lastCall = Date.now();
      this.set({ editing: false });
      this.pace();
    }
  }
}
