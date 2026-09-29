import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { decode, MAX_CONTENT_BYTES } from "@irudd-scope/protocol";
import { ShareMediaType } from "@irudd-scope/protocol/sharing";
import type { ArtifactContent } from "./bridge.ts";
import type { SharedSnapshot } from "./sharing.ts";

export function snapshotContent(tabId: string, item: ArtifactContent): SharedSnapshot {
  let bytes = Buffer.from(item.bytes);
  let mediaType = item.artifact.mediaType;
  if (item.artifact.kind === "markdown") {
    const markup = renderToStaticMarkup(
      createElement(ReactMarkdown, {
        skipHtml: true,
        components: {
          a: ({ children }) => createElement("span", null, children),
          img: ({ alt }) => createElement("span", null, alt),
        },
        children: bytes.toString("utf8"),
      }),
    );
    bytes = Buffer.from(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shared document</title><style>body{max-width:70ch;margin:2rem auto;padding:0 1rem;font:18px/1.6 system-ui}pre{white-space:pre-wrap}img{max-width:100%}</style></head><body>${markup}</body></html>`,
    );
    mediaType = "text/html";
  }
  if (!["html", "markdown", "text", "image"].includes(item.artifact.kind))
    throw new Error("This tab type cannot be shared.");
  if (bytes.length > MAX_CONTENT_BYTES) throw new Error("The exported snapshot exceeds 32 MiB.");
  return {
    tabId,
    title: item.artifact.title,
    mediaType: decode(ShareMediaType, mediaType),
    content: bytes.toString("base64"),
  };
}
