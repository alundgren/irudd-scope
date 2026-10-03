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
  const matches = Array.from(document.querySelectorAll(`#${CSS.escape(id)}`)).filter(
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
  private cursorMarkers = new Map<string, HTMLElement>();
  private frame: number | undefined;
  private commentsChanged = false;
  private pointerPosition: { x: number; y: number } | null = null;

  constructor(
    private iframe: HTMLIFrameElement,
    private markers: HTMLElement,
    private anchored: (html: string, anchor: CommentAnchor) => void,
    private cursor: (elementId: string | null, x: number, y: number) => void,
  ) {
    iframe.addEventListener("load", () => this.attach());
    const leave = () => {
      this.pointerPosition = null;
      this.cursor(null, -1, -1);
    };
    iframe.addEventListener("pointerleave", leave);
    window.addEventListener("blur", leave);
    new ResizeObserver(() => this.renderPresence(true)).observe(iframe);
  }

  show(html: string, history: boolean) {
    this.history = history;
    this.renderPresence();
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
    this.renderPresence(true);
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
    return Boolean(uniqueId(source, anchor.elementId) && element && this.authored(element));
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
    document.addEventListener("pointermove", (event) => {
      if (this.history) return;
      this.pointerPosition = { x: event.clientX, y: event.clientY };
      this.sendCursor(document, event.target as Element, event.clientX, event.clientY);
    });
    document.addEventListener("pointerleave", () => {
      this.pointerPosition = null;
      this.cursor(null, -1, -1);
    });
    document.addEventListener(
      "scroll",
      () => {
        this.renderPresence(true);
        const point = this.pointerPosition;
        const target = point && document.elementFromPoint(point.x, point.y);
        if (target) this.sendCursor(document, target, point!.x, point!.y);
      },
      true,
    );
    new MutationObserver(() => this.renderPresence(true)).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["id", "style", "class"],
    });
    this.renderPresence(true);
    this.iframe.dispatchEvent(new CustomEvent("previewready"));
  }

  private sendCursor(document: Document, target: Element, x: number, y: number) {
    if (this.history || document !== this.iframe.contentDocument) return;
    const id = target.closest?.("[id]")?.id ?? null;
    const element = id ? uniqueId(document, id) : null;
    const rect = element?.getBoundingClientRect();
    this.cursor(
      element?.id ?? null,
      rect ? (x - rect.left) / Math.max(rect.width, 1) : x + document.defaultView!.scrollX,
      rect ? (y - rect.top) / Math.max(rect.height, 1) : y + document.defaultView!.scrollY,
    );
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
      this.anchored(this.html, { elementId: null, quote, x, y });
      return;
    }
    if (canonical.id) {
      const valid =
        uniqueId(parsed, canonical.id) && uniqueId(this.iframe.contentDocument!, canonical.id);
      this.anchored(this.html, { elementId: valid ? canonical.id : null, ...point });
      return;
    }
    if (canonical.hasAttribute("id")) {
      this.anchored(this.html, { elementId: null, quote, x, y });
      return;
    }
    const token = this.locations[Number(target.getAttribute(this.attribute))];
    const id = `plan-${createId()}`;
    const offset = token.offset;
    const html = this.html.slice(0, offset) + ` id="${id}"` + this.html.slice(offset);
    this.anchored(html, { elementId: id, ...point });
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

  private renderPresence(commentsChanged = false) {
    this.commentsChanged ||= commentsChanged;
    if (this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.paintPresence();
    });
  }

  private paintPresence() {
    const document = this.iframe.contentDocument;
    if (!document) return;
    if (this.commentsChanged) this.paintComments(document);
    const active = new Set<string>();
    for (const person of this.people) {
      active.add(person.sessionId);
      let marker = this.cursorMarkers.get(person.sessionId);
      if (!marker) {
        marker = window.document.createElement("div");
        marker.className = "cursor";
        marker.dataset.sessionId = person.sessionId;
        this.cursorMarkers.set(person.sessionId, marker);
        this.markers.append(marker);
      }
      const point = this.cursorPoint(document, person);
      marker.hidden = this.history || !point;
      if (point) {
        marker.style.left = `${point.x}px`;
        marker.style.top = `${point.y}px`;
      }
      const label = `↖ ${person.actor.name}${person.actor.kind === "agent" ? " · agent" : ""}`;
      if (marker.textContent !== label) marker.textContent = label;
    }
    for (const [sessionId, marker] of this.cursorMarkers) {
      if (active.has(sessionId)) continue;
      marker.remove();
      this.cursorMarkers.delete(sessionId);
    }
  }

  private cursorPoint(document: Document, person: Presence) {
    const element = person.elementId ? uniqueId(document, person.elementId) : null;
    if (person.elementId && !element) return null;
    if (!person.elementId && (person.x < 0 || person.y < 0)) return null;
    const rect = element?.getBoundingClientRect();
    const x = rect ? rect.left + person.x * rect.width : person.x - document.defaultView!.scrollX;
    const y = rect ? rect.top + person.y * rect.height : person.y - document.defaultView!.scrollY;
    return x < 0 || y < 0 || x > this.iframe.clientWidth || y > this.iframe.clientHeight
      ? null
      : { x, y };
  }

  private paintComments(document: Document) {
    this.commentsChanged = false;
    this.markers.querySelectorAll(".comment-marker").forEach((marker) => marker.remove());
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
  }
}
