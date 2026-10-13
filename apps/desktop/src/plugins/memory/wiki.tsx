import ReactMarkdown from "react-markdown";
import type { MemoryConcept } from "./contract.ts";
import { decode } from "@irudd-scope/protocol";
import { MemoryPath } from "./contract.ts";

export function MemoryWiki({
  concept,
  onOpen,
  onError,
}: {
  concept: MemoryConcept;
  onOpen: (path: string) => void;
  onError: (message: string) => void;
}) {
  return (
    <article className="memory-wiki markdown-document">
      <h1>{concept.title}</h1>
      {concept.malformed && (
        <p role="status">This memory has invalid frontmatter. Ask your agent to inspect it.</p>
      )}
      <ReactMarkdown
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
                  onOpen(path);
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
                      onError(
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
    </article>
  );
}
