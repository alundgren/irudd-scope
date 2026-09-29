import { expect, test } from "vite-plus/test";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { desktopFixture } from "./desktop-fixture.ts";

test("shared key and independent switches work in Electron, and Chromium decodes the generated WAV", async () => {
  const { directory, launch, connect } = await desktopFixture();
  const application = await launch();
  try {
    await application.evaluate(() => {
      const original = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        if (url === "https://openrouter.ai/api/v1/audio/speech")
          return new Response(new Uint8Array(4800), {
            headers: { "Content-Type": "audio/pcm", "X-Generation-Id": "gen-tts-playable" },
          });
        if (String(url).startsWith("https://openrouter.ai/api/v1/generation"))
          return Response.json({
            data: {
              id: "gen-tts-playable",
              model: "google/gemini-3.8-flash-tts",
              provider_name: "Google AI Studio",
              total_cost: 0.001,
            },
          });
        return original(url, init);
      };
    });
    const page = await application.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    await page.keyboard.press("ControlOrMeta+,");
    const search = page.getByLabel("Search settings");
    await search.fill("api key");
    await page.getByLabel("OpenRouter API key").fill("synthetic-shared-key");
    await page.getByRole("button", { name: "Save key", exact: true }).click();
    await page.getByText("Key saved", { exact: true }).waitFor();
    expect(await page.evaluate(() => window.scope.settings())).toMatchObject({
      diagramGenerationEnabled: false,
      voiceGenerationEnabled: false,
      hasApiKey: true,
    });
    await search.fill("voice generation");
    const voice = page.getByRole("switch", { name: "Enable voice generation" });
    await voice.focus();
    await page.keyboard.press("Space");
    await expect.poll(() => voice.getAttribute("aria-checked")).toBe("true");
    const client = await connect();
    await client.submitVoice({ requestId: "playable", text: "Hello" });
    await expect.poll(async () => (await client.voiceStatus("playable")).state).toBe("succeeded");
    const bytes = await client.voiceResult("playable");
    const duration = await page.evaluate(async (data) => {
      const audio = new AudioContext();
      try {
        return (await audio.decodeAudioData(new Uint8Array(data).buffer)).duration;
      } finally {
        await audio.close();
      }
    }, Array.from(bytes));
    expect(duration).toBeCloseTo(0.1, 4);
    for (const theme of ["light", "dark"]) {
      await search.fill("appearance");
      await page.getByLabel("Appearance", { exact: true }).selectOption(theme);
      await page.setViewportSize(
        theme === "light" ? { width: 1280, height: 820 } : { width: 640, height: 620 },
      );
      await search.fill("voice generation");
      expect(await voice.isVisible()).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
    }
    await search.fill("diagram generation");
    await page.getByRole("switch", { name: "Enable diagram generation" }).click();
    await search.fill("voice generation");
    await voice.click();
    await expect.poll(() => voice.getAttribute("aria-checked")).toBe("false");
    expect(await page.evaluate(() => window.scope.settings())).toMatchObject({
      diagramGenerationEnabled: true,
      voiceGenerationEnabled: false,
      hasApiKey: true,
    });
    await expect(
      client.submitVoice({ requestId: "disabled", text: "New text" }),
    ).rejects.toMatchObject({ status: 403 });
    expect((await client.submitVoice({ requestId: "playable", text: "Hello" })).state).toBe(
      "succeeded",
    );
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop crash preserves the speech ID and never repeats provider submission after restart", async () => {
  const { directory, launch, connect } = await desktopFixture();
  let application = await launch();
  try {
    let page = await application.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    await page.evaluate(() =>
      window.scope.saveSettings({ voiceGenerationEnabled: true, apiKey: "synthetic-crash-key" }),
    );
    await application.evaluate(() => {
      const original = globalThis.fetch;
      Object.assign(globalThis, { scopeSpeechCalls: 0 });
      globalThis.fetch = async (url, init) => {
        if (url !== "https://openrouter.ai/api/v1/audio/speech") return original(url, init);
        (globalThis as unknown as { scopeSpeechCalls: number }).scopeSpeechCalls++;
        return new Response(new ReadableStream({ start() {} }), {
          headers: { "Content-Type": "audio/pcm", "X-Generation-Id": "gen-tts-crashed" },
        });
      };
    });
    let client = await connect();
    await client.submitVoice({ requestId: "crash", text: "Hello before a desktop crash." });
    await expect
      .poll(async () => (await client.voiceStatus("crash")).generationId)
      .toBe("gen-tts-crashed");
    expect(
      await application.evaluate(
        () => (globalThis as unknown as { scopeSpeechCalls: number }).scopeSpeechCalls,
      ),
    ).toBe(1);
    const exited = once(application.process(), "exit");
    application.process().kill("SIGKILL");
    await exited;
    await application.close().catch(() => {});
    application = await launch();
    page = await application.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    client = await connect();
    expect(await client.voiceStatus("crash")).toMatchObject({
      state: "interrupted",
      generationId: "gen-tts-crashed",
      costUsd: null,
      billingStatus: "pending",
    });
    await page.evaluate(() => window.scope.saveSettings({ apiKey: "synthetic-after-crash-key" }));
    await application.evaluate(() => {
      const original = globalThis.fetch;
      Object.assign(globalThis, { scopeSpeechCalls: 0 });
      globalThis.fetch = async (url, init) => {
        if (url === "https://openrouter.ai/api/v1/audio/speech") {
          (globalThis as unknown as { scopeSpeechCalls: number }).scopeSpeechCalls++;
          throw new Error("Unexpected paid submission after restart");
        }
        return original(url, init);
      };
    });
    expect(
      (await client.submitVoice({ requestId: "crash", text: "Hello before a desktop crash." }))
        .state,
    ).toBe("interrupted");
    expect(
      await application.evaluate(
        () => (globalThis as unknown as { scopeSpeechCalls: number }).scopeSpeechCalls,
      ),
    ).toBe(0);
    await expect(
      client.submitVoice({ requestId: "crash", text: "Changed text" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(client.voiceResult("crash")).rejects.toMatchObject({ status: 409 });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
