import type { CardContent } from "../contract.ts";

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
