import type { PlanSnapshot, Presence } from "../contracts.ts";
import { Discussion } from "./discussion.ts";
import { editorIdentity } from "./editor-identity.ts";
import { SavedDrafts } from "./drafts.ts";
import { RejectedChanges } from "./rejections.ts";
import { fakeUsers, selectedFakeUser } from "./fake-users.ts";
import { History } from "./history.ts";
import { HtmlPreview } from "./preview.ts";
import { PlanSync, type SyncView } from "./sync.ts";
import "./style.css";

if (location.pathname === "/") location.replace("/plans/welcome");
const name = decodeURIComponent(location.pathname.slice("/plans/".length)) || "welcome";
const editor = await editorIdentity();
const actor = selectedFakeUser();
const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<header><div class="plan-name"><span class="brand">Scope plans</span><h1></h1></div><div class="identity"><label for="fake-user">User</label><select id="fake-user"><option value="fake-user-alex">Alex</option><option value="fake-user-blair">Blair</option><option value="fake-user-casey">Casey</option></select></div><div id="people" aria-label="People in this plan"></div></header>
  <nav aria-label="Plan controls"><div class="sync"><span id="connection"></span><span id="sync-status" role="status" aria-live="polite">Opening local database…</span></div><div class="actions"><button id="save" disabled>Save now</button><button id="comment-mode" aria-pressed="false" disabled>Comment on preview</button><button id="comments-button" aria-pressed="true">Comments</button><button id="history-button" aria-pressed="false">History</button><button id="drafts-button" aria-pressed="false">Saved browser drafts</button><button id="rejections-button" aria-pressed="false">Rejected changes</button><button id="export">Export HTML</button></div></nav>
  <div id="storage-recovery" class="notice error" hidden><span>Your current HTML remains in this tab. Export it before closing.</span><button id="retry-storage">Retry local save</button></div>
  <div id="history-notice" class="notice" hidden><span></span><button id="return-live">Return to live plan</button></div>
  <section id="conflict" class="conflict" aria-label="HTML conflict" hidden><div class="panel-heading"><h2>Review overlapping edits</h2><span>Your local HTML is preserved.</span></div><div class="conflict-editors"><label>Merge local HTML<textarea id="merge-html" rows="8"></textarea></label><label>Server HTML<textarea id="server-html" rows="8" readonly></textarea></label></div><div class="actions"><button id="retry-merged" class="primary">Retry merged HTML</button><button id="use-server">Use server HTML</button></div></section>
  <main><section class="source-pane"><div class="pane-heading"><label for="source">HTML source</label><span id="revision">Loading</span></div><textarea id="source" spellcheck="false" aria-label="HTML source" readonly></textarea></section><section class="preview-pane"><div class="pane-heading"><span>Live preview</span><span id="preview-mode"></span></div><div class="preview-container"><iframe title="Plan preview"></iframe><div id="cursor-markers" aria-label="Plan comments"></div></div></section><aside id="side-panel"><section id="discussion"></section><section id="history" hidden></section><section id="saved-drafts" hidden></section><section id="rejections" hidden></section></aside></main>
  <section id="version-diff" hidden><h2>Git diff</h2><pre></pre></section>`;
app.querySelector("h1")!.textContent = name;
document.title = `${name} · Scope plans`;
const source = app.querySelector<HTMLTextAreaElement>("#source")!;
const mergeInput = app.querySelector<HTMLTextAreaElement>("#merge-html")!;
const serverInput = app.querySelector<HTMLTextAreaElement>("#server-html")!;
const identity = app.querySelector<HTMLSelectElement>("#fake-user")!;
identity.value = actor.id;
let view: SyncView = {
  snapshot: null,
  draft: null,
  status: "Opening",
  connected: false,
  storageError: false,
  restoring: false,
};
let version: PlanSnapshot | null = null;
let commentMode = false;
let conflictGeneration = -1;
const sync = new PlanSync(name, editor, actor, render, renderPeople);
const preview = new HtmlPreview(
  app.querySelector("iframe")!,
  app.querySelector("#cursor-markers")!,
  (html, anchor) => {
    if (html !== source.value) sync.edit(html);
    discussion.select(anchor);
    showPanel("comments");
    commentMode = false;
    updateCommentMode();
  },
  (elementId, x, y) => sync.cursor(elementId, x, y),
);
const discussion = new Discussion(
  app.querySelector("#discussion")!,
  () => sync.actor,
  (command) => sync.command(command),
  (anchor) => preview.connected(anchor),
);
const history = new History(app.querySelector("#history")!, name, (snapshot, event) => {
  version = snapshot;
  app.querySelector<HTMLElement>("#history-notice")!.hidden = false;
  app.querySelector("#history-notice span")!.textContent =
    `Version ${snapshot.revision} · read-only · ${event.actor.name}`;
  app.querySelector<HTMLElement>("#version-diff")!.hidden = false;
  app.querySelector("#version-diff pre")!.textContent = event.diff || "No content diff.";
  render(view);
});

const savedDrafts = new SavedDrafts(
  app.querySelector("#saved-drafts")!,
  () => sync.savedDrafts(),
  async (id) => {
    await sync.recover(id);
    version = null;
    app.querySelector<HTMLElement>("#history-notice")!.hidden = true;
    app.querySelector<HTMLElement>("#version-diff")!.hidden = true;
    showPanel("comments");
    render(view);
  },
  editor,
  () => view.restoring,
);

const rejections = new RejectedChanges(
  app.querySelector("#rejections")!,
  () => sync.rejectedChanges(),
  () => sync.actor,
  async (requestId) => {
    await sync.restoreRejected(requestId);
    version = null;
    app.querySelector<HTMLElement>("#history-notice")!.hidden = true;
    app.querySelector<HTMLElement>("#version-diff")!.hidden = true;
    render(view);
    source.focus();
  },
  (requestId, replacement) => sync.dismissRejected(requestId, replacement),
  () => view.restoring,
);

function render(next: SyncView) {
  view = next;
  const snapshot = version ?? next.snapshot;
  const html = version?.html ?? next.draft?.html ?? next.snapshot?.html ?? source.value;
  setTextarea(source, html);
  source.readOnly = Boolean(version) || next.restoring || !next.snapshot || !next.draft;
  mergeInput.readOnly = next.restoring;
  app
    .querySelectorAll<HTMLButtonElement>(
      "#retry-merged, #use-server, .restore-draft, .restore-rejected",
    )
    .forEach((button) => {
      button.disabled = next.restoring;
    });
  if (next.restoring) {
    commentMode = false;
    preview.setCommenting(false);
  }
  preview.show(html, Boolean(version));
  app.querySelector("#sync-status")!.textContent = next.status;
  app.querySelector("#connection")!.textContent = next.connected ? "Live" : "Offline";
  app.querySelector("#connection")!.className = next.connected ? "online" : "offline";
  app.querySelector("#revision")!.textContent = snapshot
    ? `Version ${snapshot.revision}`
    : "Loading";
  app.querySelector("#preview-mode")!.textContent = version
    ? "Read-only version"
    : commentMode
      ? "Click to comment"
      : "";
  app.querySelector<HTMLElement>("#storage-recovery")!.hidden = !next.storageError;
  const conflict = next.draft?.conflict;
  app.querySelector<HTMLElement>("#conflict")!.hidden = !conflict || Boolean(version);
  if (conflict) {
    if (conflictGeneration !== next.draft!.generation) {
      setTextarea(mergeInput, next.draft!.html);
      conflictGeneration = next.draft!.generation;
    }
    setTextarea(serverInput, conflict.html);
  } else conflictGeneration = -1;
  app.querySelector<HTMLButtonElement>("#save")!.disabled =
    Boolean(version) ||
    !next.snapshot ||
    !next.draft ||
    Boolean(conflict) ||
    next.storageError ||
    next.restoring;
  app.querySelector<HTMLButtonElement>("#comment-mode")!.disabled =
    Boolean(version) || !next.snapshot || !next.draft || next.storageError || next.restoring;
  preview.setComments(snapshot?.comments ?? []);
  discussion.render(snapshot?.comments ?? [], Boolean(version) || next.restoring);
}

function setTextarea(input: HTMLTextAreaElement, value: string) {
  if (input.value === value) return;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const scrollTop = input.scrollTop;
  input.value = value;
  input.setSelectionRange(Math.min(start, value.length), Math.min(end, value.length));
  input.scrollTop = scrollTop;
}

function renderPeople(people: Presence[]) {
  const list = app.querySelector("#people")!;
  list.replaceChildren();
  for (const person of people) {
    const item = document.createElement("span");
    item.className = "person";
    item.textContent = `${person.actor.name}${person.actor.kind === "agent" ? " · agent" : ""}${person.sessionId === editor ? " · you" : ""}`;
    list.append(item);
  }
  preview.setPresence(people.filter((person) => person.sessionId !== editor));
}

function showPanel(panel: "comments" | "history" | "drafts" | "rejections") {
  app.querySelector<HTMLElement>("#discussion")!.hidden = panel !== "comments";
  app.querySelector<HTMLElement>("#history")!.hidden = panel !== "history";
  app.querySelector<HTMLElement>("#saved-drafts")!.hidden = panel !== "drafts";
  app.querySelector<HTMLElement>("#rejections")!.hidden = panel !== "rejections";
  app
    .querySelector("#rejections-button")!
    .setAttribute("aria-pressed", String(panel === "rejections"));
  app.querySelector("#drafts-button")!.setAttribute("aria-pressed", String(panel === "drafts"));
  app.querySelector("#comments-button")!.setAttribute("aria-pressed", String(panel === "comments"));
  app.querySelector("#history-button")!.setAttribute("aria-pressed", String(panel === "history"));
  if (panel === "history") void history.open();
  if (panel === "drafts") void savedDrafts.open();
}
function updateCommentMode() {
  preview.setCommenting(commentMode);
  app.querySelector("#comment-mode")!.setAttribute("aria-pressed", String(commentMode));
  render(view);
}
source.addEventListener("input", () => sync.edit(source.value));
mergeInput.addEventListener("input", () => sync.edit(mergeInput.value));
identity.addEventListener("change", () => {
  const user = fakeUsers.find((candidate) => candidate.id === identity.value)!;
  sessionStorage.setItem("scope-plan-web-user", user.id);
  sync.selectActor({ ...user });
});
app.querySelector("#save")!.addEventListener("click", () => {
  void sync.save();
});
app.querySelector("#retry-storage")!.addEventListener("click", () => {
  void sync.retryStorage();
});
app.querySelector("#comment-mode")!.addEventListener("click", () => {
  commentMode = !commentMode;
  updateCommentMode();
});
app.querySelector("#comments-button")!.addEventListener("click", () => showPanel("comments"));
app.querySelector("#history-button")!.addEventListener("click", () => showPanel("history"));
app.querySelector("#drafts-button")!.addEventListener("click", () => showPanel("drafts"));
app.querySelector("#return-live")!.addEventListener("click", () => {
  version = null;
  app.querySelector<HTMLElement>("#history-notice")!.hidden = true;
  app.querySelector<HTMLElement>("#version-diff")!.hidden = true;
  render(view);
});
app.querySelector("#rejections-button")!.addEventListener("click", () => {
  showPanel("rejections");
  void rejections.open();
});
app.querySelector("#retry-merged")!.addEventListener("click", () => {
  void sync.resolve(mergeInput.value);
});
app.querySelector("#use-server")!.addEventListener("click", () => {
  void sync.resolve(serverInput.value);
});
app.querySelector("#export")!.addEventListener("click", () => {
  const url = URL.createObjectURL(
    new Blob([view.draft?.html ?? view.snapshot?.html ?? source.value], { type: "text/html" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name}.html`;
  link.click();
  URL.revokeObjectURL(url);
});
app
  .querySelector("iframe")!
  .addEventListener("previewready", () =>
    discussion.render(
      (version ?? view.snapshot)?.comments ?? [],
      Boolean(version) || view.restoring,
    ),
  );
app.querySelector("iframe")!.addEventListener("commentselected", (event) => {
  showPanel("comments");
  const id = (event as CustomEvent<string>).detail;
  const article = Array.from(app.querySelectorAll<HTMLElement>("[data-comment-id]")).find(
    (item) => item.dataset.commentId === id,
  );
  article?.scrollIntoView({ block: "nearest" });
  article?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && commentMode) {
    commentMode = false;
    updateCommentMode();
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "s") {
    event.preventDefault();
    if (!version) void sync.save();
  }
});
void sync.start();
window.addEventListener("pageshow", (event) => {
  // pagehide closes database ports; a restored page must reconnect and recover its durable draft.
  if (event.persisted) location.reload();
});
