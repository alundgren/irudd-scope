import { expect, test } from "vite-plus/test";
import { rm, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { desktopFixture } from "./desktop-fixture.ts";

type Edit = { op: string; id: string; text: string; from: string | null; to: string | null };
type Reply = { transcript: string; summary: string; edits: Edit[] };
type ProviderState = {
  calls: number;
  aborted: number;
  release?: () => void;
  reply: Reply;
  http: number;
  audio?: { riff: string; rate: number; channels: number; bytes: number };
  model?: string;
  auth?: string;
};
type TestGlobal = typeof globalThis & { roomProvider: ProviderState };
const edit = (
  op: string,
  id: string,
  text: string,
  from: string | null = null,
  to: string | null = null,
): Edit => ({ op, id, text, from, to });

test(
  "room listening makes undoable saved diagrams and discards stopped or outdated replies",
  {
    tags: ["survives-restart", "no-lost-updates", "secrets-stay-secret"],
    timeout: 120_000,
  },
  async () => {
    const entryDirectory = await mkdtemp(join(tmpdir(), "scope-listening-entry-"));
    const entry = join(entryDirectory, "listening-entry.mjs");
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
      await application.evaluate(() => {
        const state: ProviderState = {
          calls: 0,
          aborted: 0,
          http: 200,
          reply: { transcript: "", summary: "", edits: [] },
        };
        (globalThis as TestGlobal).roomProvider = state;
        const original = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
          if (url !== "https://openrouter.ai/api/v1/chat/completions") return original(url, init);
          state.calls++;
          const body = JSON.parse(init!.body as string);
          state.model = body.model;
          state.auth = new Headers(init!.headers).get("Authorization") ?? "";
          const audio = Buffer.from(body.messages[1].content[1].input_audio.data, "base64");
          state.audio = {
            riff: audio.toString("ascii", 0, 4),
            channels: audio.readUInt16LE(22),
            rate: audio.readUInt32LE(24),
            bytes: audio.length,
          };
          init!.signal!.addEventListener("abort", () => state.aborted++);
          // Deliberately ignore cancellation to verify that even a late provider reply is discarded.
          await new Promise<void>((resolve) => {
            state.release = resolve;
          });
          state.release = undefined;
          return state.http === 200
            ? Response.json({ choices: [{ message: { content: JSON.stringify(state.reply) } }] })
            : new Response("synthetic provider failure", { status: state.http });
        };
      });
      const page = await application.firstWindow();
      page.setDefaultTimeout(8000);
      await page.evaluate(() => {
        const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        const streams: MediaStream[] = [];
        (window as unknown as { roomStreams: MediaStream[] }).roomStreams = streams;
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          const stream = await acquire(constraints);
          streams.push(stream);
          return stream;
        };
      });
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByLabel("Search artifacts", { exact: true }).fill("sketch");
      await page.getByRole("button", { name: "Sketchpad", exact: true }).click();
      await page.getByTestId("main-menu-trigger").waitFor();
      const id = (await page.getByRole("tab", { name: "Sketchpad" }).getAttribute("id"))!.slice(4);
      const toggle = page.getByRole("switch", { name: "Listening", exact: true });
      await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("false");
      await toggle.click();
      await page.getByRole("alert").filter({ hasText: "Add an OpenRouter API key" }).waitFor();
      await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("false");
      await page.evaluate(() => window.scope.saveSettings({ apiKey: "synthetic-room-key" }));
      await toggle.click();
      const calls = () => application.evaluate(() => (globalThis as TestGlobal).roomProvider.calls);
      const respond = (reply: Reply) =>
        application.evaluate((_electron, reply: Reply) => {
          const state = (globalThis as TestGlobal).roomProvider;
          state.reply = reply;
          state.release?.();
        }, reply);
      const content = () =>
        page.evaluate(async (id) => (await window.scope.sketchpadDraft(id))?.content ?? "", id);
      await expect.poll(calls, { timeout: 15_000 }).toBe(1);
      expect(
        await application.evaluate(() => {
          const { audio, model, auth } = (globalThis as TestGlobal).roomProvider;
          return { audio, model, auth };
        }),
      ).toMatchObject({
        audio: { riff: "RIFF", rate: 16000, channels: 1 },
        model: "google/gemini-2.5-flash-lite",
        auth: "Bearer synthetic-room-key",
      });
      await respond({
        transcript: "The browser calls the API. Record a decision to keep it simple.",
        summary: "Browser calls API.",
        edits: [
          edit("box", "browser", "Browser"),
          edit("box", "api", "API"),
          edit("connect", "request", "HTTP", "browser", "api"),
          edit("note", "decision", "Decision: keep it simple"),
        ],
      });
      await expect.poll(content).toContain("Decision: keep it simple");
      const saved = JSON.parse(await content());
      expect(saved.elements.filter((e: { type: string }) => e.type === "rectangle")).toHaveLength(
        2,
      );
      expect(saved.elements.find((e: { type: string }) => e.type === "arrow")).toMatchObject({
        startBinding: { elementId: "browser" },
        endBinding: { elementId: "api" },
      });
      await expect.poll(calls, { timeout: 15_000 }).toBe(2);
      await toggle.click();
      await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("false");
      expect(
        await page.evaluate(() =>
          (window as unknown as { roomStreams: MediaStream[] }).roomStreams.every((stream) =>
            stream.getTracks().every((track) => track.readyState === "ended"),
          ),
        ),
      ).toBe(true);
      await expect
        .poll(() => application.evaluate(() => (globalThis as TestGlobal).roomProvider.aborted))
        .toBeGreaterThan(0);
      await respond({
        transcript: "",
        summary: "",
        edits: [edit("note", "late", "Must not appear")],
      });
      await page.waitForTimeout(300);
      expect(await content()).not.toContain("Must not appear");
      await page.locator(".excalidraw canvas.interactive").click({ position: { x: 500, y: 350 } });
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(content).toBe("");
      await page.keyboard.press("ControlOrMeta+Shift+z");
      await expect.poll(content).toContain("Decision: keep it simple");
      await toggle.click();
      await expect.poll(calls, { timeout: 15_000 }).toBe(3);
      await page.locator(".excalidraw canvas.interactive").click({ position: { x: 600, y: 400 } });
      await page.keyboard.press("t");
      await page.locator(".excalidraw canvas.interactive").click({ position: { x: 600, y: 400 } });
      await page.locator("textarea.excalidraw-wysiwyg").fill("Human correction");
      await page.keyboard.press("Escape");
      await expect.poll(content).toContain("Human correction");
      await respond({
        transcript: "A stale idea",
        summary: "",
        edits: [edit("note", "stale", "Stale update")],
      });
      await page.getByText("Canvas changed while processing.", { exact: false }).waitFor();
      expect(await content()).not.toContain("Stale update");
      await toggle.click();
      await toggle.click();
      await expect.poll(calls, { timeout: 15_000 }).toBe(4);
      await respond({
        transcript: "Rename Browser to Web client and remove the decision note.",
        summary: "",
        edits: [edit("rename", "browser", "Web client"), edit("remove", "decision", "")],
      });
      await expect.poll(content).toContain("Web client");
      expect(await content()).not.toContain("Decision: keep it simple");
      await expect.poll(calls, { timeout: 15_000 }).toBe(5);
      await application.evaluate(() => {
        const state = (globalThis as TestGlobal).roomProvider;
        state.http = 429;
        state.release?.();
      });
      await page.getByRole("alert").filter({ hasText: "OpenRouter returned HTTP 429" }).waitFor();
      await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("false");
      await application.close();
      application = await g.launch();
      const restored = await application.firstWindow();
      await restored.getByTestId("main-menu-trigger").waitFor();
      await expect
        .poll(() =>
          restored
            .getByRole("switch", { name: "Listening", exact: true })
            .getAttribute("aria-checked"),
        )
        .toBe("false");
      expect(
        (await restored.evaluate((id) => window.scope.sketchpadDraft(id), id))?.content,
      ).toContain("Human correction");
      expect(g.stderr()).not.toContain("synthetic-room-key");
      const screenshots = process.env.SCOPE_REVIEW_DIR ?? join(g.directory, "screenshots");
      await mkdir(screenshots, { recursive: true });
      for (const theme of ["light", "dark"] as const) {
        await restored.keyboard.press("ControlOrMeta+,");
        await restored.getByLabel("Search settings").fill("appearance");
        await restored.getByLabel("Appearance", { exact: true }).selectOption(theme);
        await restored.keyboard.press("Escape");
        await restored.locator("[role=dialog]").waitFor({ state: "hidden" });
        await expect.poll(() => restored.locator("html").getAttribute("data-theme")).toBe(theme);
        await restored.setViewportSize(
          theme === "light" ? { width: 1280, height: 820 } : { width: 640, height: 620 },
        );
        await restored.screenshot({ path: join(screenshots, `sketchpad-listening-${theme}.png`) });
        expect(
          await restored.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        ).toBe(false);
      }
    } finally {
      await application.close();
      await rm(g.directory, { recursive: true, force: true });
      await rm(entryDirectory, { recursive: true, force: true });
    }
  },
);
