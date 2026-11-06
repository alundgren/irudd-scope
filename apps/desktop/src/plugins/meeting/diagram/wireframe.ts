import { escapeHtml } from "../html.ts";
import type { Header } from "./header.ts";
import { cleanLabel, splitDetail } from "./text.ts";

const MAX_ELEMENTS = 150;
const MAX_DEPTH = 8;
const MAX_COLUMNS = 8;

type Element = {
  type: string;
  text: string;
  indent: number;
  children: Element[];
  rows: string[][];
};

/**
 * `wireframe [desktop|mobile]`. One element per line (`button: Save [primary]`),
 * with indented lines as children of the element above. Lines starting with `|`
 * are rows of the table above. Unknown elements render as text.
 */
export function renderWireframe(header: Header, lines: readonly string[]): string | null {
  const elements = parseWireframe(lines);
  if (elements.length === 0) return null;
  const mobile = /^(mobile|phone)$/i.test(header.arg.trim());
  const chrome = mobile
    ? `<div class="mc-wf-chrome" aria-hidden="true"><span class="mc-wf-speaker"></span></div>`
    : `<div class="mc-wf-chrome" aria-hidden="true"><span class="mc-wf-dots"><i></i><i></i><i></i></span><span class="mc-wf-url"></span></div>`;
  const home = mobile ? `<div class="mc-wf-home" aria-hidden="true"></div>` : "";
  const label = escapeHtml(header.title || "Wireframe");
  return (
    `<div class="mc-wf ${mobile ? "is-mobile" : "is-desktop"}" aria-label="${label}">` +
    `${chrome}<div class="mc-wf-screen">${renderList(elements)}</div>${home}</div>`
  );
}

function parseWireframe(lines: readonly string[]): Element[] {
  const root: Element = { type: "root", text: "", indent: -1, children: [], rows: [] };
  const stack: Element[] = [root];
  let table: Element | null = null;
  let count = 0;
  for (const line of lines) {
    if (count >= MAX_ELEMENTS) break;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim().replace(/^[-*•]\s+/u, "");
    if (trimmed.startsWith("|") && table && indent >= table.indent) {
      count += addRow(table, trimmed);
      continue;
    }
    const element = parseElement(trimmed, indent);
    count += 1;
    place(stack, element);
    if (element.type === "table") table = element;
    else if (table && indent <= table.indent) table = null;
  }
  return root.children;
}

/** Adds `element` under the nearest less indented element on `stack`. */
function place(stack: Element[], element: Element): void {
  while (stack.length > 1 && stack.at(-1)!.indent >= element.indent) stack.pop();
  if (stack.length > MAX_DEPTH) stack.pop();
  stack.at(-1)!.children.push(element);
  stack.push(element);
}

/** Adds a `| a | b |` row to `table` and returns how many rows it added. */
function addRow(table: Element, line: string): number {
  const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(cleanLabel);
  // Markdown separator rows such as `|---|---|` carry no content.
  if (cells.every((cell) => /^:?-*:?$/.test(cell))) return 0;
  table.rows.push(cells.slice(0, MAX_COLUMNS));
  return 1;
}

function parseElement(line: string, indent: number): Element {
  const match = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
  const type = (match?.[1] ?? "").toLowerCase();
  if (match && Object.hasOwn(ELEMENT_HTML, type)) {
    return { type, text: (match[2] ?? "").trim(), indent, children: [], rows: [] };
  }
  return { type: "text", text: line, indent, children: [], rows: [] };
}

const esc = (text: string) => escapeHtml(cleanLabel(text));

/** Splits `a | b | c` into trimmed, non-empty parts. */
function parts(text: string): string[] {
  return text.split("|").map(cleanLabel).filter(Boolean);
}

/** Takes a trailing `[word]` from `text` when it is one of `words`. */
function flag(text: string, words: readonly string[]): { text: string; flag: string | null } {
  const match = /\s*\[([^\][]*)\]\s*$/.exec(text);
  const word = (match?.[1] ?? "").trim().toLowerCase();
  if (!match || !words.includes(word)) return { text, flag: null };
  return { text: text.slice(0, match.index), flag: word };
}

/**
 * Children in a column. A `sidebar` puts the elements after it in a main column
 * beside it, so `nav`, then `sidebar`, then content reads as an app layout.
 * Trailing footers stay full width below.
 */
function renderList(elements: readonly Element[]): string {
  const side = elements.findIndex((element) => element.type === "sidebar");
  if (side < 0) return elements.map(renderElement).join("");
  let end = elements.length;
  while (end > side + 1 && elements[end - 1]!.type === "footer") end -= 1;
  const before = elements.slice(0, side).map(renderElement).join("");
  const main = renderList(elements.slice(side + 1, end));
  const after = elements.slice(end).map(renderElement).join("");
  return (
    `${before}<div class="mc-wf-split">${renderElement(elements[side]!)}` +
    `<div class="mc-wf-main">${main}</div></div>${after}`
  );
}

function renderElement(element: Element): string {
  const render = ELEMENT_HTML[element.type] ?? ELEMENT_HTML.text!;
  return render(element);
}

/** Children of an element, in a column. */
const kids = (element: Element) => renderList(element.children);

/** Element HTML followed by its children, for elements that hold none themselves. */
const leaf =
  (html: (text: string) => string) =>
  (element: Element): string =>
    html(element.text) + kids(element);

const ELEMENT_HTML: Record<string, (element: Element) => string> = {
  nav: (element) => {
    const [brand, ...links] = parts(element.text);
    const logo = brand
      ? `<span class="mc-wf-brand">${esc(brand)}</span>`
      : `<span class="mc-wf-logo"></span>`;
    const items = links.map((link) => `<span class="mc-wf-link">${esc(link)}</span>`).join("");
    const inner = kids(element);
    const end = inner ? `<span class="mc-wf-nav-end">${inner}</span>` : "";
    return `<div class="mc-wf-nav">${logo}<span class="mc-wf-links">${items}</span>${end}</div>`;
  },
  header: (element) => {
    const { head, detail } = splitDetail(element.text);
    const heading = head ? `<div class="mc-wf-h1">${esc(head)}</div>` : bars(1, "is-heading");
    const sub = detail ? `<div class="mc-wf-sub">${esc(detail)}</div>` : "";
    const inner = kids(element);
    const actions = inner ? `<div class="mc-wf-actions">${inner}</div>` : "";
    return `<div class="mc-wf-header"><div class="mc-wf-header-text">${heading}${sub}</div>${actions}</div>`;
  },
  title: leaf((text) =>
    text ? `<div class="mc-wf-title">${esc(text)}</div>` : bars(1, "is-heading"),
  ),
  text: leaf((text) => (text ? `<p class="mc-wf-text">${esc(text)}</p>` : bars(3))),
  field: leaf((text) => {
    const { head, detail } = splitDetail(text);
    return field(head, `<span class="mc-wf-input">${placeholder(detail)}</span>`);
  }),
  search: leaf(
    (text) =>
      `<div class="mc-wf-input is-search"><span class="mc-wf-glass" aria-hidden="true"></span>${placeholder(text || "Search")}</div>`,
  ),
  button: leaf((text) => {
    const { text: label, flag: kind } = flag(text, ["primary"]);
    const shown = cleanLabel(label) || "Button";
    return `<span class="mc-wf-button${kind ? " is-primary" : ""}">${esc(shown)}</span>`;
  }),
  toggle: leaf((text) => {
    const { text: label, flag: state } = flag(text, ["on", "off"]);
    const on = state === "on";
    return (
      `<div class="mc-wf-control is-toggle"><span class="mc-wf-control-label">${esc(label)}</span>` +
      `<span class="mc-wf-switch${on ? " is-on" : ""}" role="img" aria-label="${on ? "On" : "Off"}"></span></div>`
    );
  }),
  checkbox: (element) => choice("checkbox", element),
  radio: (element) => choice("radio", element),
  select: leaf((text) => {
    const { head, detail } = splitDetail(text);
    return field(
      head,
      `<span class="mc-wf-input is-select">${placeholder(detail, true)}<span class="mc-wf-chevron" aria-hidden="true"></span></span>`,
    );
  }),
  chips: leaf((text) => {
    const chips = parts(text).map((chip) => `<span class="mc-wf-chip">${esc(chip)}</span>`);
    return `<div class="mc-wf-chips">${chips.join("")}</div>`;
  }),
  image: leaf(
    (text) =>
      `<div class="mc-wf-image">${text ? `<span class="mc-wf-caption">${esc(text)}</span>` : ""}</div>`,
  ),
  card: (element) => {
    const { head, detail } = splitDetail(element.text);
    const title = head ? `<div class="mc-wf-card-title">${esc(head)}</div>` : "";
    const sub = detail ? `<div class="mc-wf-sub">${esc(detail)}</div>` : "";
    return `<div class="mc-wf-card">${title}${sub}${kids(element)}</div>`;
  },
  list: (element) => {
    const title = element.text ? `<div class="mc-wf-list-title">${esc(element.text)}</div>` : "";
    return `<div class="mc-wf-list">${title}${kids(element) || bars(3, "is-rows")}</div>`;
  },
  item: leaf((text) => {
    const [main, ...meta] = parts(text);
    const second =
      meta.length > 0 ? `<span class="mc-wf-meta">${esc(meta.join(" · "))}</span>` : "";
    return `<div class="mc-wf-item"><span class="mc-wf-item-text">${main ? esc(main) : ""}</span>${second}</div>`;
  }),
  table: (element) => tableHtml(element) + kids(element),
  tabs: (element) => {
    const tabs = parts(element.text).map(
      (tab, index) =>
        `<span class="mc-wf-tab${index === 0 ? " is-active" : ""}">${esc(tab)}</span>`,
    );
    const inner = kids(element);
    const panel = inner ? `<div class="mc-wf-tab-panel">${inner}</div>` : "";
    return `<div class="mc-wf-tabs"><div class="mc-wf-tab-strip">${tabs.join("")}</div>${panel}</div>`;
  },
  row: (element) => {
    const cells = element.children.map(
      (child) => `<div class="mc-wf-cell">${renderElement(child)}</div>`,
    );
    return `<div class="mc-wf-row">${cells.join("")}</div>`;
  },
  sidebar: (element) => {
    const title = element.text ? `<div class="mc-wf-list-title">${esc(element.text)}</div>` : "";
    return `<div class="mc-wf-sidebar">${title}${kids(element) || bars(4, "is-rows")}</div>`;
  },
  modal: (element) =>
    `<div class="mc-wf-backdrop"><div class="mc-wf-modal"><div class="mc-wf-modal-head">` +
    `<span class="mc-wf-card-title">${esc(element.text || "Dialog")}</span><span class="mc-wf-close" aria-hidden="true">×</span></div>` +
    `${kids(element)}</div></div>`,
  footer: (element) => {
    const text = parts(element.text).map((part) => `<span>${esc(part)}</span>`);
    return `<div class="mc-wf-footer">${text.join("")}${kids(element)}</div>`;
  },
};

function choice(type: "checkbox" | "radio", element: Element): string {
  const { text: label, flag: state } = flag(element.text, ["x", "", "✓"]);
  const on = state !== null && state !== "";
  return (
    `<div class="mc-wf-control"><span class="mc-wf-${type}${on ? " is-on" : ""}" role="img" aria-label="${on ? "Selected" : "Not selected"}"></span>` +
    `<span class="mc-wf-control-label">${esc(label)}</span></div>${kids(element)}`
  );
}

function field(label: string, control: string): string {
  const shown = label ? `<span class="mc-wf-label">${esc(label)}</span>` : "";
  return `<div class="mc-wf-field">${shown}${control}</div>`;
}

function placeholder(text: string, filled = false): string {
  return text
    ? `<span class="mc-wf-placeholder${filled ? " is-value" : ""}">${esc(text)}</span>`
    : "";
}

/** Grey placeholder bars standing in for text that has not been written. */
function bars(count: number, extra = ""): string {
  const items = Array.from({ length: count }, () => "<span></span>").join("");
  return `<div class="mc-wf-bars${extra ? ` ${extra}` : ""}" aria-hidden="true">${items}</div>`;
}

function tableHtml(table: Element): string {
  const columns = parts(table.text).slice(0, MAX_COLUMNS);
  const width = Math.max(columns.length, ...table.rows.map((row) => row.length), 1);
  const head = columns.length
    ? `<thead><tr>${columns.map((column) => `<th>${esc(column)}</th>`).join("")}${"<th></th>".repeat(width - columns.length)}</tr></thead>`
    : "";
  const rows =
    table.rows.length > 0
      ? table.rows.map((row) => {
          const cells = Array.from({ length: width }, (_, index) => row[index] ?? "");
          return `<tr>${cells.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`;
        })
      : Array.from(
          { length: 3 },
          () => `<tr>${'<td><span class="mc-wf-cell-bar"></span></td>'.repeat(width)}</tr>`,
        );
  return `<div class="mc-wf-table-wrap"><table class="mc-wf-table">${head}<tbody>${rows.join("")}</tbody></table></div>`;
}
