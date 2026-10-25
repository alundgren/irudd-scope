// Only the repository owner raises this limit. Each new test replaces a weaker one.
export const maxTests = 239;

// Test files written before tests were limited to Scope's public entry points.
// Each keeps exactly these product imports and test count. Remove imports and
// tests over time and lower the entry to match. Never add an entry.
export const frontDoorExceptions: Record<string, { tests?: number; imports: string[] }> = {
  "tests/artifact-storage.test.ts": {
    tests: 1,
    imports: ["apps/desktop/src/library/server.ts"],
  },
  "tests/artifacts.test.ts": {
    tests: 7,
    imports: [
      "apps/desktop/src/library/local.ts",
      "apps/desktop/src/library/server.ts",
      "apps/hub/src/server.ts",
    ],
  },
  "tests/credential-helper.test.ts": {
    tests: 3,
    imports: ["apps/desktop/src/credentials.ts"],
  },
  "tests/credentials.test.ts": {
    tests: 6,
    imports: ["apps/desktop/src/credentials.ts", "apps/desktop/src/desktop-store.ts"],
  },
  "tests/desktop-storage.test.ts": {
    tests: 3,
    imports: [
      "apps/desktop/src/credentials.ts",
      "apps/desktop/src/desktop-store.ts",
      "apps/desktop/src/library/store.ts",
      "apps/desktop/src/lifecycle.ts",
      "apps/desktop/src/plugins/sketchpad/contract.ts",
      "apps/desktop/src/workspace/contract.ts",
    ],
  },
  "tests/hub-buffering.test.ts": {
    tests: 11,
    imports: [
      "apps/desktop/src/credentials.ts",
      "apps/desktop/src/desktop-store.ts",
      "apps/desktop/src/library/server.ts",
      "apps/desktop/src/remotes.ts",
      "apps/hub/src/paired-server.ts",
      "apps/hub/src/state.ts",
    ],
  },
  "tests/hub-relay.test.ts": {
    tests: 2,
    imports: ["apps/hub/src/paired-server.ts", "apps/hub/src/state.ts"],
  },
  "tests/installation.test.ts": {
    tests: 16,
    imports: [
      "apps/desktop/src/agent-tools.ts",
      "apps/desktop/src/installation-files.ts",
      "apps/desktop/src/installation-process.ts",
      "apps/desktop/src/signing.ts",
      "apps/desktop/src/updates.ts",
    ],
  },
  "tests/lifecycle-process.ts": {
    imports: [
      "apps/desktop/src/desktop-store.ts",
      "apps/desktop/src/library/store.ts",
      "apps/desktop/src/lifecycle.ts",
    ],
  },
  "tests/lifecycle.test.ts": {
    tests: 8,
    imports: [
      "apps/desktop/src/desktop-store.ts",
      "apps/desktop/src/library/library.ts",
      "apps/desktop/src/library/server.ts",
      "apps/desktop/src/library/store.ts",
      "apps/desktop/src/lifecycle.ts",
    ],
  },
  "tests/maintenance.test.ts": {
    tests: 2,
    imports: [
      "apps/desktop/src/desktop-store.ts",
      "apps/desktop/src/library/server.ts",
      "apps/desktop/src/lifecycle.ts",
      "packages/sqlite/src/maintenance.ts",
    ],
  },
  "tests/memory-commands.test.ts": {
    tests: 2,
    imports: ["packages/memory-sync/src/commands.ts"],
  },
  "tests/memory-remotes.test.ts": {
    tests: 1,
    imports: [
      "@irudd-scope/memory-sync",
      "apps/desktop/src/credentials.ts",
      "apps/desktop/src/desktop-store.ts",
      "apps/desktop/src/library/server.ts",
      "apps/desktop/src/lifecycle.ts",
      "apps/desktop/src/memory.ts",
      "apps/desktop/src/remotes.ts",
      "apps/hub/src/paired-server.ts",
      "apps/hub/src/state.ts",
    ],
  },
  "tests/memory-service.test.ts": {
    tests: 2,
    imports: [
      "apps/desktop/src/desktop-store.ts",
      "apps/desktop/src/memory.ts",
      "apps/desktop/src/remotes.ts",
    ],
  },
  "tests/memory-sync.test.ts": {
    tests: 10,
    imports: ["@irudd-scope/memory-sync"],
  },
  "tests/memory-ui.test.ts": {
    tests: 1,
    imports: ["@irudd-scope/memory-sync"],
  },
  "tests/plan-cli.test.ts": {
    tests: 1,
    imports: ["apps/desktop/src/library/server.ts"],
  },
  "tests/pressure-fixture.ts": {
    imports: ["apps/hub/src/paired-server.ts", "apps/hub/src/state.ts"],
  },
  "tests/prompts-fixture.ts": {
    imports: ["apps/desktop/src/library/server.ts"],
  },
  "tests/prompts-remotes.test.ts": {
    tests: 1,
    imports: [
      "apps/desktop/src/credentials.ts",
      "apps/desktop/src/desktop-store.ts",
      "apps/desktop/src/remotes.ts",
      "apps/hub/src/paired-server.ts",
      "apps/hub/src/state.ts",
    ],
  },
  "tests/pull-requests-scheduler.test.ts": {
    tests: 4,
    imports: [
      "apps/desktop/src/library/server.ts",
      "apps/desktop/src/plugins/pull-requests/gh-process.ts",
      "apps/desktop/src/plugins/pull-requests/gh.ts",
      "apps/desktop/src/plugins/pull-requests/sync.ts",
    ],
  },
  "tests/pull-requests-stack.test.ts": {
    tests: 4,
    imports: [
      "apps/desktop/src/plugins/pull-requests/gh-process.ts",
      "apps/desktop/src/plugins/pull-requests/gh.ts",
    ],
  },
  "tests/pull-requests-state-sdk.test.ts": {
    tests: 2,
    imports: ["apps/desktop/src/plugins/pull-requests/frame-sdk.ts"],
  },
  "tests/pull-requests-sync.test.ts": {
    tests: 2,
    imports: [
      "apps/desktop/src/library/server.ts",
      "apps/desktop/src/library/store.ts",
      "apps/desktop/src/plugins/pull-requests/gh-process.ts",
      "apps/desktop/src/plugins/pull-requests/gh.ts",
      "apps/desktop/src/plugins/pull-requests/sync.ts",
    ],
  },
  "tests/pull-requests.test.ts": {
    tests: 18,
    imports: ["apps/desktop/src/library/server.ts"],
  },
  "tests/remote-cancellation.test.ts": {
    tests: 1,
    imports: [
      "apps/desktop/src/credentials.ts",
      "apps/desktop/src/desktop-store.ts",
      "apps/desktop/src/remotes.ts",
    ],
  },
  "tests/remote-update-fixture.ts": {
    imports: [
      "apps/desktop/src/credentials.ts",
      "apps/desktop/src/desktop-store.ts",
      "apps/desktop/src/library/server.ts",
      "apps/desktop/src/remotes.ts",
      "apps/hub/src/state.ts",
    ],
  },
  "tests/remote-updates.test.ts": {
    tests: 6,
    imports: ["apps/desktop/src/remote-updates.ts"],
  },
  "tests/remotes-ui.test.ts": {
    tests: 1,
    imports: ["apps/hub/src/paired-server.ts", "apps/hub/src/state.ts"],
  },
  "tests/remotes.test.ts": {
    tests: 5,
    imports: [
      "apps/desktop/src/credentials.ts",
      "apps/desktop/src/desktop-store.ts",
      "apps/desktop/src/library/server.ts",
      "apps/desktop/src/lifecycle.ts",
      "apps/desktop/src/remotes.ts",
      "apps/hub/src/paired-server.ts",
      "apps/hub/src/state.ts",
    ],
  },
  "tests/retro-api.test.ts": {
    tests: 26,
    imports: [
      "apps/desktop/src/desktop-store.ts",
      "apps/desktop/src/library/server.ts",
      "apps/desktop/src/remotes.ts",
      "apps/hub/src/paired-server.ts",
      "apps/hub/src/server.ts",
      "apps/hub/src/state.ts",
    ],
  },
  "tests/retro-machines.test.ts": {
    tests: 3,
    imports: ["apps/desktop/src/desktop-store.ts"],
  },
  "tests/retro-sdk.test.ts": {
    tests: 3,
    imports: ["apps/desktop/src/plugins/retro/frame-sdk.ts"],
  },
  "tests/tab-events.test.ts": {
    tests: 3,
    imports: [
      "apps/desktop/src/plugins/events.ts",
      "apps/desktop/src/workspace/contract.ts",
      "apps/desktop/src/workspace/events.ts",
    ],
  },
  "tests/tab-retention.test.ts": {
    tests: 4,
    imports: [
      "apps/desktop/src/desktop-store.ts",
      "apps/desktop/src/library/server.ts",
      "apps/desktop/src/library/store.ts",
      "apps/desktop/src/lifecycle.ts",
      "apps/desktop/src/workspace/retention.ts",
    ],
  },
  "tests/voice.test.ts": {
    tests: 6,
    imports: [
      "apps/desktop/src/credentials.ts",
      "apps/desktop/src/desktop-store.ts",
      "apps/desktop/src/library/server.ts",
      "apps/desktop/src/remotes.ts",
      "apps/desktop/src/voice/openrouter.ts",
      "apps/desktop/src/voice/service.ts",
      "apps/hub/src/paired-server.ts",
      "apps/hub/src/state.ts",
    ],
  },
  "tests/windows-credentials.test.ts": {
    tests: 3,
    imports: ["apps/desktop/src/credentials.ts", "apps/desktop/src/desktop-store.ts"],
  },
  "tests/windows-installation.test.ts": {
    tests: 10,
    imports: [
      "apps/desktop/src/agent-tools.ts",
      "apps/desktop/src/installation-files.ts",
      "apps/desktop/src/installation-process.ts",
      "apps/desktop/src/updates.ts",
      "apps/desktop/src/windows-installation.ts",
    ],
  },
  "tests/workspace-persistence.test.ts": {
    tests: 1,
    imports: [
      "apps/desktop/src/workspace/contract.ts",
      "apps/desktop/src/workspace/persistence.ts",
    ],
  },
};
