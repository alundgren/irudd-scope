import type { Actor, CommentAnchor, PlanCommand, PlanComment } from "../contracts.ts";

export class Discussion {
  private anchor: CommentAnchor | null = null;
  private previous = "";
  private submitting = false;
  private composerGeneration = 0;
  private composerCommand: { command: PlanCommand; generation: number } | null = null;
  private replies = new Map<
    string,
    {
      text: string;
      generation: number;
      pending: boolean;
      command: PlanCommand | null;
      submittedGeneration: number;
    }
  >();
  private comments: PlanComment[] = [];
  private readOnly = false;
  private readonly list: HTMLElement;
  private readonly composer: HTMLFormElement;
  private readonly text: HTMLTextAreaElement;
  private readonly location: HTMLElement;

  constructor(
    private container: HTMLElement,
    private actor: () => Actor,
    private send: (command: PlanCommand) => Promise<void>,
    private connected: (anchor: CommentAnchor) => boolean,
  ) {
    container.innerHTML = `<div class="panel-heading"><h2>Comments</h2><span id="comment-count"></span></div>
      <p class="hint">Choose Comment on preview, then click anywhere in the plan.</p>
      <form id="comment-composer" hidden><p id="comment-location"></p><label for="comment-text">Comment text</label><textarea id="comment-text" rows="3" required></textarea><div class="actions"><button class="primary" type="submit">Add comment</button><button id="cancel-comment" type="button">Cancel</button></div></form>
      <div id="comment-list"></div>`;
    this.list = container.querySelector("#comment-list")!;
    this.composer = container.querySelector("#comment-composer")!;
    this.text = container.querySelector("#comment-text")!;
    this.location = container.querySelector("#comment-location")!;
    this.text.addEventListener("input", () => {
      this.composerGeneration++;
    });
    container.querySelector("#cancel-comment")!.addEventListener("click", () => {
      this.composer.hidden = true;
    });
    this.composer.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.submitting || !this.anchor || !this.text.value.trim()) return;
      this.composerCommand ??= {
        generation: this.composerGeneration,
        command: {
          kind: "comment.add",
          requestId: crypto.randomUUID(),
          actor: this.actor(),
          anchor: this.anchor,
          text: this.text.value,
        },
      };
      const submitted = this.composerCommand;
      const submit = this.composer.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      this.submitting = true;
      submit.disabled = true;
      void this.send(submitted.command)
        .then(() => {
          this.composerCommand = null;
          if (this.composerGeneration === submitted.generation) {
            this.text.value = "";
            this.composer.hidden = true;
          }
        })
        .catch(() => {
          this.text.focus();
        })
        .finally(() => {
          this.submitting = false;
          submit.disabled = false;
        });
    });
  }

  select(anchor: CommentAnchor) {
    this.composerGeneration++;
    this.anchor = anchor;
    this.location.textContent = anchor.elementId
      ? `On ${anchor.elementId}`
      : "Detached from an element";
    this.composer.hidden = false;
    this.text.focus();
  }

  render(comments: PlanComment[], readOnly: boolean) {
    this.comments = comments;
    this.readOnly = readOnly;
    this.composer
      .querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>(
        "input,button,textarea",
      )
      .forEach((input) => {
        input.disabled = readOnly || this.submitting;
      });
    const key =
      JSON.stringify(comments) +
      readOnly +
      comments.map((comment) => this.connected(comment.anchor));
    if (key === this.previous) return;
    this.previous = key;
    const focused = document.activeElement as HTMLTextAreaElement | null;
    const focusId = focused?.dataset.comment;
    const selection = focused?.selectionStart;
    this.list.replaceChildren();
    this.container.querySelector("#comment-count")!.textContent = String(comments.length);
    if (!comments.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "No comments yet.";
      this.list.append(empty);
    }
    for (const comment of comments) {
      const article = document.createElement("article");
      article.className = "comment";
      article.dataset.commentId = comment.id;
      const heading = document.createElement("div");
      heading.className = "comment-meta";
      const connected = this.connected(comment.anchor);
      heading.textContent = `${comment.actor.name}${comment.actor.kind === "agent" ? " · agent" : ""} · ${comment.resolved ? "Resolved" : "Open"} · ${connected ? "Connected" : "Detached"}`;
      const quote = document.createElement("blockquote");
      quote.textContent = comment.anchor.quote || "Document position";
      const text = document.createElement("p");
      text.textContent = comment.text;
      article.append(heading, quote, text);
      for (const reply of comment.replies) {
        const item = document.createElement("p");
        item.className = "reply";
        const name = document.createElement("strong");
        name.textContent = `${reply.actor.name} `;
        item.append(name, document.createTextNode(reply.text));
        article.append(item);
      }
      const form = document.createElement("form");
      const reply = document.createElement("textarea");
      reply.rows = 2;
      reply.setAttribute("aria-label", "Reply text");
      reply.dataset.comment = comment.id;
      const draft = this.replies.get(comment.id) ?? {
        text: "",
        generation: 0,
        pending: false,
        command: null,
        submittedGeneration: 0,
      };
      this.replies.set(comment.id, draft);
      reply.value = draft.text;
      reply.addEventListener("input", () => {
        draft.text = reply.value;
        draft.generation++;
      });
      reply.disabled = readOnly;
      const actions = document.createElement("div");
      actions.className = "actions";
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.textContent = "Reply";
      submit.disabled = readOnly || draft.pending;
      const resolve = document.createElement("button");
      resolve.type = "button";
      resolve.textContent = comment.resolved ? "Reopen" : "Resolve";
      resolve.disabled = readOnly;
      actions.append(submit, resolve);
      form.append(reply, actions);
      article.append(form);
      this.list.append(article);
      resolve.addEventListener("click", () => {
        void this.send({
          kind: "comment.resolve",
          requestId: crypto.randomUUID(),
          actor: this.actor(),
          commentId: comment.id,
          resolved: !comment.resolved,
        }).catch(() => {});
      });
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (draft.pending || !draft.text.trim()) return;
        if (!draft.command) {
          draft.command = {
            kind: "comment.reply",
            requestId: crypto.randomUUID(),
            actor: this.actor(),
            commentId: comment.id,
            text: draft.text,
          };
          draft.submittedGeneration = draft.generation;
        }
        const command = draft.command;
        const generation = draft.submittedGeneration;
        draft.pending = true;
        this.redraw();
        void this.send(command)
          .then(() => {
            if (draft.generation === generation) draft.text = "";
            draft.command = null;
          })
          .catch(() => {})
          .finally(() => {
            draft.pending = false;
            this.redraw();
          });
      });
      if (focusId === comment.id) {
        reply.focus();
        reply.setSelectionRange(selection ?? 0, selection ?? 0);
      }
    }
  }
  private redraw() {
    this.previous = "";
    this.render(this.comments, this.readOnly);
  }
}
