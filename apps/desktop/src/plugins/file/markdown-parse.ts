import type { Nodes, Root } from "hast";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

// remark-rehype drops raw HTML by default.
const processor = unified().use(remarkParse).use(remarkRehype);

function removePositions(node: Nodes) {
  delete node.position;
  if ("children" in node) for (const child of node.children) removePositions(child);
}

export function parseMarkdown(markdown: string): Root {
  const tree = processor.runSync(processor.parse(markdown));
  // Rendering never reads positions, and they make the tree much slower to post between threads.
  removePositions(tree);
  return tree;
}
