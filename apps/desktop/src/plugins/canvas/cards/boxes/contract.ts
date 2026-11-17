import { Schema } from "effect";
import type { CardTypeContract } from "../types.ts";

const BoxesRecord = Schema.Struct({ type: Schema.String });

export const boxesCard: CardTypeContract = {
  type: "boxes",
  version: 1,
  label: "Boxes and arrows",
  validate: (record) => {
    Schema.decodeUnknownSync(BoxesRecord)(record);
  },
  check: () => [],
  empty: () => ({}),
  limits: { records: 5000, textChars: 2000 },
};
