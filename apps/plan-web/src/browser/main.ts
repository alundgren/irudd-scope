import type { PlanSnapshot, Presence } from "../contracts.ts";
import { Discussion } from "./discussion.ts";
import { editorIdentity } from "./editor-identity.ts";
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
app.innerHTML = `<header><h1></h1><div class="identity"><label for="fake-user">User</label><select id="fake-user"><option value="fake-user-alex">Alex</option><option value="fake-user-blair">Blair</option><option value="fake-user-casey">Casey</option></select></div><div id="people" aria-label="People in this plan"></div><span id="connection"></span><button id="comment-attention" hidden>Rejected comment</button><button id="comment-mode" aria-pressed="false" disabled>Comment on preview</button><button id="comments-button" aria-pressed="false">Comments</button><details id="plan-menu"><summary aria-label="More plan actions">More</summary><div class="menu"><span id="revision"></span><span id="sync-status" role="status" aria-live="polite">Opening local database…</span><button id="history-button">History</button><button id="rejections-button">Rejected comments</button><button id="archive-button">Browser HTML archive</button><button id="export">Export HTML</button></div></details></header>
  <div id="storage-recovery" class="notice error" hidden><span>Comments need local storage. Any unsent text stays in its composer.</span><button id="retry-storage">Retry local storage</button></div>
  <div id="history-notice" class="notice" hidden><span></span><button id="return-live">Return to live plan</button></div>
  <main><section class="preview-pane"><div class="preview-container"><iframe title="Plan preview"></iframe><div id="cursor-markers" aria-label="Plan comments"></div></div></section><aside id="side-panel" hidden><button id="close-panel" aria-label="Close panel">Close</button><section id="discussion"></section><section id="history" hidden></section><section id="html-archive" hidden></section><section id="rejections" hidden></section><section id="version-diff" hidden><h2>Git diff</h2><pre></pre></section></aside></main>`;
app.querySelector("h1")!.textContent = name;
document.title = `${name} · Scope plans`;
const identity = app.querySelector<HTMLSelectElement>("#fake-user")!;
identity.value = actor.id;
let view: SyncView = {
  snapshot: null,
  status: "Opening",
  connected: false,
  storageError: false,
  commentReady: false,
};
let version: PlanSnapshot | null = null;
let commentMode = false;
let activePanel: "comments" | "history" | "archive" | "rejections" | null = null;
const sync = new PlanSync(name, editor, actor, render, renderPeople);
const preview = new HtmlPreview(
  app.querySelector("iframe")!,
  app.querySelector("#cursor-markers")!,
  (anchor) => {
    showPanel("comments");
    discussion.select(anchor);
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
  commentMode = false;
  updateCommentMode();
});
const rejections = new RejectedChanges(
  app.querySelector("#rejections")!,
  () => sync.rejectedChanges(),
  () => sync.actor,
  (requestId, replacement) => sync.dismissRejected(requestId, replacement),
);

function render(next: SyncView) {
  view = next;
  const snapshot = version ?? next.snapshot;
  if (snapshot) preview.show(snapshot.html, Boolean(version));
  app.querySelector("#sync-status")!.textContent = next.status;
  app.querySelector<HTMLElement>("#comment-attention")!.hidden =
    !next.status.startsWith("Rejected comment");
  app.querySelector("#connection")!.textContent = next.connected ? "Live" : "Offline";
  app.querySelector("#connection")!.className = next.connected ? "online" : "offline";
  app.querySelector("#revision")!.textContent = snapshot
    ? `Version ${snapshot.revision}`
    : "Loading";
  app.querySelector<HTMLElement>("#storage-recovery")!.hidden = !next.storageError;
  const readOnly = Boolean(version) || !next.snapshot || !next.commentReady || next.storageError;
  app.querySelector<HTMLButtonElement>("#comment-mode")!.disabled = readOnly;
  if (readOnly) {
    commentMode = false;
    preview.setCommenting(false);
  }
  app.querySelector("#comment-mode")!.setAttribute("aria-pressed", String(commentMode));
  if (activePanel === "rejections") void rejections.open();
  preview.setComments(snapshot?.comments ?? []);
  discussion.render(snapshot?.comments ?? [], readOnly);
}
let roster = "";
function renderPeople(people: Presence[]) {
  const key = JSON.stringify(people.map((person) => [person.sessionId, person.actor]));
  if (key !== roster) {
    roster = key;
    const list = app.querySelector("#people")!;
    list.replaceChildren();
    for (const person of people) {
      const item = document.createElement("span");
      item.className = "person";
      item.textContent = `${person.actor.name}${person.actor.kind === "agent" ? " · agent" : ""}${person.sessionId === editor ? " · you" : ""}`;
      list.append(item);
    }
  }
  preview.setPresence(people.filter((person) => person.sessionId !== editor));
}
function showPanel(panel: typeof activePanel) {
  activePanel = panel;
  app.querySelector<HTMLElement>("#side-panel")!.hidden = panel === null;
  app.querySelector("main")!.classList.toggle("panel-open", panel !== null);
  for (const [id, value] of [
    ["discussion", "comments"],
    ["history", "history"],
    ["html-archive", "archive"],
    ["rejections", "rejections"],
  ])
    app.querySelector<HTMLElement>(`#${id}`)!.hidden = panel !== value;
  app.querySelector<HTMLElement>("#version-diff")!.hidden = panel !== "history" || !version;
  app.querySelector("#comments-button")!.setAttribute("aria-pressed", String(panel === "comments"));
  app.querySelector<HTMLDetailsElement>("#plan-menu")!.open = false;
  if (panel === "history") void history.open();
  if (panel === "rejections") void rejections.open();
  if (panel === "archive") void openArchive();
}
function updateCommentMode() {
  preview.setCommenting(commentMode);
  render(view);
}
function download(contents: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
async function openArchive() {
  const container = app.querySelector<HTMLElement>("#html-archive")!;
  container.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = "Browser HTML archive";
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent =
    "Original browser HTML drafts and requests are read-only. Pending requests may already have reached the server; their outcome is unknown. Nothing here is retried. Export the records for deliberate recovery by an agent.";
  container.append(heading, hint);
  try {
    const archive = await sync.archive();
    if (!archive) {
      const empty = document.createElement("p");
      empty.textContent = "No archived browser HTML.";
      container.append(empty);
      return;
    }
    const counts = document.createElement("p");
    counts.textContent = `${archive.editors.length} browser drafts · ${archive.outbox.length} HTML requests`;
    const button = document.createElement("button");
    button.textContent = "Export browser HTML archive";
    button.addEventListener("click", () =>
      download(
        JSON.stringify(archive, null, 2),
        `${name}-browser-html-archive.json`,
        "application/json",
      ),
    );
    container.append(counts, button);
    for (const row of archive.editors) {
      const item = document.createElement("article");
      item.className = "comment";
      const title = document.createElement("p");
      title.textContent = `${row.draft.actor?.name ?? row.editor} · generation ${row.draft.generation}`;
      const excerpt = document.createElement("pre");
      excerpt.className = "draft-excerpt";
      excerpt.textContent = row.draft.html.slice(0, 240);
      item.append(title, excerpt);
      container.append(item);
    }
  } catch (error) {
    const notice = document.createElement("p");
    notice.setAttribute("role", "alert");
    notice.textContent = String(error);
    container.append(notice);
  }
}
identity.addEventListener("change", () => {
  const user = fakeUsers.find((candidate) => candidate.id === identity.value)!;
  sessionStorage.setItem("scope-plan-web-user", user.id);
  sync.selectActor({ ...user });
});
app.querySelector("#retry-storage")!.addEventListener("click", () => {
  void sync.retryStorage();
});
app.querySelector("#comment-mode")!.addEventListener("click", () => {
  commentMode = !commentMode;
  updateCommentMode();
});
app
  .querySelector("#comments-button")!
  .addEventListener("click", () => showPanel(activePanel === "comments" ? null : "comments"));
app.querySelector("#close-panel")!.addEventListener("click", () => showPanel(null));
app.querySelector("#history-button")!.addEventListener("click", () => showPanel("history"));
app.querySelector("#archive-button")!.addEventListener("click", () => showPanel("archive"));
app.querySelector("#comment-attention")!.addEventListener("click", () => showPanel("rejections"));
app.querySelector("#rejections-button")!.addEventListener("click", () => showPanel("rejections"));
app.querySelector("#return-live")!.addEventListener("click", () => {
  version = null;
  app.querySelector<HTMLElement>("#history-notice")!.hidden = true;
  app.querySelector<HTMLElement>("#version-diff")!.hidden = true;
  render(view);
});
app.querySelector("#export")!.addEventListener("click", () => {
  const snapshot = version ?? view.snapshot;
  if (snapshot) download(snapshot.html, `${name}.html`, "text/html");
});
app.querySelector("iframe")!.addEventListener("previewready", () => render(view));
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
});
void sync.start();
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
