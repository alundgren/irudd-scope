import { useMemo, useRef } from "react";
import { Markdown as SharedMarkdown } from "../../renderer/markdown.tsx";
import ReactMarkdown from "react-markdown";
import type { MemoryConcept } from "./contract.ts";
import { decode } from "@irudd-scope/protocol";
import { MemoryPath } from "./contract.ts";

/** Memory notes and revisions as Markdown. */
export function Markdown({ text }: { text: string }) {
  return <SharedMarkdown text={text} className="memory-wiki" />;
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
