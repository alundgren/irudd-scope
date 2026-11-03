export type WakeAction = "model" | "undo" | "cancel";
/**
 * Why a request ended: a pause before the next clip, the end of a sentence followed by
 * other talk, the chunk limit, a new wake word, quiet room after the last clip, the
 * fallback timer, a spoken undo or cancel handled locally, or "never mind" right after
 * a request that was never sent.
 */
export type WakeClose =
  | "pause"
  | "sentence"
  | "chunks"
  | "wake"
  | "quiet"
  | "fallback"
  | "local"
  | "dropped";
export type WakeRequest = {
  /** What was asked after the wake word, joined across chunks. */
  text: string;
  /** Indexes of the pushed chunks the request came from, wake chunk first. */
  chunks: number[];
  action: WakeAction;
  closedBy: WakeClose;
};
export type ChunkTiming = {
  /** Why the clip ended: trailing silence, or the 6 s length cap. */
  endedBy: "silence" | "cap";
  /** Time between the previous clip's capture end and this clip's capture start. */
  gapMs: number;
  /** Capture end time of this clip, in ms on the caller's clock. */
  endedAt: number;
};

/** Silence that ends a request. */
export const PAUSE_MS = 1_500;
/** A request still open this long after the last clip is sent even if the room seems busy. */
export const FALLBACK_MS = 6_000;
/** A request needs this many words after the wake word. */
export const MIN_WORDS = 3;
/** A finished sentence of this many words may end the request. */
export const SENTENCE_WORDS = 4;
/** Hesitant speech splits into many short clips, so a request is capped by time and a safety count. */
export const MAX_CHUNKS = 8;
export const MAX_REQUEST_MS = 15_000;

// Speech-to-text spellings of "Canvas"; "can vas" is matched as two words below.
const WAKE_WORDS = new Set(["canvas", "canvass", "kanvas", "canvas's"]);
const ADDRESS_WORDS = new Set(["hey", "hi", "hello", "ok", "okay", "okej", "hej", "hallå"]);
const FILLER_WORDS = new Set([
  "so",
  "um",
  "uh",
  "uhm",
  "er",
  "well",
  "alright",
  "right",
  "and",
  "now",
  "så",
  "och",
  "nu",
  "eh",
  "alltså",
]);
const REQUEST_WORDS = new Set([
  "draw",
  "sketch",
  "add",
  "make",
  "show",
  "create",
  "put",
  "update",
  "change",
  "rename",
  "delete",
  "remove",
  "move",
  "undo",
  "let's",
  "lets",
  "zoom",
  "write",
  "list",
  "plot",
  "replace",
  "rita",
  "lägg",
  "gör",
  "visa",
  "ändra",
  "byt",
  "skapa",
  "skriv",
  "flytta",
  "ångra",
  "döp",
  "radera",
]);
const REQUEST_PAIRS = new Set(["ta bort", "lägg till", "let us"]);
/** Polite openings count only as the first words after the wake word. */
const POLITE_PAIRS = new Set([
  "can you",
  "could you",
  "would you",
  "will you",
  "kan du",
  "kan ni",
  "skulle du",
  "skulle ni",
]);
const POLITE_WORDS = new Set(["please", "snälla"]);
/** Words that keep a request going into its next sentence. */
const CONTINUATION_WORDS = new Set([
  "also",
  "and",
  "then",
  "plus",
  "with",
  "include",
  "including",
  "och",
  "också",
  "sen",
  "sedan",
  "med",
  "även",
  "samt",
]);
const LEAD_WORDS = new Set([
  "please",
  "actually",
  "oh",
  "wait",
  "no",
  "just",
  "okay",
  "ok",
  "nej",
  "förresten",
  "snälla",
  "faktiskt",
]);
const UNDO_WORDS = new Set(["undo", "ångra"]);
const UNDO_TAIL = new Set([
  "that",
  "it",
  "please",
  "the",
  "last",
  "change",
  "edit",
  "one",
  "det",
  "där",
  "senaste",
  "sista",
  "ändringen",
  "snälla",
]);
const CANCEL_PHRASES = [
  ["never", "mind"],
  ["nevermind"],
  ["cancel"],
  ["forget", "it"],
  ["forget", "that"],
  ["scratch", "that"],
  ["glöm", "det"],
  ["strunt", "i", "det"],
  ["avbryt"],
];
const CANCEL_TAIL = new Set(["that", "it", "please", "now", "det", "då", "snälla"]);

type Token = { raw: string; word: string; end: number };
type Open = { parts: string[]; chunks: number[]; sentenceDone: boolean; since: number };

/**
 * Finds "Canvas, …" requests in a stream of transcript chunks. Pure: the caller supplies
 * clip timing and the clock, so the app and the bench detect the same requests.
 */
export class WakeDetector {
  private count = 0;
  private open: Open | null = null;
  private lastEndedAt = Number.NEGATIVE_INFINITY;
  private lastEndedBy: ChunkTiming["endedBy"] = "silence";

  /** Adds one transcribed chunk; returns requests that are complete now. */
  push(text: string, timing: ChunkTiming): WakeRequest[] {
    const index = this.count++;
    const out: WakeRequest[] = [];
    if (this.open && timing.gapMs >= PAUSE_MS && words(this.open) >= MIN_WORDS)
      out.push(...this.close("pause"));
    this.lastEndedAt = timing.endedAt;
    this.lastEndedBy = timing.endedBy;
    for (const sentence of splitSentences(text)) {
      const wake = findWake(sentence.text);
      if (wake !== null) {
        if (this.open) out.push(...this.close("wake"));
        this.open = { parts: [], chunks: [index], sentenceDone: false, since: timing.endedAt };
        this.extend(wake, sentence.ended, out);
        continue;
      }
      const open = this.open;
      if (!open) continue;
      if (open.sentenceDone && !continues(sentence.text)) {
        if (isCancel(sentence.text)) {
          this.open = null;
          out.push({
            text: joined(open),
            chunks: open.chunks,
            action: "cancel",
            closedBy: "dropped",
          });
        } else out.push(...this.close("sentence"));
        continue;
      }
      if (!open.chunks.includes(index)) open.chunks.push(index);
      this.extend(sentence.text, sentence.ended, out);
    }
    if (
      this.open &&
      this.open.chunks.at(-1) === index &&
      (this.open.chunks.length >= MAX_CHUNKS || timing.endedAt - this.open.since >= MAX_REQUEST_MS)
    )
      out.push(...this.close("chunks"));
    return out;
  }

  /**
   * Sends a pending request once the room is quiet: nobody speaking, no clip waiting or
   * being transcribed, and at least 1.5 s of silence since the last capture end. After
   * 6 s without a new chunk it is sent anyway, because room noise can keep `busy` on.
   */
  tick(now: number, busy: boolean): WakeRequest[] {
    if (!this.open) return [];
    const quiet = now - this.lastEndedAt;
    const waiting = busy || this.lastEndedBy === "cap";
    if (!waiting && quiet >= PAUSE_MS && words(this.open) >= MIN_WORDS) return this.close("quiet");
    if (quiet >= FALLBACK_MS) return this.close("fallback");
    return [];
  }

  /** Ends the open request now, as when listening stops. */
  flush(): WakeRequest[] {
    return this.close("quiet");
  }

  /** The request heard so far, before it is complete, for a "heard" indicator. */
  pending(): { text: string; chunks: readonly number[] } | null {
    return this.open ? { text: joined(this.open), chunks: this.open.chunks } : null;
  }

  private extend(text: string, ended: boolean, out: WakeRequest[]) {
    const open = this.open!;
    const clean = text.trim();
    if (clean) open.parts.push(clean);
    const action = localAction(joined(open));
    if (action) {
      this.open = null;
      out.push({ text: joined(open), chunks: open.chunks, action, closedBy: "local" });
      return;
    }
    if (ended && words(open) >= SENTENCE_WORDS) open.sentenceDone = true;
  }

  /** Ends the open request; one with fewer than 3 words is dropped. */
  private close(closedBy: WakeClose): WakeRequest[] {
    const open = this.open;
    this.open = null;
    if (!open || words(open) < MIN_WORDS) return [];
    return [{ text: joined(open), chunks: open.chunks, action: "model", closedBy }];
  }
}

/**
 * Removes a leading `Name:` speaker label, as the bench's transcripts carry. "Canvas:"
 * is a wake word, not a label, so it stays.
 */
export function stripSpeakerLabel(line: string): string {
  const match = /^\s*([\p{Lu}][\p{L}\p{N} .'-]{0,30}):\s+/u.exec(line);
  if (!match) return line;
  const label = tokenize(match[1]!).map((token) => token.word);
  if (label.some((word) => WAKE_WORDS.has(word))) return line;
  return line.slice(match[0].length);
}

const joined = (open: Open) => open.parts.join(" ");
const words = (open: Open) => countWords(joined(open));
const countWords = (text: string) => tokenize(text).length;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const word = match[0]
      .replace(/[’‘]/g, "'")
      .toLowerCase()
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (word) tokens.push({ raw: match[0], word, end: match.index + match[0].length });
  }
  return tokens;
}

function splitSentences(text: string): { text: string; ended: boolean }[] {
  return text
    .split(/(?<=[.!?…]["'”’)\]]*)\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => ({ text: part, ended: /[.!?…]["'”’)\]]*$/.test(part) }));
}

/**
 * The text after the wake word, or null when the sentence does not address the canvas.
 * The wake word counts at the start of the sentence, after "hey" or "ok", or after a
 * comma when it is capitalized ("Okay everyone, Canvas, …"). It must be followed by
 * punctuation, a request word within 3 words, or "please"/"can you" right after it.
 */
function findWake(sentence: string): string | null {
  const tokens = tokenize(sentence);
  const starts = [0];
  tokens.forEach((token, index) => {
    if (index + 1 < tokens.length && token.raw.endsWith(",")) starts.push(index + 1);
  });
  for (const start of starts) {
    let i = start;
    let addressed = false;
    while (i < tokens.length && i - start < 3) {
      const word = tokens[i]!.word;
      if (ADDRESS_WORDS.has(word)) addressed = true;
      else if (!FILLER_WORDS.has(word)) break;
      i++;
    }
    const first = tokens[i];
    if (!first) continue;
    let last = i;
    if (!WAKE_WORDS.has(first.word)) {
      if (first.word === "can" && tokens[i + 1]?.word === "vas") last = i + 1;
      else continue;
    }
    if (start > 0 && !addressed && !/^[^\p{L}]*\p{Lu}/u.test(first.raw)) continue;
    const wakeToken = tokens[last]!;
    const rest = tokens.slice(last + 1).map((token) => token.word);
    const after = sentence.slice(wakeToken.end);
    // The token keeps its own punctuation ("Canvas,"); a spaced dash comes after it.
    const punctuated = /[,.:;!?—–-]["'”’)]*$/.test(wakeToken.raw) || /^\s*[,.:;!?—–-]/.test(after);
    const polite =
      POLITE_WORDS.has(rest[0] ?? "") || POLITE_PAIRS.has(`${rest[0] ?? ""} ${rest[1] ?? ""}`);
    if (addressed || punctuated || polite || hasRequestWord(rest)) {
      return after.replace(/^[\s"'”’),.:;!?—–-]+/, "");
    }
  }
  return null;
}

function hasRequestWord(rest: readonly string[]): boolean {
  for (let j = 0; j < 3 && j < rest.length; j++) {
    if (REQUEST_WORDS.has(rest[j]!)) return true;
    if (REQUEST_PAIRS.has(`${rest[j]} ${rest[j + 1] ?? ""}`)) return true;
  }
  return false;
}

/** Whether a sentence after a finished request sentence still belongs to the request. */
function continues(sentence: string): boolean {
  const lead = tokenize(sentence)
    .map((token) => token.word)
    .slice(0, 3);
  return lead.some((word) => CONTINUATION_WORDS.has(word)) || hasRequestWord(lead);
}

function leadTrimmed(text: string): string[] {
  const list = tokenize(text).map((token) => token.word);
  let start = 0;
  while (start < list.length && LEAD_WORDS.has(list[start]!)) start++;
  return list.slice(start);
}

function isCancel(text: string): boolean {
  const list = leadTrimmed(text);
  return CANCEL_PHRASES.some(
    (phrase) =>
      phrase.every((word, index) => list[index] === word) &&
      list.length - phrase.length <= 2 &&
      list.slice(phrase.length).every((word) => CANCEL_TAIL.has(word)),
  );
}

/** "…, actually never mind" at the end takes back the whole request. */
function endsWithCancel(text: string): boolean {
  const list = tokenize(text).map((token) => token.word);
  while (list.length && CANCEL_TAIL.has(list.at(-1)!)) list.pop();
  return CANCEL_PHRASES.some(
    (phrase) =>
      list.length > phrase.length &&
      phrase.every((word, index) => list[list.length - phrase.length + index] === word),
  );
}

function localAction(text: string): "undo" | "cancel" | null {
  const list = leadTrimmed(text);
  // "Undo that last reporting-line edit" still means the last change; the model cannot
  // undo better than the change log can.
  if (list.length > 0 && list.length <= 8 && UNDO_WORDS.has(list[0]!)) return "undo";
  return isCancel(text) || endsWithCancel(text) ? "cancel" : null;
}
