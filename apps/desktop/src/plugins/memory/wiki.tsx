import { useMemo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import type { MemoryConcept } from "./contract.ts";
import { decode } from "@irudd-scope/protocol";
import { MemoryPath } from "./contract.ts";

/** A short FNV-1a digest used only as a React key. */
function textKey(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++)
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return `${(hash >>> 0).toString(36)}-${text.length}`;
}
/**
 * Markdown is parsed only when the text changes; theme, focus and tab switches re-render the
 * workspace. A changed text remounts the document so inserted blocks do not re-key every sibling.
 */
export function Markdown({ text }: { text: string }) {
  return useMemo(
    () => (
      <article className="memory-wiki markdown-document">
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
    [text],
  );
}

export function MemoryWiki({
  concept,
  onOpen,
  onError,
}: {
  concept: MemoryConcept;
  onOpen: (path: string) => void;
  onError: (message: string) => void;
}) {
  const handlers = useRef({ onOpen, onError });
  handlers.current = { onOpen, onError };
  const links = JSON.stringify(concept.links);
  const body = useMemo(
    () => (
      <ReactMarkdown
        key={concept.hash}
        skipHtml
        components={{
          a: ({ href, children }) => {
            const link = concept.links.find(
              (link) => !link.external && !link.broken && link.label === children,
            );
            let path: string | undefined;
            if (link) {
              try {
                path = decode(MemoryPath, link.target);
              } catch {}
            }
            return path ? (
              <a
                href={href}
                onClick={(event) => {
                  event.preventDefault();
                  handlers.current.onOpen(path);
                }}
              >
                {children}
              </a>
            ) : href?.startsWith("#") ? (
              <a href={href}>{children}</a>
            ) : /^https?:\/\//i.test(href ?? "") ? (
              <a
                href={href}
                onClick={(event) => {
                  event.preventDefault();
                  void window.scope
                    .openMemoryLink(href!)
                    .catch((cause: unknown) =>
                      handlers.current.onError(
                        cause instanceof Error
                          ? cause.message
                          : "Could not open the browser. Retry.",
                      ),
                    );
                }}
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            );
          },
          img: ({ alt }) => <span>{alt}</span>,
        }}
      >
        {concept.body}
      </ReactMarkdown>
    ),
    // The hash covers the body; links can change when a target is added or removed.
    [concept.hash, concept.body, links],
  );
  return (
    <article className="memory-wiki markdown-document">
      <h1>{concept.title}</h1>
      {concept.malformed && (
        <p role="status">This memory has invalid frontmatter. Ask your agent to inspect it.</p>
      )}
      {body}
    </article>
  );
}
