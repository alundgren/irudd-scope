import { useMemo, useRef, useState } from "react";
import { keyBetween } from "../../order.ts";
import { nameOf } from "./contract.ts";
import type { BoxesContent, ConnectorRecord } from "./contract.ts";
import { connectors } from "./geometry.ts";

/** State with a ref that always holds the newest value, for pointer handlers between renders. */
export function useLatest<T>(initial: T) {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  const set = (next: T) => {
    ref.current = next;
    setValue(next);
  };
  return [value, set, ref] as const;
}

/** An object whose methods always call the latest version, so memoized nodes keep their props. */
export function useStable<T extends Record<string, (...args: never[]) => unknown>>(value: T): T {
  const ref = useRef(value);
  ref.current = value;
  return useMemo(
    () =>
      Object.fromEntries(
        Object.keys(value).map((key) => [key, (...args: never[]) => ref.current[key](...args)]),
      ) as T,
    [],
  );
}

/** What deleting a record removes: the record and every connector on it. */
export function deletion(content: BoxesContent, id: string) {
  const record = content[id];
  if (record.type === "connector")
    return { ids: [id], text: "Deleted connector", label: "Delete connector" };
  const linked = connectors(content)
    .filter(([, c]) => c.from.id === id || c.to.id === id)
    .map(([other]) => other);
  const what = record.type === "section" ? "section" : "box";
  const extra = linked.length
    ? ` and ${linked.length} connector${linked.length === 1 ? "" : "s"}`
    : "";
  return {
    ids: [id, ...linked],
    text: `Deleted ${what}${extra}`,
    label: `Delete ${nameOf(record)}${extra}`,
  };
}

/** A function that hands out order keys above every record, one after another. */
export function orderAbove(content: BoxesContent) {
  let top = Object.values(content).reduce<string | undefined>(
    (max, record) => (max === undefined || record.z > max ? record.z : max),
    undefined,
  );
  return () => (top = keyBetween(top, undefined));
}

/** Turns one arrowhead on or off. The end arrowhead is on unless `arrowEnd` is false. */
export function toggleArrow(connector: ConnectorRecord, end: "arrowStart" | "arrowEnd") {
  if (end === "arrowStart")
    return connector.arrowStart
      ? { value: undefined, label: "Remove start arrowhead" }
      : { value: true, label: "Add start arrowhead" };
  return connector.arrowEnd === false
    ? { value: undefined, label: "Add end arrowhead" }
    : { value: false, label: "Remove end arrowhead" };
}
