import { expect, test } from "vite-plus/test";
import { rm } from "node:fs/promises";
import { desktopFixture } from "./desktop-fixture.ts";
import { snapshot } from "./harnesses-fixture.ts";
import { sessionsHome } from "./sessions-fixture.ts";

test(
  "Agent sessions shows threads, tool calls and failure causes without changing session data",
  { tags: ["sessions-look-dont-touch"], timeout: 180_000 },
  async () => {
    const fixture = await sessionsHome();
    const before = await snapshot(fixture.home, [".t3", ".claude"]);
    const { launch, stderr } = await desktopFixture({ hideInitialPrompts: true, env: fixture.env });
    const application = await launch();
    try {
      const page = await application.firstWindow();
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByLabel("Search artifacts", { exact: true }).fill("tool calls");
      await page.getByRole("button", { name: "Agent sessions", exact: true }).click();
      await page.getByRole("tab", { name: "Agent sessions", selected: true }).waitFor();
      const view = page.locator(".sessions-view");

      // Top-level threads from the last 3 days; child threads stay folded until expanded.
      const open = (title: string) => view.getByRole("button", { name: new RegExp(`^${title}`) });
      await open("Build the slice").waitFor();
      await open("Fix the site check").waitFor();
      // The most recently active thread comes first, even though the site thread started later.
      expect(await view.locator(".sessions-threads .sessions-title").allTextContents()).toEqual([
        "Build the slice",
        "Fix the site check",
      ]);
      expect(await open("Ancient thread").count()).toBe(0);
      expect(await open("Review the slice").count()).toBe(0);
      await view.getByRole("button", { name: "Expand 2 child threads of Build the slice" }).click();
      await open("Review the slice").waitFor();
      await open("Scout the map code").waitFor();

      // Search finds what a child thread was told.
      await view.getByLabel("Search threads").fill("full check");
      await view.getByRole("button", { name: "What they were told" }).click();
      await view.getByText("1 of 4 threads were told").waitFor();
      await view.getByLabel("Search threads").fill("");
      await view.getByRole("button", { name: "Titles" }).click();

      // A thread page totals its whole tree, including calls only in the subagent's log.
      await open("Build the slice").click();
      await view.getByRole("heading", { name: "Build the slice", level: 2 }).waitFor();
      const stat = (label: string) =>
        view.locator(".sessions-top .sessions-stat").filter({ hasText: label });
      expect(await stat("Tool calls").locator(".sessions-stat-value").textContent()).toBe("5");
      expect(await stat("Failed").locator(".sessions-stat-value").textContent()).toBe("2");
      await view.getByText("This thread", { exact: true }).waitFor();

      await view.getByRole("button", { name: "Program" }).click();
      await view.getByRole("row", { name: "cargo test", exact: true }).waitFor();
      await view.getByRole("row", { name: "rg", exact: true }).waitFor();
      await view.getByRole("button", { name: "Failure cause" }).click();
      const searched = view.getByRole("row", { name: "Search found nothing" });
      await view.getByRole("row", { name: "Test failed" }).waitFor();
      await searched.click();
      // The chained command's output came from an earlier step; its last step decided the exit.
      await view.getByText(/last step: rg -n 'TODO' src\/map\.rs · exit 1/).waitFor();
      await view.getByRole("button", { name: "Show this call →" }).click();
      await view.getByText("Cause: Search found nothing").waitFor();

      // The project filter limits every view to one repository.
      await view.getByRole("button", { name: "Threads", exact: true }).click();
      await view.getByRole("button", { name: /All projects · last 3 days/ }).click();
      await view.getByLabel("Project").selectOption("site");
      await view.getByRole("button", { name: /site · last 3 days/ }).click();
      await view.getByRole("button", { name: "Tool calls", exact: true }).click();
      await view.getByRole("button", { name: "Failure cause" }).click();
      await view.getByRole("row", { name: "Lint or format check failed" }).waitFor();
      expect(await view.getByRole("row", { name: "Test failed" }).count()).toBe(0);

      // Secrets in commands, output and messages never reach the page or logs.
      await view.getByRole("button", { name: "Nothing" }).click();
      await view.getByRole("button", { name: /site · last 3 days/ }).click();
      await view.getByLabel("Project").selectOption("");
      await view.getByRole("button", { name: /All projects · last 3 days/ }).click();
      await view.getByLabel("Search commands and output").fill("cargo build");
      await view.getByRole("row", { name: /^shell: export TOKEN=\[hidden\]/ }).click();
      const text = (await view.textContent())!;
      expect(text).toContain("leaked [hidden]");
      for (const marker of fixture.markers) {
        expect(text).not.toContain(marker);
        expect(stderr()).not.toContain(marker);
      }
    } finally {
      await application.close();
    }
    expect(await snapshot(fixture.home, [".t3", ".claude"])).toEqual(before);
    await rm(fixture.root, { recursive: true, force: true });
  },
);
