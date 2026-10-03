import type { Draft } from "./storage.ts";

export class SavedDrafts {
  constructor(
    private container: HTMLElement,
    private read: () => Promise<{ editor: string; draft: Draft }[]>,
    private recover: (editor: string) => Promise<void>,
    private ownEditor: string,
    private busy: () => boolean,
  ) {}

  async open() {
    this.container.replaceChildren();
    const heading = document.createElement("h2");
    heading.textContent = "Saved browser drafts";
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent =
      "Drafts belong to this browser. Browser storage can be cleared or evicted. Export HTML you need to keep.";
    this.container.append(heading, hint);
    try {
      const rows = await this.read();
      if (!rows.length) {
        const empty = document.createElement("p");
        empty.className = "hint";
        empty.textContent = "No unfinished drafts.";
        this.container.append(empty);
      }
      for (const row of rows) {
        const article = document.createElement("article");
        article.className = "comment";
        const label = document.createElement("p");
        label.textContent = `${row.draft.actor?.name ?? `Editor ${row.editor.slice(0, 4)}`}${row.editor === this.ownEditor ? " · this tab" : ""} · ${row.draft.generation === row.draft.rejectedGeneration ? "Rejected · edit before retrying" : row.draft.conflict ? "Conflict" : "Waiting for server"}`;
        const text = document.createElement("pre");
        text.className = "draft-excerpt";
        text.textContent = row.draft.html.slice(0, 240);
        const actions = document.createElement("div");
        actions.className = "actions";
        const restore = document.createElement("button");
        restore.textContent = "Restore draft";
        restore.className = "restore-draft";
        restore.disabled = this.busy();
        restore.addEventListener("click", () => {
          restore.disabled = true;
          void this.recover(row.editor).finally(() => {
            restore.disabled = this.busy();
          });
        });
        const download = document.createElement("button");
        download.textContent = "Export draft";
        download.addEventListener("click", () => {
          const url = URL.createObjectURL(new Blob([row.draft.html], { type: "text/html" }));
          const link = document.createElement("a");
          link.href = url;
          link.download = "plan-draft.html";
          link.click();
          URL.revokeObjectURL(url);
        });
        actions.append(restore, download);
        article.append(label, text, actions);
        this.container.append(article);
      }
    } catch (error) {
      const message = document.createElement("p");
      message.setAttribute("role", "alert");
      message.textContent = error instanceof Error ? error.message : String(error);
      this.container.append(message);
    }
  }
}
