import type { CommentAnchor, PlanComment, Presence } from "../contracts.ts";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { createId } from "./identity.ts";

type SourceTag = { tag: string; offset: number };
function sourceTags(html: string) {
  const result: SourceTag[] = [];
  const visit = (node: DefaultTreeAdapterMap["node"]) => {
    if ("tagName" in node) {
      const location = node.sourceCodeLocation?.startTag;
      if (location) {
        const opening = html.slice(location.startOffset, location.endOffset);
        const name = /^<[^\t\n\f\r />]+/.exec(opening)?.[0];
        if (name)
          result.push({
            tag: node.tagName.toLowerCase(),
            offset: location.startOffset + name.length,
          });
      }
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
    if ("content" in node) visit(node.content);
  };
  visit(parse(html, { sourceCodeLocationInfo: true, scriptingEnabled: true }));
  // Parser repairs can produce multiple nodes from one tag; those nodes cannot anchor safely.
  const counts = new Map<number, number>();
  for (const item of result) counts.set(item.offset, (counts.get(item.offset) ?? 0) + 1);
  return result.filter((item) => counts.get(item.offset) === 1).sort((a, b) => a.offset - b.offset);
}

function uniqueId(document: Document, id: string) {
  const matches = Array.from(document.querySelectorAll("[id]")).filter(
    (element) => element.id === id,
  );
  return matches.length === 1 ? matches[0] : null;
}

export class HtmlPreview {
  private html = "";
  private canonical = new DOMParser().parseFromString("", "text/html");
  private attribute = `data-scope-source-${createId()}`;
  private locations: SourceTag[] = [];
  private commenting = false;
  private people: Presence[] = [];
  private comments: PlanComment[] = [];
  private history = false;

  constructor(
    private iframe: HTMLIFrameElement,
    private markers: HTMLElement,
    private anchored: (anchor: CommentAnchor) => void,
    private cursor: (elementId: string | null, x: number, y: number) => void,
  ) {
    iframe.addEventListener("load", () => this.attach());
  }

  show(html: string, history: boolean) {
    this.history = history;
    if (html === this.html && this.iframe.srcdoc) return;
    this.html = html;
    this.attribute = `data-scope-source-${createId()}`;
    this.locations = sourceTags(html);
    let marked = html;
    for (let index = this.locations.length - 1; index >= 0; index--) {
      const offset = this.locations[index].offset;
      marked = marked.slice(0, offset) + ` ${this.attribute}="${index}"` + marked.slice(offset);
    }
    this.canonical = new DOMParser().parseFromString(marked, "text/html");
    this.iframe.srcdoc = marked;
  }

  setCommenting(value: boolean) {
    this.commenting = value;
    this.iframe.classList.toggle("commenting", value);
    this.markers.classList.toggle("commenting", value);
    this.markers.querySelectorAll<HTMLButtonElement>(".comment-marker").forEach((marker) => {
      marker.disabled = value;
    });
  }
  setComments(comments: PlanComment[]) {
    this.comments = comments;
    this.renderPresence();
  }

  setPresence(people: Presence[]) {
    this.people = people;
    this.renderPresence();
  }

  connected(anchor: CommentAnchor) {
    if (!anchor.elementId) return false;
    const source = this.canonical;
    const live = this.iframe.contentDocument;
    const element = live ? uniqueId(live, anchor.elementId) : null;
    const authored = element ? this.authored(element) : null;
    return Boolean(uniqueId(source, anchor.elementId) && authored?.id === anchor.elementId);
  }

  private attach() {
    const document = this.iframe.contentDocument;
    if (!document) return;
    document.addEventListener(
      "click",
      (event) => {
        if (!this.commenting || this.history) return;
        event.preventDefault();
        event.stopPropagation();
        const target = event.target;
        if (!target || (target as Node).nodeType !== Node.ELEMENT_NODE) return;
        this.anchor(target as Element, event.clientX, event.clientY);
      },
      true,
    );
    let lastCursor = 0;
    document.addEventListener("pointermove", (event) => {
      if (Date.now() - lastCursor < 90) return;
      lastCursor = Date.now();
      const target = event.target as Element;
      const id = target.closest?.("[id]")?.id ?? null;
      const element = id ? uniqueId(document, id) : null;
      const rect = element?.getBoundingClientRect();
      this.cursor(
        element?.id ?? null,
        rect ? (event.clientX - rect.left) / Math.max(rect.width, 1) : event.clientX,
        rect ? (event.clientY - rect.top) / Math.max(rect.height, 1) : event.clientY,
      );
    });
    document.addEventListener("scroll", () => this.renderPresence(), true);
    this.renderPresence();
    this.iframe.dispatchEvent(new CustomEvent("previewready"));
  }

  private anchor(target: Element, x: number, y: number) {
    const parsed = this.canonical;
    const canonical = this.authored(target);
    const rect = target.getBoundingClientRect();
    const quote = (target.textContent ?? "").trim().slice(0, 180);
    const point = {
      quote,
      x: (x - rect.left) / Math.max(rect.width, 1),
      y: (y - rect.top) / Math.max(rect.height, 1),
    };
    if (
      !canonical ||
      canonical.tagName !== target.tagName ||
      (canonical.textContent ?? "").trim().slice(0, 180) !== quote
    ) {
      this.anchored({ elementId: null, quote, x, y });
      return;
    }
    if (canonical.id) {
      const valid =
        uniqueId(parsed, canonical.id) &&
        uniqueId(this.iframe.contentDocument!, canonical.id) === target;
      this.anchored({ elementId: valid ? canonical.id : null, ...point });
      return;
    }
    if (canonical.hasAttribute("id")) {
      this.anchored({ elementId: null, quote, x, y });
      return;
    }
    this.anchored({ elementId: null, quote, x, y });
  }

  private authored(target: Element): Element | null {
    const marker = target.getAttribute(this.attribute);
    if (marker === null || !/^\d+$/.test(marker)) return null;
    const selector = `[${this.attribute}="${marker}"]`;
    const source = this.canonical.querySelectorAll(selector);
    const live = this.iframe.contentDocument?.querySelectorAll(selector);
    if (source.length !== 1 || live?.length !== 1 || live[0] !== target) return null;
    const token = this.locations[Number(marker)];
    return token?.tag === target.tagName.toLowerCase() ? source[0] : null;
  }

  private renderPresence() {
    this.markers.replaceChildren();
    const document = this.iframe.contentDocument;
    if (!document) return;
    for (const [index, comment] of this.comments.entries()) {
      if (!comment.anchor.elementId || !this.connected(comment.anchor)) continue;
      const element = uniqueId(document, comment.anchor.elementId)!;
      const rect = element.getBoundingClientRect();
      const marker = window.document.createElement("button");
      marker.className = "comment-marker";
      marker.disabled = this.commenting;
      marker.style.left = `${rect.left + comment.anchor.x * rect.width}px`;
      marker.style.top = `${rect.top + comment.anchor.y * rect.height}px`;
      marker.textContent = String(index + 1);
      marker.setAttribute("aria-label", `Comment ${index + 1}: ${comment.text}`);
      marker.addEventListener("click", () =>
        this.iframe.dispatchEvent(new CustomEvent("commentselected", { detail: comment.id })),
      );
      this.markers.append(marker);
    }
    for (const person of this.people) {
      const element = person.elementId ? uniqueId(document, person.elementId) : null;
      const rect = element?.getBoundingClientRect();
      const x = rect ? rect.left + person.x * rect.width : person.elementId ? -100 : person.x;
      const y = rect ? rect.top + person.y * rect.height : person.elementId ? -100 : person.y;
      if (x < 0 || y < 0 || x > this.iframe.clientWidth || y > this.iframe.clientHeight) continue;
      const marker = window.document.createElement("div");
      marker.className = "cursor";
      marker.style.left = `${x}px`;
      marker.style.top = `${y}px`;
      marker.textContent = `↖ ${person.actor.name}${person.actor.kind === "agent" ? " · agent" : ""}`;
      this.markers.append(marker);
    }
  }
}
