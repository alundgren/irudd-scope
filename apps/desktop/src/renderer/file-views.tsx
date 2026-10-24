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
import { colorBlocks, languageFor, MAX_COLORED_BYTES, type ColoredText } from "./code-colors.ts";

/** What the file viewers need: bytes, the kind of content, and a title. */
export type FileContent = {
  bytes: Uint8Array;
  /** `text`, `markdown`, `html`, or `image`; other kinds have no viewer. */
  kind: string;
  mediaType: string;
  title: string;
  /** The file's name, which picks the colours for code. */
  fileName: string;
  /** Changes when the bytes change, such as a blob hash or a file's modification time. */
  version: string;
};
/** Lines to scroll to and mark, numbered from 1, both ends included. */
export type MarkedLines = { start: number; end: number };
type ViewerProps = { content: FileContent; lines?: MarkedLines };

const decodeText = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * Lines per block. Blocks away from the view keep their text as one plain text node, laid
 * out like the numbered lines, so Select All and copy include the whole file. Copied text
 * equals the file's text: an empty numbered line holds a `<br>`, and a plain block that
 * ends with an empty line gets one more newline, because a block's final newline neither
 * shows nor copies. A file that ends with a newline shows an empty last line, as editors do.
 */
const TEXT_BLOCK_LINES = 500;

const TextBlock = memo(function TextBlock({
  lines,
  colored,
  first,
  marked,
  shown,
}: {
  lines: readonly string[];
  /** The block's lines split into coloured runs, once colouring reaches this block. */
  colored: ColoredText[][] | undefined;
  first: number;
  marked: MarkedLines | undefined;
  shown: boolean;
}) {
  if (!shown)
    return (
      <div className="text-block" data-block={first} data-plain>
        {lines.join("\n") + (lines.at(-1) === "" ? "\n" : "")}
      </div>
    );
  return (
    <div className="text-block" data-block={first}>
      {lines.map((text, index) => (
        <div
          key={index}
          className="text-line"
          data-line={first + index}
          data-marked={
            (marked && first + index >= marked.start && first + index <= marked.end) || undefined
          }
          aria-current={first + index === marked?.start || undefined}
        >
          {!text ? (
            <br />
          ) : colored?.[index] ? (
            colored[index].map((part, run) => (
              <span key={run} style={part.style}>
                {part.text}
              </span>
            ))
          ) : (
            text
          )}
        </div>
      ))}
    </div>
  );
});

/** The visible height of the nearest scrolling ancestor, or of the window. */
function scrollHeight(element: HTMLElement): number {
  for (let parent = element.parentElement; parent; parent = parent.parentElement)
    if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent.clientHeight;
  return window.innerHeight;
}

/**
 * Text with line numbers. `lines` scrolls to and marks those lines. Long files number only
 * the blocks near the view, so a 2 MiB log with 300,000 short lines stays responsive.
 */
function TextView({ content, lines }: ViewerProps) {
  const start = lines?.start;
  const end = lines?.end ?? start;
  const blocks = useMemo(() => {
    const all = decodeText(content.bytes).split("\n");
    const result: { first: number; lines: string[] }[] = [];
    for (let index = 0; index < all.length; index += TEXT_BLOCK_LINES)
      result.push({
        first: index + 1,
        lines: all.slice(index, index + TEXT_BLOCK_LINES).map((text) => text.replace(/\r$/, "")),
      });
    return result;
  }, [content.bytes]);
  // Code is coloured in the background, block by block; until then it shows plain.
  const [colors, setColors] = useState<ReadonlyMap<number, ColoredText[][]>>(new Map());
  useEffect(() => {
    setColors(new Map());
    if (content.bytes.byteLength > MAX_COLORED_BYTES) return;
    const controller = new AbortController();
    const lines = blocks.flatMap((block) => block.lines);
    void languageFor(content.fileName)
      .then(async (language) => {
        if (language)
          await colorBlocks(
            lines,
            TEXT_BLOCK_LINES,
            language,
            controller.signal,
            (index, colored) => setColors((current) => new Map(current).set(index, colored)),
          );
      })
      .catch(() => {});
    return () => controller.abort();
  }, [blocks, content.bytes, content.fileName]);
  const lineCount = blocks.length ? blocks.at(-1)!.first + blocks.at(-1)!.lines.length - 1 : 0;
  const target = start ? Math.floor((start - 1) / TEXT_BLOCK_LINES) : 0;
  const last = end ? Math.min(Math.floor((end - 1) / TEXT_BLOCK_LINES), target + 1) : 0;
  const [shown, setShown] = useState<ReadonlySet<number>>(() => new Set([0, target, last]));
  const container = useRef<HTMLPreElement>(null);
  useEffect(
    () => setShown((current) => new Set([...current, target, last])),
    [target, last, blocks],
  );
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
  // Scrolls once per requested range, after its first block has rendered: a range that
  // fits is centred, a taller one starts at the top.
  const scrolled = useRef<{ range: string | undefined; blocks: unknown }>({
    range: undefined,
    blocks: undefined,
  });
  useLayoutEffect(() => {
    const range = start ? `${start}-${end}` : undefined;
    if (!range || (scrolled.current.range === range && scrolled.current.blocks === blocks)) return;
    const first = container.current?.querySelector(`[data-line="${start}"]`);
    if (!first) return;
    scrolled.current = { range, blocks };
    const final = container.current?.querySelector(`[data-line="${end}"]`);
    const height = final
      ? final.getBoundingClientRect().bottom - first.getBoundingClientRect().top
      : Infinity;
    const fits = start === end || height <= scrollHeight(container.current!) * 0.8;
    const middle = fits && final ? Math.round((start! + end!) / 2) : start;
    (container.current?.querySelector(`[data-line="${middle}"]`) ?? first).scrollIntoView({
      block: fits ? "center" : "start",
      behavior: "instant",
    });
  }, [start, end, blocks, shown]);
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
          colored={colors.get(index)}
          first={block.first}
          marked={start ? { start, end: end ?? start } : undefined}
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
 * tab previews. Kinds without a viewer show `fallback`. HTML is trusted and runs
 * without an iframe sandbox.
 */
export const FileViews = memo(function FileViews({
  content,
  lines,
  fallback,
}: ViewerProps & { fallback: ReactNode }) {
  const Viewer = Object.hasOwn(viewers, content.kind)
    ? viewers[content.kind as keyof typeof viewers]
    : undefined;
  if (!Viewer) return fallback;
  return <Viewer content={content} {...(lines ? { lines } : {})} />;
});
