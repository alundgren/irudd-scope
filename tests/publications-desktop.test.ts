import { expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";

test("publishing preserves HTML, requires visible overwrite acknowledgement, and unlinks without deleting the artifact", async () => {
  const { directory, launch, connect, cli } = await desktopFixture();
  const application = await launch();
  try {
    const page = await application.firstWindow();
    const client = await connect();
    const title =
      "Quarterly presentation with a long title describing the decisions and follow-up work for the whole team";
    const file = join(directory, "presentation.html");
    await writeFile(
      file,
      '<!doctype html><h1>Presentation</h1><input aria-label="Slide note"><script>document.querySelector("input").value = "Keep this note"</script>',
    );
    await cli("add", file, "--id", "desktop-presentation", "--title", title);
    const pane = page.getByRole("tabpanel", { name: title });
    const frame = pane.frameLocator("iframe");
    await frame.getByRole("heading", { name: "Presentation", exact: true }).waitFor();
    await frame.getByLabel("Slide note").fill("Edited while inspecting");
    const open = async () => {
      await page.getByRole("button", { name: "Search and controls" }).click();
      await page.getByRole("button", { name: "Publish with coding agent", exact: true }).click();
      await page.getByRole("dialog", { name: "Publish with coding agent", exact: true }).waitFor();
    };
    await page.setViewportSize({ width: 1280, height: 820 });
    await open();
    const dialog = page.getByRole("dialog", { name: "Publish with coding agent", exact: true });
    await dialog.getByText("No successful publication recorded.").waitFor();
    await dialog.getByRole("button", { name: "Copy request", exact: true }).click();
    await dialog.getByText("Paste into your coding session.").waitFor();
    expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toContain(
      'Publish Scope artifact "desktop-presentation"',
    );
    const screenshots = process.env.SCOPE_TEST_SCREENSHOTS;
    if (screenshots) {
      await mkdir(screenshots, { recursive: true });
      await page.screenshot({ path: join(screenshots, "publishing-light-empty.png") });
    }
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    expect(await frame.getByLabel("Slide note").inputValue()).toBe("Edited while inspecting");
    await page.keyboard.press("ControlOrMeta+,");
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.getByLabel("Appearance", { exact: true }).selectOption("dark");
    await page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 480, height: 560 });
    const { snapshot } = await client.publications({ action: "read", id: "desktop-presentation" });
    const op = {
      id: snapshot.artifact.id,
      tabId: snapshot.tabId,
      provider: "claude" as const,
      operationId: randomUUID(),
    };
    const observation = {
      accountId: "synthetic-desktop-account",
      workspaceId: null,
      remoteId: "desktop-remote",
      url: "https://claude.ai/code/artifact/desktop-remote",
      access: "owner" as const,
      audience: "owner" as const,
      evidence: "authenticated-share-inspection" as const,
      checkedAt: new Date().toISOString(),
      marker: { version: "1", updatedAt: null },
      conditionalWrite: true,
    };
    const prepared = await client.publications({
      ...op,
      action: "prepare",
      expectedRevision: 1,
      observation,
    });
    expect(prepared.decision).toBe("warning");
    await open();
    await dialog.getByText("Publishing may overwrite remote edits.").waitFor();
    expect(
      await dialog.getByRole("link", { name: "Open Claude artifact" }).getAttribute("href"),
    ).toBe(observation.url);
    expect(
      await dialog.getByRole("button", { name: "Copy request", exact: true }).isDisabled(),
    ).toBe(true);
    const bounds = await dialog.boundingBox();
    expect(bounds!.width).toBeLessThanOrEqual(448);
    expect(bounds!.height).toBeLessThanOrEqual(528);
    if (screenshots)
      await page.screenshot({ path: join(screenshots, "publishing-dark-warning.png") });
    const blocked = await client.publications({
      ...op,
      action: "refresh",
      observation: { ...observation, audience: "public", checkedAt: new Date().toISOString() },
    });
    expect(blocked.decision).toBe("blocked");
    await dialog.getByText("Cannot publish to this destination.").waitFor();
    expect(
      await dialog.getByRole("button", { name: "Allow replacement", exact: true }).count(),
    ).toBe(0);
    if (screenshots)
      await page.screenshot({ path: join(screenshots, "publishing-dark-blocked.png") });
    await client.publications({
      ...op,
      action: "refresh",
      observation: { ...observation, checkedAt: new Date().toISOString() },
    });
    await dialog.getByText("Publishing may overwrite remote edits.").waitFor();
    await dialog.getByRole("button", { name: "Allow replacement", exact: true }).click();
    await dialog.getByText("Revision 1 is prepared. Copy the request to continue.").waitFor();
    expect(
      (await client.publications({ action: "read", id: op.id })).snapshot.destinations[0].operation!
        .state,
    ).toBe("prepared");
    await client.publications({
      ...op,
      action: "refresh",
      observation: { ...observation, checkedAt: new Date().toISOString() },
    });
    await client.publications({ ...op, action: "start" });
    await dialog
      .getByText(
        "Publication started. Ask your agent to check the provider result before retrying.",
      )
      .waitFor();
    await dialog.getByRole("button", { name: "Cancel preparation", exact: true }).click();
    await dialog
      .getByText(
        "Cancel Scope's recovery record? The provider may already have published. Ask your agent to reconcile the result first.",
      )
      .waitFor();
    await dialog.getByRole("button", { name: "Keep record", exact: true }).click();
    await client.publications({
      ...op,
      action: "complete",
      result: {
        provider: "claude",
        remoteId: observation.remoteId,
        url: observation.url,
        savedVersion: null,
        sourceCommit: null,
        deploymentId: null,
        marker: { version: "2", updatedAt: null },
        confirmedAt: new Date().toISOString(),
        state: "succeeded",
      },
    });
    await dialog.getByText("Revision 1 published.").waitFor();
    expect(
      await dialog.getByRole("link", { name: "Open Claude artifact" }).getAttribute("href"),
    ).toBe(observation.url);
    await writeFile(file, "<h1>New presentation</h1>");
    await cli("update", op.id, file);
    await dialog.getByText("Revision 1 published. Revision 2 has unpublished changes.").waitFor();
    await dialog.getByRole("button", { name: "Unlink", exact: true }).click();
    await dialog
      .getByText("Remove Scope's saved link and checkpoint? The remote artifact stays intact.")
      .waitFor();
    await dialog.getByRole("button", { name: "Remove saved link", exact: true }).click();
    await dialog.getByText("No successful publication recorded.").waitFor();
    expect(await dialog.getByRole("link", { name: "Open Claude artifact" }).count()).toBe(0);
    expect((await client.get(op.id)).revision).toBe(2);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    expect(
      await page
        .getByRole("button", { name: "Search and controls" })
        .evaluate((element) => element === document.activeElement),
    ).toBe(true);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
