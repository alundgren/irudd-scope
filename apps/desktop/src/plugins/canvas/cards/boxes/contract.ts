import { Schema } from "effect";
import { CanvasId, OrderKey, type CardContent } from "../../contract.ts";
import type { CardTypeContract } from "../types.ts";

export const MAX_TEXT = 2000;

const Coordinate = Schema.Int.check(
  Schema.isBetween({ minimum: -10_000_000, maximum: 10_000_000 }),
);
const Length = Schema.Int.check(Schema.isBetween({ minimum: 20, maximum: 100_000 }));
const Fraction = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const Text = Schema.String.check(Schema.isMaxLength(MAX_TEXT));

export const BOX_KINDS = [
  { id: "box", label: "Box" },
  { id: "database", label: "Database" },
  { id: "queue", label: "Queue" },
  { id: "circle", label: "Circle" },
  { id: "diamond", label: "Diamond" },
] as const;
export type BoxKind = (typeof BOX_KINDS)[number]["id"];

/** A box. `kind` is left out for a plain box. */
const BoxRecord = Schema.Struct({
  type: Schema.Literal("box"),
  kind: Schema.optionalKey(Schema.Literals(["database", "queue", "circle", "diamond"])),
  x: Coordinate,
  y: Coordinate,
  w: Length,
  h: Length,
  text: Schema.optionalKey(Text),
  z: OrderKey,
});
/** A dashed area with a title on its top border. `title` is where the title sits, 0 to 1. */
const SectionRecord = Schema.Struct({
  type: Schema.Literal("section"),
  x: Coordinate,
  y: Coordinate,
  w: Length,
  h: Length,
  text: Schema.optionalKey(Text),
  title: Schema.optionalKey(Fraction),
  z: OrderKey,
});
/** Where a connector meets a box, as fractions of the box's width and height. */
const Anchor = Schema.Struct({ id: CanvasId, rx: Fraction, ry: Fraction });
/** A curved line between two boxes. The end has an arrowhead unless `arrowEnd` is false. */
const ConnectorRecord = Schema.Struct({
  type: Schema.Literal("connector"),
  from: Anchor,
  to: Anchor,
  label: Schema.optionalKey(Text),
  arrowStart: Schema.optionalKey(Schema.Boolean),
  arrowEnd: Schema.optionalKey(Schema.Boolean),
  z: OrderKey,
});
const BoxesRecord = Schema.Union([BoxRecord, SectionRecord, ConnectorRecord]);

export type BoxRecord = typeof BoxRecord.Type;
export type SectionRecord = typeof SectionRecord.Type;
export type ConnectorRecord = typeof ConnectorRecord.Type;
export type Anchor = typeof Anchor.Type;
export type BoxesRecord = typeof BoxesRecord.Type;
export type BoxesContent = Record<string, BoxesRecord>;
export type Area = BoxRecord | SectionRecord;

const decode = Schema.decodeUnknownSync(BoxesRecord, { onExcessProperty: "error" });

function check(content: CardContent): string[] {
  const problems: string[] = [];
  for (const [id, record] of Object.entries(content)) {
    if (record.type !== "connector") continue;
    const { from, to } = record as ConnectorRecord;
    for (const end of [from, to])
      if (content[end.id]?.type !== "box")
        problems.push(`Connector ${id} points at ${end.id}, which is not a box.`);
    if (from.id === to.id) problems.push(`Connector ${id} starts and ends on the same box.`);
  }
  return problems;
}

export const boxesCard: CardTypeContract = {
  type: "boxes",
  version: 1,
  label: "Boxes and arrows",
  validate: (record) => {
    decode(record);
  },
  check,
  empty: () => ({}),
  limits: { records: 5000, textChars: MAX_TEXT },
};
