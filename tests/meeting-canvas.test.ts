import { expect, test } from "vite-plus/test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { desktopFixture } from "./desktop-fixture.ts";

const KEY = "synthetic-meeting-key";
const TRANSCRIPTIONS = "https://openrouter.ai/api/v1/audio/transcriptions";
const COMPLETIONS = "https://openrouter.ai/api/v1/chat/completions";
type Op = {
  op: string;
  section: string | null;
  id: string | null;
  kind: string | null;
  width: string | null;
  after: string | null;
  source: string | null;
  find: string | null;
  text: string | null;
  name: string | null;
  size: string | null;
};
const op = (fields: Partial<Op> & { op: string }): Op => ({
  section: null,
  id: null,
  kind: null,
  width: null,
  after: null,
  source: null,
  find: null,
  text: null,
  name: null,
  size: null,
  ...fields,
});
// What the room says, one clip at a time. Only the third line addresses the canvas.
const ROOM = [
  "I bought new canvas shoes yesterday.",
  "The weather is nice today.",
  "Canvas, draw the login flow with the browser, our API and Google.",
  "Thanks, that is all for now.",
];
type Provider = {
  transcriptions: number;
  edits: number;
  auth: string[];
  audio?: { riff: string; rate: number; channels: number };
  transcriptionModel?: string;
  editModel?: string;
  schemaName?: string;
  userMessages: string[];
  replies: Op[][];
  heard: string[];
  hold?: boolean;
};
type TestGlobal = typeof globalThis & { meetingProvider: Provider; meetingRelease?: () => void };

// Model output that would run script in the renderer if the canvas trusted it. The new
// section's later ops name no section, so they land in the one created before them.
const unsafeOps = [
  op({
    op: "create_section",
    name: "Login flow",
    size: "l",
    kind: "diagram",
    source:
      "flow right\nBrowser -> API: </script><script>window.meetingXss=2</script>\nAPI -> Google",
  }),
  op({
    op: "add",
    id: "links",
    kind: "text",
    source:
      'Unsafe [x](javascript:alert(1)) and <img src=x onerror="window.meetingXss=1"> stay inert.',
  }),
  op({ op: "add", id: "pkce", kind: "decision", source: "Use PKCE in the browser." }),
];

test(
  "meeting canvas turns Canvas requests into safe saved sections and keeps them as HTML",
  { tags: ["survives-restart", "secrets-stay-secret", "no-lost-updates"], timeout: 120_000 },
  async () => {
    const entryDirectory = await mkdtemp(join(tmpdir(), "scope-meeting-entry-"));
    const entry = join(entryDirectory, "meeting-entry.mjs");
    await writeFile(
      entry,
      `import { app, systemPreferences } from "electron";
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
systemPreferences.askForMediaAccess = async () => true;
await import(${JSON.stringify(pathToFileURL(resolve("apps/desktop/dist/main.mjs")).href)});`,
    );
    const g = await desktopFixture({ hideInitialPrompts: true, entry });
    let application = await g.launch();
    try {
      await application.evaluate(
        (_electron, urls) => {
          const state: Provider = {
            transcriptions: 0,
            edits: 0,
            auth: [],
            userMessages: [],
            replies: [],
            heard: [],
          };
          (globalThis as TestGlobal).meetingProvider = state;
          const original = globalThis.fetch;
          globalThis.fetch = async (url, init) => {
            if (url !== urls.transcriptions && url !== urls.completions) return original(url, init);
            const body = JSON.parse(init!.body as string);
            state.auth.push(new Headers(init!.headers).get("Authorization") ?? "");
            if (url === urls.transcriptions) {
              state.transcriptions++;
              state.transcriptionModel = body.model;
              const audio = Buffer.from(body.input_audio.data, "base64");
              state.audio = {
                riff: audio.toString("ascii", 0, 4),
                channels: audio.readUInt16LE(22),
                rate: audio.readUInt32LE(24),
              };
              return Response.json({ text: state.heard.shift() ?? "" });
            }
            state.edits++;
            state.editModel = body.model;
            state.schemaName = body.response_format.json_schema.name;
            state.userMessages.push(body.messages[1].content);
            const ops = state.replies.shift() ?? [];
            if (state.hold) {
              state.hold = false;
              await new Promise<void>((release) => {
                (globalThis as TestGlobal).meetingRelease = release;
              });
            }
            return Response.json({ choices: [{ message: { content: JSON.stringify({ ops }) } }] });
          };
        },
        { transcriptions: TRANSCRIPTIONS, completions: COMPLETIONS },
      );
      const provider = () => application.evaluate(() => (globalThis as TestGlobal).meetingProvider);
      const page = await application.firstWindow();
      page.setDefaultTimeout(10_000);
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByLabel("Search artifacts", { exact: true }).fill("meeting");
      await page.getByRole("button", { name: "Meeting canvas", exact: true }).click();
      const listen = page.getByRole("switch", { name: "Listen", exact: true });
      await listen.waitFor();
      // The test fakes OpenRouter; the default edit backend is the person's Codex login.
      await page.getByLabel("Edit backend").selectOption("openrouter");

      await listen.click();
      await page.getByRole("alert").filter({ hasText: "Add an OpenRouter API key" }).waitFor();
      await expect.poll(() => listen.getAttribute("aria-checked")).toBe("false");
      await page.evaluate((key) => window.scope.saveSettings({ apiKey: key }), KEY);

      await application.evaluate(
        (_electron, { ops, room }) => {
          const state = (globalThis as TestGlobal).meetingProvider;
          state.replies.push(ops);
          state.heard.push(...room);
        },
        { ops: unsafeOps, room: ROOM },
      );
      await listen.click();
      await page.getByRole("status").filter({ hasText: "Listening" }).waitFor();
      // The fake microphone may never go quiet, so clips can end at the 6 s cap.
      await expect
        .poll(async () => (await provider()).transcriptions, { timeout: 45_000 })
        .toBeGreaterThanOrEqual(ROOM.length);
      await expect
        .poll(async () => (await provider()).edits, { timeout: 20_000 })
        .toBeGreaterThan(0);
      const sections = page.locator(".mc-viewport [data-section]");
      const blocks = page.locator(".mc-viewport [data-block]");
      await expect.poll(() => blocks.count()).toBe(3);
      await page.locator(".mc-viewport").getByText("Use PKCE in the browser.").waitFor();
      await page
        .locator(".mc-transcript li.is-wake")
        .filter({ hasText: "Canvas, draw the login flow" })
        .waitFor();
      await listen.click();
      await expect.poll(() => listen.getAttribute("aria-checked")).toBe("false");
      expect(await sections.count()).toBe(1);
      expect(
        await page.locator('.mc-viewport [data-section="login-flow"] .mc-section-name').innerText(),
      ).toBe("Login flow");

      // Only the wake line reached the model; "canvas shoes" was context, not a request.
      const calls = await provider();
      expect(calls).toMatchObject({
        edits: 1,
        audio: { riff: "RIFF", rate: 16000, channels: 1 },
        transcriptionModel: "mistralai/voxtral-mini-transcribe-3-0",
        schemaName: "meeting_canvas",
      });
      expect(new Set(calls.auth)).toEqual(new Set([`Bearer ${KEY}`]));
      expect(calls.userMessages[0]).toContain(
        "## Request (carry this out)\ndraw the login flow with the browser, our API and Google.",
      );
      expect(calls.userMessages[0]).not.toContain("Thanks, that is all");
      const unsafe = await page.evaluate(() => ({
        scriptLinks: document.querySelectorAll('a[href^="javascript:" i]').length,
        onerror: document.querySelectorAll("[onerror]").length,
        handlers: [...document.querySelectorAll(".mc-viewport *")].filter((element) =>
          element.getAttributeNames().some((name) => name.startsWith("on")),
        ).length,
        ran: (window as unknown as { meetingXss?: number }).meetingXss,
      }));
      expect(unsafe).toEqual({ scriptLinks: 0, onerror: 0, handlers: 0, ran: undefined });

      const titleInput = page.getByLabel("Canvas title");
      await titleInput.fill("Login review");
      await titleInput.press("Enter");

      // A typed request skips the wake word and can name its section loosely.
      await application.evaluate(
        (_electron, ops) => {
          (globalThis as TestGlobal).meetingProvider.replies.push(ops);
        },
        [
          op({
            op: "add",
            section: "login flow",
            id: "owner",
            kind: "note",
            source: "Priya owns the callback URLs.",
          }),
        ],
      );
      await page
        .getByLabel("Ask the canvas")
        .fill("In the login flow, note that Priya owns the callback URLs");
      await page.getByRole("button", { name: "Ask", exact: true }).click();
      await page.locator(".mc-viewport").getByText("Priya owns the callback URLs.").waitFor();
      expect((await provider()).userMessages.at(-1)).toContain(
        "In the login flow, note that Priya owns the callback URLs",
      );
      await expect.poll(() => blocks.count()).toBe(4);
      expect(await sections.count()).toBe(1);

      // A reply that arrives after the person edited a block leaves their text alone.
      await application.evaluate(
        (_electron, ops) => {
          const state = (globalThis as TestGlobal).meetingProvider;
          state.replies.push(ops);
          state.hold = true;
        },
        [
          op({
            op: "patch",
            section: "Login flow",
            id: "pkce",
            find: "Use PKCE",
            text: "Model rewrote PKCE",
          }),
        ],
      );
      const editsBefore = (await provider()).edits;
      await page.getByLabel("Ask the canvas").fill("Reword the PKCE decision");
      await page.getByRole("button", { name: "Ask", exact: true }).click();
      await expect.poll(async () => (await provider()).edits).toBe(editsBefore + 1);
      await page.locator('.mc-viewport [data-block="login-flow/pkce"]').click();
      await page.getByLabel("Block source").fill("Use PKCE everywhere.");
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await application.evaluate(() => (globalThis as TestGlobal).meetingRelease?.());
      await page.getByText("You changed this while the model was working.").first().waitFor();
      await page.locator(".mc-viewport").getByText("Use PKCE everywhere.").waitFor();
      expect(await page.locator(".mc-viewport").getByText("Model rewrote PKCE").count()).toBe(0);

      await page.getByRole("button", { name: "Keep as HTML" }).click();
      await page.getByText("Kept “Login review” as HTML.", { exact: false }).waitFor();
      const client = await g.connect();
      const kept = (await client.list()).find((artifact) => artifact.title === "Login review");
      expect(kept).toMatchObject({ kind: "html", mediaType: "text/html" });
      const html = new TextDecoder().decode(await client.content(kept!.id));
      const json = html.match(
        /<script type="application\/json" id="meeting-canvas">([\s\S]*?)<\/script>/,
      )?.[1];
      expect(json).toBeDefined();
      expect(json!.toLowerCase()).not.toContain("</script");
      const keptCanvas = JSON.parse(json!) as {
        sections: { name: string; blocks: { id: string }[] }[];
      };
      expect(keptCanvas.sections.map((section) => section.name)).toEqual(["Login flow"]);
      expect(keptCanvas.sections[0]!.blocks.map((block) => block.id)).toEqual([
        "main",
        "links",
        "pkce",
        "owner",
      ]);
      // Escaped text may still spell these words; no real tag may carry them.
      expect(html).not.toMatch(/<a\b[^>]*href="javascript:/i);
      expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+=/i);

      await page.getByRole("tab", { name: "Meeting canvas" }).click();
      await page.getByRole("button", { name: "Clear canvas" }).click();
      await expect.poll(() => blocks.count()).toBe(0);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await expect.poll(() => blocks.count()).toBe(4);

      expect(await page.content()).not.toContain(KEY);
      await application.close();
      application = await g.launch();
      const restored = await application.firstWindow();
      restored.setDefaultTimeout(10_000);
      await restored.getByRole("tab", { name: "Meeting canvas" }).click();
      await restored.locator(".mc-viewport").getByText("Use PKCE everywhere.").waitFor();
      expect(await restored.locator(".mc-viewport [data-block]").count()).toBe(4);
      expect(await restored.getByLabel("Canvas title").inputValue()).toBe("Login review");
      expect(await restored.content()).not.toContain(KEY);

      const log = join(g.settingsDirectory, "meeting-canvas-debug.jsonl");
      const text = await readFile(log, "utf8");
      expect(text).toContain("Canvas, draw the login flow");
      expect(text).toContain('"type":"edit"');
      expect(text).not.toContain(KEY);
      if (process.platform !== "win32") expect((await stat(log)).mode & 0o777).toBe(0o600);
      expect(g.stderr()).not.toContain(KEY);
    } finally {
      await application.close();
      await rm(g.directory, { recursive: true, force: true });
      await rm(entryDirectory, { recursive: true, force: true });
    }
  },
);
