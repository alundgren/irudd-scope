import type { Actor, PlanCommand } from "../contracts.ts";
import type { Pending } from "./local-database.ts";
import { createId } from "./identity.ts";

export class RejectedChanges {
  private articles = new Map<string, HTMLElement>();
  private initialized = false;
  constructor(
    private container: HTMLElement,
    private read: () => Promise<Pending[]>,
    private actor: () => Actor,
    private dismiss: (requestId: string, replacement?: PlanCommand) => Promise<void>,
  ) {}

  async open() {
    if (!this.initialized) {
      this.initialized = true;
      const heading = document.createElement("h2");
      heading.textContent = "Rejected comments";
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent =
        "These comments remain in this browser. Edit rejected content before retrying.";
      const empty = document.createElement("p");
      empty.className = "rejections-empty";
      empty.textContent = "No rejected changes.";
      this.container.append(heading, hint, empty);
    }
    try {
      const rows = await this.read();
      this.container.querySelector<HTMLElement>(".rejections-empty")!.hidden = rows.length !== 0;
      for (const [id, article] of this.articles) {
        if (!rows.some((row) => row.requestId === id)) {
          article.remove();
          this.articles.delete(id);
        }
      }
      for (const row of rows) if (!this.articles.has(row.requestId)) this.add(row);
    } catch (error) {
      this.error(error);
    }
  }

  private error(error: unknown) {
    const message = document.createElement("p");
    message.setAttribute("role", "alert");
    message.textContent = error instanceof Error ? error.message : String(error);
    this.container.append(message);
  }

  private add(row: Pending) {
    const article = document.createElement("article");
    article.className = "comment";
    const reason = document.createElement("p");
    reason.textContent = `${row.command.actor.name} · ${row.command.kind} · HTTP ${row.rejection?.status}: ${row.rejection?.message}`;
    const actions = document.createElement("div");
    actions.className = "actions";
    const run = (button: HTMLButtonElement, work: () => Promise<void>) => {
      button.disabled = true;
      void work()
        .then(() => this.open())
        .catch((error: unknown) => this.error(error))
        .finally(() => {
          button.disabled = false;
        });
    };
    if (row.command.kind === "html") return;
    {
      const input = document.createElement("textarea");
      input.setAttribute("aria-label", "Rejected comment text");
      input.value = "text" in row.command ? row.command.text : "";
      input.hidden = row.command.kind === "comment.resolve";
      const retry = document.createElement("button");
      retry.textContent = "Retry edited comment";
      let replacement: PlanCommand | undefined;
      // Retain the replacement ID/body until its local transaction is confirmed.
      retry.addEventListener("click", () => {
        replacement ??= {
          ...row.command,
          requestId: createId(),
          actor: this.actor(),
          ...("text" in row.command ? { text: input.value } : {}),
        };
        input.readOnly = true;
        run(retry, () => this.dismiss(row.requestId, replacement));
      });
      actions.append(retry);
      article.append(input);
    }
    const exportButton = document.createElement("button");
    exportButton.textContent = "Export rejected change";
    exportButton.addEventListener("click", () => {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(row.command, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "rejected-plan-change.json";
      link.click();
      URL.revokeObjectURL(url);
    });
    const dismiss = document.createElement("button");
    dismiss.textContent = "Dismiss rejected change";
    dismiss.addEventListener("click", () => run(dismiss, () => this.dismiss(row.requestId)));
    actions.append(exportButton, dismiss);
    article.append(reason, actions);
    this.articles.set(row.requestId, article);
    this.container.append(article);
  }
}
