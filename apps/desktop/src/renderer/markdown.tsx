import { useMemo } from "react";
import ReactMarkdown from "react-markdown";

/** A short FNV-1a digest used only as a React key. */
function textKey(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++)
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return `${(hash >>> 0).toString(36)}-${text.length}`;
}

/**
 * Markdown without raw HTML, with links and images shown as plain text. It is parsed only
 * when the text changes; theme, focus and tab switches re-render the workspace. A changed
 * text remounts the document so inserted blocks do not re-key every sibling.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return useMemo(
    () => (
      <article className={className ? `${className} markdown-document` : "markdown-document"}>
        <ReactMarkdown
          key={textKey(text)}
          skipHtml
          components={{
            a: ({ children }) => <span>{children}</span>,
            img: ({ alt }) => <span>{alt}</span>,
          }}
        >
          {text}
        </ReactMarkdown>
      </article>
    ),
    [text, className],
  );
}
