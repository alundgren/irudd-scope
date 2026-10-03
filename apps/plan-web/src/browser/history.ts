import { planApi, type PlanEvent, type PlanSnapshot, type VersionPage } from "../contracts.ts";

export class History {
  private before: number | null = null;
  private list: HTMLElement;
  private more: HTMLButtonElement;
  constructor(
    private container: HTMLElement,
    private name: string,
    private selected: (snapshot: PlanSnapshot, event: PlanEvent) => void,
  ) {
    container.innerHTML = `<div class="panel-heading"><h2>Version history</h2></div><div id="version-list"></div><button id="more-versions" hidden>Earlier versions</button><p id="history-error" role="alert" hidden></p>`;
    this.list = container.querySelector("#version-list")!;
    this.more = container.querySelector("#more-versions")!;
    this.more.addEventListener("click", () => {
      void this.load();
    });
  }
  async open() {
    this.before = null;
    this.list.replaceChildren();
    await this.load();
  }
  private async load() {
    const error = this.container.querySelector<HTMLElement>("#history-error")!;
    try {
      const response = await fetch(
        `${planApi(this.name)}/versions?limit=25${this.before === null ? "" : `&before=${this.before}`}`,
      );
      if (!response.ok) throw new Error("Version history is unavailable while offline.");
      const page = (await response.json()) as VersionPage;
      for (const event of page.versions) {
        const button = document.createElement("button");
        button.className = "version";
        button.textContent = `Version ${event.revision} · ${event.kind} · ${event.actor.name}`;
        button.addEventListener("click", () => {
          this.selected(event.snapshot, event);
        });
        this.list.append(button);
      }
      this.before = page.nextBefore;
      this.more.hidden = this.before === null;
      error.hidden = true;
    } catch (reason) {
      error.textContent = reason instanceof Error ? reason.message : String(reason);
      error.hidden = false;
    }
  }
}
