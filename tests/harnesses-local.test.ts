import { expect, test } from "vite-plus/test";
import type { Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeLocalConnection } from "@irudd-scope/protocol";
import {
  HarnessesGuide,
  type HarnessFileReply,
  type HarnessReport,
  type HarnessesReply,
} from "@irudd-scope/protocol/harnesses";
import { desktopFixture } from "./desktop-fixture.ts";
import {
  expected,
  folderSize,
  harness,
  harnessHome,
  instruction,
  instructions,
  notFound,
  snapshot,
  withoutSize,
} from "./harnesses-fixture.ts";

/** Reads until every found harness has its final size; the test timeout bounds the wait. */
async function readUntilSized(cli: (...args: string[]) => Promise<{ stdout: string }>) {
  for (;;) {
    const reply = JSON.parse(
      (await cli("harnesses", "read", "--machine", "local")).stdout,
    ) as HarnessesReply;
    const sizes = reply.machines[0]!.harnesses.filter((report) => report.found);
    if (sizes.every((report) => report.size?.state === "done")) return reply;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function openHarnessesTab(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByLabel("Search artifacts", { exact: true }).fill("harnesses");
  await page.getByRole("button", { name: "Harnesses", exact: true }).click();
  await page.getByRole("tab", { name: "Harnesses", selected: true }).waitFor();
  // Closing search returns focus to its button.
  await page.getByRole("dialog").waitFor({ state: "detached" });
}

const scanTime = (page: Page) => page.locator(".harnesses-matrix time").getAttribute("dateTime");

async function expectReport(
  reply: HarnessesReply,
  home: string,
  found: Array<Omit<HarnessReport, "size">>,
  missing: HarnessReport[],
  linkedShared = false,
) {
  const machine = reply.machines[0]!;
  expect(reply.machines).toHaveLength(1);
  expect(machine.machine).toBe("local");
  expect(Date.parse(machine.scannedAt)).not.toBeNaN();
  expect(machine.sharedSkills).toEqual(expected.sharedSkills(linkedShared));
  expect(machine.harnesses.map((report) => report.id).sort()).toEqual(
    ["claude-code", "codex", "cursor", "grok"].sort(),
  );
  for (const report of found)
    expect(harness(reply, report.id)).toEqual({
      ...report,
      size: await folderSize(join(home, report.home.slice(2))),
    });
  for (const report of missing) expect(harness(reply, report.id)).toEqual(report);
}

test(
  "harnesses read reports each harness on this computer from its own folders",
  { tags: ["harnesses-look-dont-touch"], timeout: 120_000 },
  async () => {
    const fixture = await harnessHome({ cursor: false, brokenClaudeJson: true });
    const { launch, cli, stderr } = await desktopFixture({
      hideInitialPrompts: true,
      env: fixture.env,
    });
    const application = await launch();
    const seen: string[] = [];
    try {
      const guide = JSON.parse((await cli("harnesses", "guide")).stdout) as typeof HarnessesGuide;
      expect(Object.keys(guide.commands).sort()).toEqual(["file", "guide", "read", "scan"]);
      expect(guide.file).toContain("shared for ~/.agents/skills");
      expect(Object.keys(guide.fields)).toEqual(
        expect.arrayContaining([
          "found",
          "version",
          "signIn",
          "size",
          "skills",
          "agents",
          "mcpServers",
          "instructions",
          "sharedSkills",
        ]),
      );
      expect(guide.fields.version).toContain("last resort");
      expect(guide.folders.shared).toContain("~/.agents/skills");
      expect(guide.rules.join(" ")).toContain("makes no claim");

      const output = (await cli("harnesses", "scan")).stdout;
      seen.push(output);
      const scanned = JSON.parse(output) as HarnessesReply;
      expect(withoutSize(harness(scanned, "codex"))).toEqual({
        ...expected.codex(),
        size: undefined,
      });
      const reply = await readUntilSized(cli);
      seen.push(JSON.stringify(reply));
      // An invalid ~/.claude.json is reported as unreadable and its sign-in as unknown.
      await expectReport(
        reply,
        fixture.home,
        [expected.codex(), expected.claude(null, true), expected.grok("1.2.3")],
        [notFound("cursor", "Cursor", "~/.cursor")],
      );

      await expect(cli("harnesses", "read", "--machine", "all")).rejects.toMatchObject({
        stderr: expect.stringContaining("Unknown machine all. Use --machine local."),
      });

      // harnesses file returns instruction files and own SKILL.md files the latest scan lists.
      const file = async (...args: string[]) => {
        const { stdout } = await cli("harnesses", "file", ...args);
        seen.push(stdout);
        return JSON.parse(stdout) as HarnessFileReply;
      };
      const { linked: _linked, ...agents } = instruction("~/.codex/AGENTS.md", instructions.codex);
      expect(await file("--machine", "local", "codex", "AGENTS.md")).toEqual({
        harness: "codex",
        ...agents,
        text: instructions.codex,
      });
      expect((await file("claude-code", "skills/notes/SKILL.md")).text).toBe("# Notes\n");
      expect(await file("shared", "shared-one/SKILL.md")).toMatchObject({
        path: "~/.agents/skills/shared-one/SKILL.md",
        text: "# Shared\n",
      });

      // Everything else is refused with a reason; a large or non-UTF-8 SKILL.md is never returned.
      const unreturned = [`large-${randomUUID()}`, `latin-${randomUUID()}`];
      fixture.markers.push(...unreturned);
      const skills = join(fixture.home, ".codex", "skills");
      await mkdir(join(skills, "large"));
      await writeFile(
        join(skills, "large", "SKILL.md"),
        `${unreturned[0]}\n${"x".repeat(256 * 1024)}`,
      );
      await mkdir(join(skills, "latin"));
      await writeFile(
        join(skills, "latin", "SKILL.md"),
        Buffer.concat([Buffer.from(`${unreturned[1]}\n`), Buffer.from([0xe9, 0xff])]),
      );
      // A SKILL.md that is another name for auth.json.
      await mkdir(join(skills, "hard"));
      await link(join(fixture.home, ".codex", "auth.json"), join(skills, "hard", "SKILL.md"));
      seen.push((await cli("harnesses", "scan")).stdout);
      // After the scan, a listed skill folder becomes a link and another becomes a file; the
      // reader checks the disk itself.
      await rename(join(skills, "review"), join(fixture.root, "review"));
      await symlink(join(fixture.outside, "linked-skill"), join(skills, "review"));
      await rm(join(fixture.home, ".grok", "skills", "own-skill"), { recursive: true });
      await writeFile(join(fixture.home, ".grok", "skills", "own-skill"), "not a folder\n");
      const notRead = "Only global instruction files and own skills' SKILL.md files";
      for (const [reason, ...args] of [
        [notRead, "codex", "auth.json"],
        [notRead, "codex", "config.toml"],
        [notRead, "codex", "sessions/2026/10/rollout.jsonl"],
        [notRead, "codex", "skills/.system/imagegen/SKILL.md"],
        [notRead, "grok", "auth.json"],
        ["Paths with .. are not allowed", "claude-code", "../.claude.json"],
        ["Absolute paths are not allowed", "claude-code", join(fixture.home, ".claude/CLAUDE.md")],
        ["is linked. Scope does not follow links", "claude-code", "skills/outside/SKILL.md"],
        ["is linked. Scope does not follow links", "shared", "linked-shared/SKILL.md"],
        ["larger than 256 KiB", "codex", "skills/large/SKILL.md"],
        ["not UTF-8 text", "codex", "skills/latin/SKILL.md"],
        ["Scope does not read hard-linked files", "codex", "skills/hard/SKILL.md"],
        [
          "A folder on the way to ~/.codex/skills/review/SKILL.md is linked",
          "codex",
          "skills/review/SKILL.md",
        ],
        ["is no longer a folder", "grok", "skills/own-skill/SKILL.md"],
        ["Unknown harness hub", "hub", "AGENTS.md"],
      ] as const) {
        const error = await cli("harnesses", "file", ...args).then(
          () => {
            throw new Error(`harnesses file ${args.join(" ")} was not refused.`);
          },
          (failure: { stdout: string; stderr: string }) => failure,
        );
        seen.push(error.stdout, error.stderr);
        expect(error.stderr).toContain(reason);
      }
    } finally {
      await application.close();
    }
    try {
      const searched = [...seen, stderr()].join("\n");
      for (const marker of fixture.markers) expect(searched).not.toContain(marker);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "harness scans change no file and reveal no secret in output, HTTP, storage or logs",
  {
    tags: ["harnesses-look-dont-touch", "secrets-stay-secret", "survives-restart"],
    timeout: 180_000,
  },
  async () => {
    const fixture = await harnessHome({ cursor: true, grokStub: true, linkedFolders: true });
    const { launch, cli, connectionFile, settingsDirectory, stderr } = await desktopFixture({
      hideInitialPrompts: true,
      env: fixture.env,
    });
    const before = await snapshot(fixture.home);
    const outside = await snapshot(fixture.root, ["outside"]);
    const seen: string[] = [];
    let application = await launch();
    try {
      seen.push((await cli("harnesses", "scan", "--machine", "local")).stdout);
      const reply = await readUntilSized(cli);
      seen.push(JSON.stringify(reply));
      await expectReport(
        reply,
        fixture.home,
        [
          expected.codex(true),
          expected.claude("2.2.0"),
          expected.grok("1.3.0", true),
          expected.cursor(),
        ],
        [],
        true,
      );
      // The linked skill's folder outside home holds a 777 KB file that no total includes.
      expect(harness(reply, "claude-code").size).toEqual(
        await folderSize(join(fixture.home, ".claude")),
      );

      const { endpoint, token } = decodeLocalConnection(
        JSON.parse(await readFile(connectionFile, "utf8")),
      );
      const headers = { Authorization: `Bearer ${token}` };
      for (const response of [
        await fetch(`${endpoint}/v1/harnesses?machine=local`, { headers }),
        await fetch(`${endpoint}/v1/harnesses/scan`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ machine: "local" }),
        }),
      ]) {
        expect(response.status).toBe(200);
        seen.push(await response.text());
      }
      // The file route returns allowed text and refuses a linked instruction file.
      const fileUrl = (harness: string, path: string) =>
        `${endpoint}/v1/harnesses/file?${new URLSearchParams({ machine: "local", harness, path }).toString()}`;
      const claudeMd = await fetch(fileUrl("claude-code", "CLAUDE.md"), { headers });
      expect(claudeMd.status).toBe(200);
      expect(((await claudeMd.json()) as HarnessFileReply).text).toBe(instructions.claude);
      const override = await fetch(fileUrl("codex", "AGENTS.override.md"), { headers });
      expect(override.status).toBe(403);
      seen.push(await override.text());
      const before = (await readUntilSized(cli)).machines[0]!.scannedAt;
      await application.close();

      // The saved scan answers after a restart, before or while the new scan runs.
      application = await launch();
      const page = await application.firstWindow();
      await openHarnessesTab(page);
      await page.getByRole("row", { name: /^Cursor 1 skill$/ }).waitFor();
      expect(Date.parse((await scanTime(page))!)).toBeGreaterThanOrEqual(Date.parse(before));
      const saved = JSON.parse(
        (await cli("harnesses", "read", "--machine", "local")).stdout,
      ) as HarnessesReply;
      seen.push(JSON.stringify(saved));
      expect(withoutSize(harness(saved, "cursor"))).toEqual({
        ...expected.cursor(),
        size: undefined,
      });
      await readUntilSized(cli);
    } finally {
      await application.close();
    }
    try {
      const database = join(settingsDirectory, "desktop.db");
      const stored = [
        await readFile(database, "latin1"),
        await readFile(`${database}-wal`, "latin1").catch(() => ""),
      ];
      expect(stored[0]).toContain("harness_scans");
      const output = [...seen, ...stored, stderr()].join("\n");
      for (const marker of fixture.markers) expect(output).not.toContain(marker);
      expect(await snapshot(fixture.home)).toEqual(before);
      expect(await snapshot(fixture.root, ["outside"])).toEqual(outside);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "a harness scan answers before a big folder finishes counting",
  { tags: ["harnesses-look-dont-touch"], timeout: 240_000 },
  async () => {
    const fixture = await harnessHome({ cursor: false });
    const sessions = join(fixture.home, ".codex", "sessions", "bulk");
    for (let folder = 0; folder < 50; folder += 1) {
      const path = join(sessions, String(folder));
      await mkdir(path, { recursive: true });
      await Promise.all(
        Array.from({ length: 1000 }, (_, index) =>
          writeFile(join(path, `${index}.jsonl`), "x".repeat(1 + (index % 3))),
        ),
      );
    }
    const size = await folderSize(join(fixture.home, ".codex"));
    expect(size.files).toBeGreaterThan(50_000);
    const { launch, cli } = await desktopFixture({ hideInitialPrompts: true, env: fixture.env });
    const application = await launch();
    try {
      const scanned = JSON.parse((await cli("harnesses", "scan")).stdout) as HarnessesReply;
      const first = JSON.parse(
        (await cli("harnesses", "read", "--machine", "local")).stdout,
      ) as HarnessesReply;
      // A scan answers before counting; the first read may already have the final size.
      expect(harness(scanned, "codex").size).toEqual({ state: "pending" });
      for (const reply of [scanned, first])
        expect(withoutSize(harness(reply, "codex"))).toEqual({
          ...expected.codex(),
          size: undefined,
        });
      expect([{ state: "pending" }, size]).toContainEqual(harness(first, "codex").size);
      expect(harness(await readUntilSized(cli), "codex").size).toEqual(size);
    } finally {
      await application.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

const LONG_SKILL = `a-skill-with-a-very-long-name-that-${"keeps-going-".repeat(6)}end`;

/** Saves the tab in both appearances and widths when SCOPE_TEST_SCREENSHOTS names a folder. */
async function saveScreenshots(page: Page, name: string) {
  const folder = process.env.SCOPE_TEST_SCREENSHOTS;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  for (const appearance of ["light", "dark"] as const) {
    await page.keyboard.press("ControlOrMeta+,");
    await settings.getByLabel("Search settings").fill("color scheme");
    await settings.getByLabel("Appearance", { exact: true }).selectOption(appearance);
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(appearance);
    await page.keyboard.press("Escape");
    await settings.waitFor({ state: "detached" });
    for (const [width, size] of [
      [1366, "laptop"],
      [600, "narrow"],
    ] as const) {
      await page.setViewportSize({ width, height: 860 });
      await page.screenshot({ path: join(folder, `harnesses-${name}-${appearance}-${size}.png`) });
    }
  }
}

test(
  "the Harnesses tab shows this computer's skills and instruction files and copies them",
  { tags: ["harnesses-look-dont-touch"], timeout: 180_000 },
  async () => {
    const fixture = await harnessHome({ cursor: true, brokenClaudeJson: true });
    await mkdir(join(fixture.home, ".codex", "skills", LONG_SKILL));
    await writeFile(join(fixture.home, ".codex", "skills", LONG_SKILL, "SKILL.md"), "# Long\n");
    // Without a cursor-agent link, as Cursor's Windows installer leaves it, the newest version
    // folder names the version; the installer's update folders are not versions.
    const versions = join(fixture.home, ".local", "share", "cursor-agent", "versions");
    await rm(join(fixture.home, ".local", "bin", "cursor-agent"));
    for (const folder of ["2026.10.01-0000000", "2026.12.01-fffffff.new", "pending-launchers"])
      await mkdir(join(versions, folder));
    const { launch, cli } = await desktopFixture({ hideInitialPrompts: true, env: fixture.env });
    const application = await launch();
    try {
      const page = await application.firstWindow();
      // Harnesses is not created at startup; search opens it once.
      expect(await page.getByRole("tab", { name: "Harnesses" }).count()).toBe(0);
      await openHarnessesTab(page);
      await page.getByRole("img", { name: "Built-in tab: Harnesses", exact: true }).waitFor();

      const row = (name: string) =>
        page.getByRole("row").filter({ has: page.getByRole("rowheader", { name, exact: true }) });
      const count = (name: string) => row(name).getByRole("button");
      await count("Codex + Shared skills").waitFor();
      for (const [name, skills] of [
        ["Claude Code", "2 skills"],
        ["Codex + Shared skills", "2 skills"],
        ["Cursor", "1 skill"],
        ["Grok Build", "1 skill"],
        ["Shared skills", "2 skills"],
      ])
        expect(await count(name).textContent()).toBe(skills);

      // Instruction files show a fingerprint with size and lines; Cursor has none.
      const fingerprint = createHash("sha256").update(instructions.codex).digest("hex");
      const agents = row("Codex ~/.codex/AGENTS.md");
      expect(await agents.getByRole("button").textContent()).toContain(fingerprint.slice(0, 8));
      expect(await agents.textContent()).toContain(`${instructions.codex.length} bytes · 4 lines`);
      await row("Claude Code ~/.claude/CLAUDE.md").waitFor();
      await row("Grok Build ~/.grok/AGENTS.md").waitFor();
      await page.getByText("Cursor has no instruction files.").waitFor();
      await page.getByText("Shared skills · ~/.agents/skills").waitFor();
      // Versions, sign-in, sizes, MCP servers and agents stay in the CLI and JSON only.
      const text = (await page.locator(".harnesses-view").textContent())!;
      for (const dropped of ["Signed in", "Sign-in", "MCP", "0.200.0", "helper", "counting", "MB"])
        expect(text).not.toContain(dropped);

      // Enter and Space open and close the skill names below the row; focus stays on the count.
      const codex = page.getByRole("region", { name: "Codex skills on This computer" });
      await count("Codex + Shared skills").focus();
      await page.keyboard.press("Enter");
      await codex.waitFor();
      expect(await count("Codex + Shared skills").getAttribute("aria-expanded")).toBe("true");
      expect(
        await count("Codex + Shared skills").evaluate(
          (button) => button === document.activeElement,
        ),
      ).toBe(true);
      await codex.getByText("~/.codex/skills", { exact: true }).waitFor();
      for (const name of ["review", LONG_SKILL])
        await codex.getByText(name, { exact: true }).waitFor();
      // Bundled skills are not the person's own.
      expect(await codex.getByText("imagegen").count()).toBe(0);
      await page.keyboard.press("Space");
      await codex.waitFor({ state: "detached" });
      expect(await count("Codex + Shared skills").getAttribute("aria-expanded")).toBe("false");

      // A linked skill carries one link mark after its name; the key names it once.
      await count("Claude Code").click();
      const claude = page.getByRole("region", { name: "Claude Code skills on This computer" });
      await claude.getByText("notes", { exact: true }).waitFor();
      await claude
        .getByText("outside", { exact: true })
        .locator("..")
        .getByRole("img", { name: "linked" })
        .waitFor();
      expect(await claude.getByRole("img", { name: "linked" }).count()).toBe(1);
      await claude.getByText("↪ Linked", { exact: true }).waitFor();
      await claude.getByRole("button", { name: "Copy as JSON" }).click();
      await page.getByText("Copied Claude Code as JSON.").waitFor();
      const latest = JSON.parse(
        (await cli("harnesses", "read", "--machine", "local")).stdout,
      ) as HarnessesReply;
      expect(
        JSON.parse(await application.evaluate(({ clipboard }) => clipboard.readText())),
      ).toEqual(harness(latest, "claude-code"));
      expect(harness(latest, "cursor").version).toBe("2026.11.02-abc1234");

      await page.getByRole("button", { name: "Copy agent request" }).click();
      await page.getByText("Copied the agent request.").waitFor();
      const request = await application.evaluate(({ clipboard }) => clipboard.readText());
      expect(request.indexOf("irudd-scope harnesses guide")).toBeGreaterThanOrEqual(0);
      expect(request.indexOf("irudd-scope harnesses read")).toBeGreaterThan(
        request.indexOf("irudd-scope harnesses guide"),
      );
      expect(request).toContain("irudd-scope harnesses file");

      // Rescan replaces the scan time.
      const time = page.locator(".harnesses-matrix time");
      expect(await time.getAttribute("title")).toBeTruthy();
      expect(await time.textContent()).toContain("just now");
      const before = (await scanTime(page))!;
      await page.getByRole("button", { name: "Rescan" }).click();
      await expect.poll(() => scanTime(page)).not.toBe(before);
      expect(Date.parse((await scanTime(page))!)).toBeGreaterThan(Date.parse(before));

      // A skill name shows its SKILL.md beside the names; a linked skill is not read.
      await claude.waitFor();
      await claude.getByRole("button", { name: "outside linked" }).click();
      await claude.getByText("Linked. Scope does not follow it.").waitFor();
      await claude.getByRole("button", { name: "notes", exact: true }).click();
      const notes = claude.getByRole("region", { name: "Text of notes/SKILL.md" });
      expect(await notes.textContent()).toBe("1# Notes");
      expect(
        await claude
          .getByRole("button", { name: "notes", exact: true })
          .getAttribute("aria-current"),
      ).toBe("true");

      // A narrow window scrolls the matrix inside the tab, not the whole page.
      await page.setViewportSize({ width: 600, height: 860 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      await saveScreenshots(page, "skill-text");

      // Closing the names returns focus to the count that opened them.
      await claude.getByRole("button", { name: "Close skill names" }).click();
      await claude.waitFor({ state: "detached" });
      expect(
        await count("Claude Code").evaluate((button) => button === document.activeElement),
      ).toBe(true);

      // The fingerprint opens the file's text below its row, replacing any other open panel.
      const fingerprintButton = agents.getByRole("button");
      await fingerprintButton.focus();
      await page.keyboard.press("Enter");
      const agentsText = page.getByRole("region", { name: "AGENTS.md on This computer" });
      await agentsText
        .getByText(`~/.codex/AGENTS.md · This computer · ${fingerprint.slice(0, 8)}`)
        .waitFor();
      expect(
        await agentsText.getByRole("region", { name: "Text of AGENTS.md" }).textContent(),
      ).toBe("1# Codex rules23Keep changes small.4Run the tests.");
      expect(await fingerprintButton.getAttribute("aria-expanded")).toBe("true");
      await agentsText.getByRole("button", { name: "Copy text" }).click();
      await page.getByText("Copied the text of AGENTS.md.").waitFor();
      expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(
        instructions.codex,
      );
      await saveScreenshots(page, "file-text");
      await agentsText.getByRole("button", { name: "Close text" }).click();
      await agentsText.waitFor({ state: "detached" });
      expect(await fingerprintButton.evaluate((button) => button === document.activeElement)).toBe(
        true,
      );

      // A rescan that removes the opened harness closes its panel.
      await count("Claude Code").click();
      await claude.waitFor();
      await rm(join(fixture.home, ".claude"), { recursive: true, force: true });
      await page.getByRole("button", { name: "Rescan" }).click();
      await claude.waitFor({ state: "detached" });
      await row("Claude Code").getByText("Not installed").waitFor();
    } finally {
      await application.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);
