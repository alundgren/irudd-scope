import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";

/** What the file viewers need: bytes, the kind of content, and a title. */
export type FileContent = {
  bytes: Uint8Array;
  /** `text`, `markdown`, `html`, or `image`; other kinds have no viewer. */
  kind: string;
  mediaType: string;
  title: string;
  /** Changes when the bytes change, such as a blob hash or a file's modification time. */
  version: string;
};
type ViewerProps = { content: FileContent; line?: number };

const decodeText = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * Lines per block. Blocks away from the view keep their text as one plain text node, laid
 * out like the numbered lines, so Select All and copy include the whole file.
 */
const TEXT_BLOCK_LINES = 500;

function TextBlock({
  lines,
  first,
  line,
  shown,
}: {
  lines: readonly string[];
  first: number;
  line: number | undefined;
  shown: boolean;
}) {
  if (!shown)
    return (
      <div className="text-block" data-block={first} data-plain>
        {lines.join("\n")}
      </div>
    );
  return (
    <div className="text-block" data-block={first}>
      {lines.map((text, index) => (
        <div
          key={index}
          className="text-line"
          data-line={first + index}
          aria-current={first + index === line || undefined}
        >
          {text}
        </div>
      ))}
    </div>
  );
}

/**
 * Text with line numbers. `line` scrolls to and marks that line. Long files number only
 * the blocks near the view, so a 2 MiB log with 300,000 short lines stays responsive.
 */
function TextView({ content, line }: ViewerProps) {
  const blocks = useMemo(() => {
    const all = decodeText(content.bytes).split("\n");
    if (all.length > 1 && all.at(-1) === "") all.pop();
    const result: { first: number; lines: string[] }[] = [];
    for (let index = 0; index < all.length; index += TEXT_BLOCK_LINES)
      result.push({
        first: index + 1,
        lines: all.slice(index, index + TEXT_BLOCK_LINES).map((text) => text.replace(/\r$/, "")),
      });
    return result;
  }, [content.bytes]);
  const lineCount = blocks.length ? blocks.at(-1)!.first + blocks.at(-1)!.lines.length - 1 : 0;
  const target = line ? Math.floor((line - 1) / TEXT_BLOCK_LINES) : 0;
  const [shown, setShown] = useState<ReadonlySet<number>>(() => new Set([0, target]));
  const container = useRef<HTMLPreElement>(null);
  useEffect(() => setShown((current) => new Set([...current, target])), [target, blocks]);
  useEffect(() => {
    const element = container.current;
    if (!element || blocks.length < 2) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) =>
            Math.floor(
              (Number((entry.target as HTMLElement).dataset.block) - 1) / TEXT_BLOCK_LINES,
            ),
          );
        if (visible.length) setShown((current) => new Set([...current, ...visible]));
      },
      { rootMargin: "1000px 0px" },
    );
    for (const block of element.children) observer.observe(block);
    return () => observer.disconnect();
  }, [blocks]);
  // Scrolls once per requested line, after its block has rendered.
  const scrolled = useRef<{ line: number | undefined; blocks: unknown }>({
    line: undefined,
    blocks: undefined,
  });
  useLayoutEffect(() => {
    if (!line || (scrolled.current.line === line && scrolled.current.blocks === blocks)) return;
    const element = container.current?.querySelector(`[data-line="${line}"]`);
    if (!element) return;
    scrolled.current = { line, blocks };
    element.scrollIntoView({ block: "center", behavior: "instant" });
  }, [line, blocks, shown]);
  return (
    <pre
      ref={container}
      className="text-document"
      style={{ "--line-digits": String(lineCount).length } as CSSProperties}
    >
      {blocks.map((block, index) => (
        <TextBlock
          key={block.first}
          lines={block.lines}
          first={block.first}
          line={line}
          shown={shown.has(index)}
        />
      ))}
    </pre>
  );
}
function MarkdownView({ content }: ViewerProps) {
  return (
    <article className="markdown-document">
      {/* react-markdown keys blocks by tag and count (h2-0, p-12). Inserting a heading above
          another makes React move nearly every later block, which is quadratic in large
          documents, so each content version mounts a fresh tree. */}
      <ReactMarkdown
        key={content.version}
        skipHtml
        components={{
          a: ({ children }) => <span>{children}</span>,
          img: ({ alt }) => <span>{alt}</span>,
        }}
      >
        {decodeText(content.bytes)}
      </ReactMarkdown>
    </article>
  );
}
function HtmlView({ content }: ViewerProps) {
  return (
    <iframe title={content.title} className="html-preview" srcDoc={decodeText(content.bytes)} />
  );
}
function ImageView({ content }: ViewerProps) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const objectUrl = URL.createObjectURL(
      new Blob([new Uint8Array(content.bytes)], { type: content.mediaType }),
    );
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [content]);
  return (
    <div className="image-preview">
      <img src={url || undefined} alt={content.title} />
    </div>
  );
}
const viewers = { text: TextView, markdown: MarkdownView, html: HtmlView, image: ImageView };

/**
 * Shows file content with the viewer for its kind, used for published files and Folder
 * tab previews. Kinds without a viewer show `fallback`.
 */
export const FileViews = memo(function FileViews({
  content,
  line,
  fallback,
}: ViewerProps & { fallback: ReactNode }) {
  const Viewer = Object.hasOwn(viewers, content.kind)
    ? viewers[content.kind as keyof typeof viewers]
    : undefined;
  if (!Viewer) return fallback;
  return <Viewer content={content} {...(line ? { line } : {})} />;
});
