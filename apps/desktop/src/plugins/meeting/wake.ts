export type WakeAction = "model" | "undo" | "cancel";
export type WakeRequest = {
  /** What was asked after the wake word, joined across chunks. */
  text: string;
  /** Indexes of the pushed chunks the request came from, wake chunk first. */
  chunks: number[];
  action: WakeAction;
};
export type ChunkTiming = {
  /** Why the clip ended: trailing silence, or the 6 s length cap. */
  endedBy: "silence" | "cap";
  /** Time between the previous clip's capture end and this clip's capture start. */
  gapMs: number;
  /** Capture end time of this clip, in ms on the caller's clock. */
  endedAt: number;
};

/** Finds "Canvas, …" requests in a stream of transcript chunks. */
export class WakeDetector {
  /** Adds one transcribed chunk; returns requests that are complete now. */
  push(_text: string, _timing: ChunkTiming): WakeRequest[] {
    throw new Error("W1 implements WakeDetector.push.");
  }
  /**
   * Sends a pending request once the room is quiet: nobody speaking, no clip waiting or
   * being transcribed, and at least 1.5 s of silence since the last capture end.
   */
  tick(_now: number, _busy: boolean): WakeRequest[] {
    throw new Error("W1 implements WakeDetector.tick.");
  }
}
