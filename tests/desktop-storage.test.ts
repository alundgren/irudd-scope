import { ArtifactStore } from "../apps/desktop/src/library/store.ts";
import { DesktopLifecycle } from "../apps/desktop/src/lifecycle.ts";
import { importWorkspace } from "../apps/desktop/src/workspace/contract.ts";
import { expect, test } from "vite-plus/test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import type { SketchpadDraft } from "../apps/desktop/src/plugins/sketchpad/contract.ts";
import {
  memoryCredentials,
  type CredentialStore,
  type Secrets,
} from "../apps/desktop/src/credentials.ts";

function fakeKeychain(): CredentialStore {
  return { ...memoryCredentials(), kind: "keychain" };
}
function documents(directory: string): string {
  const db = new DatabaseSync(join(directory, "desktop.db"), { readOnly: true });
  try {
    return JSON.stringify(db.prepare("SELECT * FROM preferences").all());
  } finally {
    db.close();
  }
}

test(
  "tab state and Sketchpad drafts survive restart, empty drafts leave no row, and other tabs reject drafts",
  { tags: ["survives-restart"] },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "scope-drafts-"));
    const store = new DesktopStore(directory);
    let artifacts = await ArtifactStore.open(join(directory, "artifacts"));
    const draft: SketchpadDraft = {
      version: 1,
      content: JSON.stringify({ type: "excalidraw", elements: [{ id: "idea" }], files: {} }),
      viewport: { zoom: 0.75, scrollX: 120, scrollY: -50 },
    };
    try {
      await store.load();
      let lifecycle = new DesktopLifecycle(artifacts, store);
      await lifecycle.recover();
      const workspace = await lifecycle.workspace();
      const tab = await lifecycle.openTab({
        id: crypto.randomUUID(),
        groupId: workspace.groups[0].id,
        type: "future-tool",
        title: "Future tool",
        state: { version: 5, data: { prompt: "Keep me" } },
        overlayPositions: {
          fullscreen: { x: 240, y: 90 },
          planControls: { x: 125.5, y: 48 },
          planReview: { x: 30, y: 100 },
        },
      });
      if (!tab) throw new Error("Expected the saved tab to open.");
      await lifecycle.saveWorkspace({ ...workspace, tabs: [tab], selected: tab.id });
      expect(() =>
        lifecycle.saveWorkspace({
          ...workspace,
          tabs: [{ ...tab, overlayPositions: { fullscreen: { x: -1, y: 20 } } }],
          selected: tab.id,
        }),
      ).toThrow();
      expect(() =>
        lifecycle.saveWorkspace({
          ...workspace,
          tabs: [
            { ...tab, overlayPositions: { fullscreen: { x: Number.POSITIVE_INFINITY, y: 20 } } },
          ],
          selected: tab.id,
        }),
      ).toThrow();
      await expect(artifacts.saveSketchpadDraft(tab.id, draft)).rejects.toThrow();
      const sketchpad = await lifecycle.openTab({
        id: crypto.randomUUID(),
        groupId: workspace.groups[0].id,
        type: "sketchpad",
        title: "Sketchpad",
        state: { version: 1, data: {} },
      });
      if (!sketchpad) throw new Error("Expected the Sketchpad to open.");
      await artifacts.saveSketchpadDraft(sketchpad.id, draft);
      await expect(
        artifacts.saveSketchpadDraft(sketchpad.id, {
          ...draft,
          viewport: { ...draft.viewport, zoom: -1 },
        }),
      ).rejects.toThrow();
      await artifacts.close();
      artifacts = await ArtifactStore.open(join(directory, "artifacts"));
      lifecycle = new DesktopLifecycle(artifacts, store);
      await lifecycle.recover();
      expect((await lifecycle.workspace()).tabs).toEqual([tab, sketchpad]);
      expect(await artifacts.sketchpadDraft(sketchpad.id)).toEqual(draft);
      expect(await artifacts.sketchpadDraft(tab.id)).toBeNull();
      await artifacts.deleteSketchpadDraft(tab.id);
      await artifacts.deleteSketchpadDraft(sketchpad.id);
      expect(await artifacts.sketchpadDraft(sketchpad.id)).toBeNull();
      const db = new DatabaseSync(join(directory, "artifacts/scope.db"));
      try {
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(db.prepare("SELECT count(*) AS n FROM tab_drafts").get()?.n).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      await artifacts.close();
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "ordinary settings and tabs reopen from SQLite while credentials stay exclusively in the credential store",
  { tags: ["survives-restart", "secrets-stay-secret"] },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "scope-settings-"));
    const credentials = fakeKeychain();
    const store = new DesktopStore(directory, credentials);
    let reopened: DesktopStore | undefined;
    try {
      await store.load();
      const secret = "synthetic-provider-secret";
      const view = await store.saveSettings({
        voiceGenerationEnabled: true,
        apiKey: secret,
        appearance: "dark",
      });
      const workspace = importWorkspace({ tabs: ["architecture", "review"], selected: "review" });
      await store.saveLayout({ groups: workspace.groups, selected: workspace.selected });
      expect(view).toMatchObject({ hasApiKey: true, keyStorage: "keychain" });
      expect(JSON.stringify(view)).not.toContain(secret);
      expect(view).not.toHaveProperty("endpoint");
      expect(view).not.toHaveProperty("hasHubToken");
      expect(documents(directory)).not.toContain(secret);
      expect(documents(directory)).not.toContain('"apiKey"');
      expect(await readdir(directory)).not.toContain("settings.json");
      await store.close();
      reopened = new DesktopStore(directory, credentials);
      await reopened.load();
      expect(reopened.settings().appearance).toBe("dark");
      expect(await reopened.layout()).toEqual({
        groups: workspace.groups,
        selected: workspace.selected,
      });
      expect(await reopened.secret("apiKey")).toBe(secret);
      await reopened.saveSettings({ apiKey: "replacement-secret" });
      expect(await reopened.secret("apiKey")).toBe("replacement-secret");
      await reopened.saveSettings({ removeApiKey: true });
      expect(await reopened.secret("apiKey")).toBeUndefined();
      expect(await credentials.read()).toEqual({});
    } finally {
      await reopened?.close();
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a locked or failing Keychain remains visible and cannot silently remove a saved key",
  { tags: ["secrets-stay-secret"] },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "scope-keychain-failure-"));
    let locked = false;
    let secrets: Secrets = { apiKey: "existing-provider-key" };
    const credentials: CredentialStore = {
      kind: "keychain",
      read: async () => {
        if (locked) throw new Error("Keychain locked");
        return { ...secrets };
      },
      write: async (next) => {
        if (locked) throw new Error("Keychain locked");
        secrets = { ...next };
      },
    };
    const store = new DesktopStore(directory, credentials);
    try {
      await store.load();
      await store.saveSettings({ voiceGenerationEnabled: true });
      await store.providerSettings();
      locked = true;
      await expect(store.saveSettings({ removeApiKey: true })).rejects.toThrow("Keychain locked");
      const view = await store.providerSettings();
      expect(view.credentialError).toContain("Key status is unavailable");
      expect(view.hasApiKey).toBe(true);
      expect(secrets.apiKey).toBe("existing-provider-key");
      await expect(store.secret("apiKey")).rejects.toThrow("Keychain locked");
      locked = false;
      const retried = await store.providerSettings();
      expect(retried.credentialError).toBeUndefined();
      expect(retried.hasApiKey).toBe(true);
      expect(await store.secret("apiKey")).toBe("existing-provider-key");
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
