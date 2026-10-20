import { memo, useEffect, useMemo, useState, type ComponentType } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import type { Root } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { Artifact, ArtifactKind } from "@irudd-scope/protocol";
import type { ArtifactContent } from "../../bridge.ts";
import { parseMarkdownInBackground } from "./markdown-client.ts";

type RendererProps = { item: ArtifactContent };
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
function TextView({ item }: RendererProps) {
  return <pre className="text-document">{text(item.bytes)}</pre>;
}
function MarkdownView({ item }: RendererProps) {
  const [parsed, setParsed] = useState<{ blob: string; tree: Root }>();
  useEffect(() => {
    let active = true;
    const blob = item.artifact.blob;
    void parseMarkdownInBackground(text(item.bytes)).then((tree) => {
      if (active) setParsed({ blob, tree });
    });
    return () => {
      active = false;
    };
  }, [item]);
  const content = useMemo(
    () =>
      parsed &&
      toJsxRuntime(parsed.tree, {
        Fragment,
        jsx,
        jsxs,
        components: {
          a: ({ children }) => <span>{children}</span>,
          img: ({ alt }) => <span>{alt}</span>,
        },
      }),
    [parsed],
  );
  if (!parsed)
    return (
      <p className="empty-state" role="status">
        Loading artifact…
      </p>
    );
  return (
    <article className="markdown-document">
      {/* hast-util-to-jsx-runtime keys blocks by tag and count (h2-0, p-12). Inserting a heading
          above another makes React move nearly every later block, which is quadratic in large
          documents, so each content version mounts a fresh tree. */}
      <Fragment key={parsed.blob}>{content}</Fragment>
    </article>
  );
}
function HtmlView({ item }: RendererProps) {
  return <iframe title={item.artifact.title} className="html-preview" srcDoc={text(item.bytes)} />;
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
