import { memo, useEffect, useState, type ComponentType } from "react";
import ReactMarkdown from "react-markdown";
import type { Artifact, ArtifactKind } from "@irudd-scope/protocol";
import type { ArtifactContent } from "../../bridge.ts";

import type { Theme } from "../../renderer/appearance.ts";

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
export function FileView({ artifact }: { artifact: Artifact }) {
  return (
    <div className="file-preview">
      <h1>{artifact.fileName}</h1>
      <p>{(artifact.size / 1024).toFixed(1)} KiB</p>
      <p>Use Download to save this file.</p>
    </div>
  );
}
const renderers: Record<ArtifactKind, ComponentType<RendererProps>> = {
  text: TextView,
  markdown: MarkdownView,
  html: HtmlView,
  image: ImageView,
};

export const FileViews = memo(function FileViews(props: RendererProps) {
  const Renderer = Object.hasOwn(renderers, props.item.artifact.kind)
    ? renderers[props.item.artifact.kind]
    : undefined;
  if (!Renderer) return <FileView artifact={props.item.artifact} />;
  return <Renderer {...props} />;
});
