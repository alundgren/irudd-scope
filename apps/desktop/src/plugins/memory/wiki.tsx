import ReactMarkdown from "react-markdown";
import type { MemoryConcept } from "./contract.ts";
import { decode } from "@irudd-scope/protocol";
import { MemoryPath } from "./contract.ts";

export function noteLink(source: string, href: string): string | undefined {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#")) return;
  let target: string;
  try {
    target = decodeURIComponent(href.split("#")[0]!.split("?")[0]!);
  } catch {
    return;
  }
  if (target.startsWith("//")) return;
  if (target.endsWith("/")) target += "index.md";
  const parts = target.startsWith("/") ? [] : source.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "..") {
      if (!parts.length) return;
      parts.pop();
    } else if (part && part !== ".") parts.push(part);
  }
  try {
    return decode(MemoryPath, parts.join("/"));
  } catch {
    return;
  }
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
  return (
    <article className="memory-wiki markdown-document">
      {concept.malformed && (
        <p role="status">This file has invalid frontmatter. You can still edit its raw Markdown.</p>
      )}
      <ReactMarkdown
        skipHtml
        components={{
          a: ({ href, children }) => {
            const path = href ? noteLink(concept.path, href) : undefined;
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
      {!!concept.links.length && (
        <nav aria-label="Linked notes">
          <h2>Linked notes</h2>
          <ul className="memory-link-list">
            {concept.links
              .filter((link) => !link.external)
              .map((link, index) => {
                let path: string | undefined;
                try {
                  path = decode(MemoryPath, link.target);
                } catch {
                  /* Unsafe targets stay text. */
                }
                return (
                  <li key={index}>
                    {path && !link.broken ? (
                      <button onClick={() => onOpen(path!)}>{link.label || path}</button>
                    ) : (
                      <span>{link.label || link.target} · Unavailable</span>
                    )}
                  </li>
                );
              })}
          </ul>
        </nav>
      )}
      {!!concept.backlinks.length && (
        <nav aria-label="Notes linking here">
          <h2>Notes linking here</h2>
          <ul className="memory-link-list">
            {concept.backlinks.map((link) => (
              <li key={link.path}>
                <button onClick={() => onOpen(link.path)}>{link.title}</button>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </article>
  );
}
