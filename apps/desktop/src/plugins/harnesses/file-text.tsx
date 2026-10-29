import { useEffect, useState, type CSSProperties } from "react";
import { Copy } from "lucide-react";
import type { HarnessFileOwner, HarnessFileReply } from "@irudd-scope/protocol/harnesses";
import { Button } from "../../renderer/components/ui/button.tsx";
import { operationError } from "../../renderer/operation-error.ts";

const UNITS = ["KB", "MB", "GB", "TB"];
/** Decimal units like a file manager: one decimal below 100, none from 100 up, so 405 MB and 11.6 GB. */
export function formatSize(size: number) {
  if (size < 1000) return count(size, "byte");
  for (const [index, unit] of UNITS.entries()) {
    const value = size / 1000 ** (index + 1);
    const text = value < 99.95 ? value.toFixed(1) : value.toFixed(0);
    if (Number(text) < 1000 || index === UNITS.length - 1) return `${text} ${unit}`;
  }
  return count(size, "byte");
}
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Copies an allowed file's text; `name` names it in the confirmation. */
export type CopyFile = (harness: HarnessFileOwner, path: string, name: string) => void;

export type FileText =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "loaded"; reply: HarnessFileReply };

/** Reads one allowed file through the desktop; a newer request replaces an older answer. */
export function useHarnessFile(harness: HarnessFileOwner, path: string): FileText {
  const [text, setText] = useState<{ key: string; text: FileText }>();
  const key = `${harness}\n${path}`;
  useEffect(() => {
    let current = true;
    window.scope.harnessFile({ machine: "local", harness, path }).then(
      (reply) => current && setText({ key, text: { state: "loaded", reply } }),
      (error: unknown) =>
        current &&
        setText({
          key,
          text: { state: "failed", message: operationError(error, "Could not read the file.") },
        }),
    );
    return () => {
      current = false;
    };
  }, [key, harness, path]);
  return text?.key === key ? text.text : { state: "loading" };
}

/** Lines with numbers that copying leaves out, in a scrollable box. */
export function TextLines({ text, label }: { text: string; label: string }) {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  return (
    // The box scrolls, so it takes keyboard focus for arrow-key scrolling.
    <div
      className="harnesses-text"
      role="region"
      aria-label={label}
      tabIndex={0}
      style={{ "--harnesses-digits": String(lines.length).length } as CSSProperties}
    >
      {lines.map((line, index) => (
        <div key={index} className="harnesses-text-line">
          <span className="harnesses-line-number" aria-hidden="true">
            {index + 1}
          </span>
          <span>{line}</span>
        </div>
      ))}
    </div>
  );
}

/** Reading…, the reason a read failed, or the text. */
export function FileBody({ file, label }: { file: FileText; label: string }) {
  if (file.state === "loading")
    return (
      <p className="harnesses-muted" role="status">
        Reading…
      </p>
    );
  if (file.state === "failed") return <p role="alert">{file.message}</p>;
  if (!file.reply.text) return <p className="harnesses-muted">The file is empty.</p>;
  return <TextLines text={file.reply.text} label={label} />;
}

export function CopyText({ file, onCopy }: { file: FileText; onCopy: () => void }) {
  if (file.state !== "loaded") return null;
  return (
    <Button variant="ghost" size="sm" onClick={onCopy}>
      <Copy aria-hidden="true" />
      Copy text
    </Button>
  );
}
