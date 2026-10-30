/** How much of each end of a long tool input or output is kept. */
export const KEEP = 2048;

const SECRET =
  /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/g;
// Keys and base64 blobs mix upper case, lower case and digits. File names and ids rarely do.
const BLOB = /[A-Za-z0-9+/=_-]{40,}/g;

function blob(value: string) {
  const mixed = /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value);
  return mixed && !value.startsWith("/") && !/^[a-z0-9/_-]+$/.test(value) ? "[hidden]" : value;
}

/** Hides text that looks like a token, key or credential. */
export const hideSecrets = (text: string) =>
  text.replace(SECRET, "[hidden]").replace(BLOB, (value) => blob(value));

/** Tool inputs and outputs arrive as strings, content block lists or JSON values. */
export function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((part) => part && typeof part === "object"))
    return value
      .map((part: Record<string, unknown>) =>
        typeof part.text === "string" ? part.text : JSON.stringify(part),
      )
      .join("\n");
  return JSON.stringify(value) ?? "";
}

/** Long commands keep their tail: that is often where the real program runs (`…; cargo test`). */
export function inputText(value: unknown) {
  const text = asText(value);
  return text.length <= 2 * KEEP
    ? hideSecrets(text)
    : `${hideSecrets(text.slice(0, KEEP))}\n[…]\n${hideSecrets(text.slice(-KEEP))}`;
}

export function outputFields(value: unknown) {
  const text = asText(value);
  return text.length <= 2 * KEEP
    ? { outputChars: text.length, outputHead: hideSecrets(text), outputTail: "" }
    : {
        outputChars: text.length,
        outputHead: hideSecrets(text.slice(0, KEEP)),
        outputTail: hideSecrets(text.slice(-KEEP)),
      };
}

/** Milliseconds between two ISO times, or null when either is missing or invalid. */
export function between(start: unknown, end: unknown): number | null {
  if (typeof start !== "string" || typeof end !== "string") return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) ? ms : null;
}

/** `mcp__server__tool` is shown as `server.tool`. */
export const toolName = (name: string) => name.replace(/^mcp__(.+?)__/, "$1.");

export function parseJson(text: unknown): Record<string, unknown> {
  if (typeof text !== "string") return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
export const str = (value: unknown) => (typeof value === "string" ? value : null);
