import type { CanvasOp, CardContent } from "../contract.ts";

/** What main and the views know about a card type, without React or Electron. */
export type CardTypeContract = {
  /** Stored in every card of this type forever. */
  type: string;
  version: number;
  label: string;
  /** Throws when one record is not valid for this type. */
  validate: (record: Record<string, unknown>) => void;
  /** Rules about the whole content, such as a connector pointing at a missing box. */
  check: (content: CardContent) => string[];
  /** The content of a new card. */
  empty: () => CardContent;
  limits: { records: number; textChars: number };
};

/** How agents read and change a card type through the card chat's tools. */
export type CardTools = {
  /** The content as an agent reads it. */
  describe: (content: CardContent) => unknown;
  /** Turns an agent's changes into ops, or says why it can't. */
  plan: (
    content: CardContent,
    changes: unknown,
  ) => { ops: CanvasOp[]; warnings: string[]; summary: string[] } | { error: string };
  readGuide: string;
  editGuide: string;
};
