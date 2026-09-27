import { lazy, Suspense, useEffect, useState, type ComponentType } from "react";
import ReactMarkdown from "react-markdown";
import type { Artifact, ArtifactKind } from "@irudd-scope/protocol";
import type { ArtifactContent } from "../bridge.ts";

import type { Theme } from "./appearance.ts";

type RendererProps = { item: ArtifactContent; theme: Theme; focus: boolean };
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
function TextView({ item }: RendererProps) {
  return <pre className="text-document">{text(item.bytes)}</pre>;
}
function MarkdownView({ item }: RendererProps) {
  return (
    <article className="markdown-document">
      <ReactMarkdown
        skipHtml
        components={{
          a: ({ children }) => <span>{children}</span>,
          img: ({ alt }) => <span>{alt}</span>,
        }}
      >
        {text(item.bytes)}
      </ReactMarkdown>
    </article>
  );
}
function HtmlView({ item }: RendererProps) {
  const policy =
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  return (
    <iframe
      title={item.artifact.title}
      className="html-preview"
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta charset="utf-8"></head><body>${text(item.bytes)}</body></html>`}
    />
  );
}
function ImageView({ item }: RendererProps) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const objectUrl = URL.createObjectURL(
      new Blob([new Uint8Array(item.bytes)], { type: item.artifact.mediaType }),
    );
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [item]);
  return (
    <div className="image-preview">
      <img src={url || undefined} alt={item.artifact.title} />
    </div>
  );
}
function FileView({ item }: RendererProps) {
  return (
    <div className="file-preview">
      <h1>{item.artifact.fileName}</h1>
      <p>{(item.artifact.size / 1024).toFixed(1)} KiB</p>
      <p>Use Download to save this file.</p>
    </div>
  );
}
const renderers: Record<ArtifactKind, ComponentType<RendererProps>> = {
  text: TextView,
  markdown: MarkdownView,
  html: HtmlView,
  image: ImageView,
  file: FileView,
  excalidraw: lazy(() =>
    import("./diagram-view.tsx").then((module) => ({ default: module.DiagramView })),
  ),
};

export function ArtifactView({
  artifact,
  theme,
  focus,
}: {
  artifact: Artifact;
  theme: Theme;
  focus: boolean;
}) {
  const [item, setItem] = useState<ArtifactContent>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setItem((previous) => (previous?.artifact.id === artifact.id ? previous : undefined));
    setError("");
    void window.scope
      .content(artifact.id, artifact.revision)
      .then((content) => {
        if (active) setItem(content);
      })
      .catch((failure: unknown) => {
        if (active)
          setError(failure instanceof Error ? failure.message : "Could not load the artifact.");
      });
    return () => {
      active = false;
    };
  }, [artifact.id, artifact.revision]);
  if (error && !item)
    return (
      <p className="empty-state" role="alert">
        {error}
      </p>
    );
  if (!item)
    return (
      <p className="empty-state" role="status">
        Loading artifact…
      </p>
    );
  const Renderer = Object.hasOwn(renderers, item.artifact.kind)
    ? renderers[item.artifact.kind]
    : FileView;
  return (
    <Suspense fallback={<p className="empty-state">Opening canvas…</p>}>
      {error && (
        <p className="diagram-notice" role="alert">
          {error} Showing the last loaded version.
        </p>
      )}
      <Renderer item={item} theme={theme} focus={focus} />
    </Suspense>
  );
}
