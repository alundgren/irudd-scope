import { parseMarkdown } from "./markdown-parse.ts";

self.onmessage = ({ data }: MessageEvent<{ id: number; markdown: string }>) => {
  self.postMessage({ id: data.id, tree: parseMarkdown(data.markdown) });
};
