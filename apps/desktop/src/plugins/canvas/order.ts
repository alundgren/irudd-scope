// Fractional index keys: comparing two keys as plain strings gives their order, and there is
// always a key between two others, so moving one card or record changes one field.
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let common = 0;
    while ((a[common] ?? "0") === b[common]) common++;
    if (common > 0) return b.slice(0, common) + midpoint(a.slice(common), b.slice(common));
  }
  const low = a ? DIGITS.indexOf(a[0]) : 0;
  const high = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (high - low > 1) return DIGITS[Math.round((low + high) / 2)];
  if (b && b.length > 1) return b.slice(0, 1);
  return DIGITS[low] + midpoint(a.slice(1), null);
}

/** A key that sorts after `before` and before `after`. Either may be missing. */
export function keyBetween(before: string | undefined, after: string | undefined): string {
  if (before !== undefined && after !== undefined && before >= after)
    throw new Error("Order keys are out of order.");
  return midpoint(before ?? "", after ?? null);
}

export const byOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
