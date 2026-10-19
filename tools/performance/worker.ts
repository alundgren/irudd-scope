import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Options } from "../performance.ts";
import { Report } from "./report.ts";
import { Session } from "./session.ts";
import { fixtures } from "./fixtures.ts";
import { publications, restart, scaleTabs, seedArtifacts, tabs, viewers } from "./artifacts.ts";
import {
  librarian,
  prompts,
  pullRequests,
  retro,
  seedPrompts,
  scaleLibraries,
  sketchpad,
} from "./productivity.ts";
import {
  hubFixture,
  legacyRecovery,
  maintenance,
  memorySync,
  relay,
  settings,
  transfer,
  transferRenderer,
  voice,
} from "./integrations.ts";
import { desktopFixture } from "../../tests/desktop-fixture.ts";

const options = JSON.parse(process.env.SCOPE_PERFORMANCE_OPTIONS!) as Options;
const report = new Report(options.runDir);
const heartbeat = setInterval(() => process.send?.({ heartbeat: true }), 1000);
let session: Session | undefined;
let closing = false;
const finish = () => {
  closing = true;
  if (session) {
    session.stopping = true;
    void session.close().catch(() => {});
  }
};
process.on("SIGTERM", finish);
process.on("SIGINT", finish);
const hardCleanup = () => {
  report.event("timeout", { operation: "worker-final-cleanup", limitMs: 25_000 });
  report.sync();
  process.exit(76);
};
async function main() {
  const f = await fixtures(options);
  Object.assign(process.env, f.env);
  await writeFile(
    join(options.runDir, "data", "context.json"),
    JSON.stringify({ phase: "setup", feature: "setup", operation: "setup", workload: "small" }),
  );
  const fixture = await desktopFixture({ env: f.env });
  const s = (session = new Session(report, fixture));
  s.phase = "setup";
  const setupTimer = setTimeout(() => {
    report.event("timeout", { operation: "fixture-setup", limitMs: 180_000 });
    report.sync();
    process.exit(75);
  }, 180_000);
  let hub: Awaited<ReturnType<typeof hubFixture>> | undefined;
  let sampleTimer: ReturnType<typeof setInterval> | undefined;
  const failures = new Map<string, number>();
  const expected = [
    "viewers.text",
    "viewers.markdown",
    "viewers.html",
    "viewers.image",
    "viewers.file",
    "viewers.excalidraw",
    "viewers.large",
    "plans",
    "publication.direct",
    "prompts.current-library-image-export",
    "pull-requests.inventory-detail-state-windows",
    "librarian.browse-search-read",
    "librarian.proposals-decisions-completion",
    "librarian.legacy-recovery",
    "memory.sync",
    "retro.reports",
    "sketchpad.edit-autosave-present",
    "workspace.tabs-search-trash-restore",
    "workspace.groups",
    "workspace.restart",
    "settings",
    "transfer.service",
    "transfer.renderer",
    "publication.hub-offline-reconnect",
    "voice.receipts-audio",
    "maintenance",
    "external-delay-attribution",
  ];
  report.event("inventory", {
    required: expected,
    registeredPlugins: ["prompts", "memory", "sketchpad", "plan", "pull-requests", "retro", "file"],
  });
  for (const feature of expected) s.status(feature, "unmeasured", "Not reached yet");
  for (const feature of [
    "platform.native-dialogs",
    "platform.macos-windows",
    "external.live-services",
    "transfer.native-tailcat",
    "transfer.renderer-import",
    "workspace.drag-groups",
    "maintenance.scheduled-expiry",
  ])
    s.status(
      feature,
      "unmeasured",
      "Excluded from isolated Linux protocol; no personal services, native dialogs or live transport",
    );
  if (!f.native) s.status("librarian.native-engine", "unmeasured", f.nativeReason);
  const scenario = async (name: string, action: () => Promise<void>) => {
    if (closing || s.stopping || (failures.get(name) ?? 0) >= 3) return;
    s.feature = name;
    const timer = setTimeout(() => {
      report.event("timeout", {
        feature: name,
        phase: s.phase,
        workload: s.workload,
        limitMs: 180_000,
      });
      report.sync();
      process.exit(75);
    }, 180_000);
    try {
      await action();
      failures.set(name, 0);
    } catch (error) {
      if (closing) return;
      const count = (failures.get(name) ?? 0) + 1;
      failures.set(name, count);
      report.event("failure", {
        feature: s.feature,
        scenario: name,
        phase: s.phase,
        workload: s.workload,
        error: String(error),
        consecutive: count,
      });
      s.status(s.feature, count >= 3 ? "unavailable" : "failed", String(error));
      await s.page
        ?.screenshot({
          path: join(options.runDir, "logs", `failure-${name.replaceAll(/[^a-z0-9-]/gi, "-")}.png`),
          timeout: 5000,
        })
        .catch(() => {});
      await s.page?.keyboard.press("Escape").catch(() => {});
      await s.page?.keyboard.press("Escape").catch(() => {});
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await s.launch();
    report.write("build.json", {
      commit: (await s.command("git", ["rev-parse", "HEAD"])).trim(),
      runtime: await s.application.evaluate(({ app }) => ({
        electron: process.versions.electron,
        node: process.versions.node,
        appVersion: app.getVersion(),
        platform: process.platform,
        architecture: process.arch,
      })),
    });
    await seedArtifacts(s, f);
    await seedPrompts(s, f, options.smoke ? 4 : 10);
    await (await s.client()).librarian({ action: "local", root: f.root, initialize: false });
    hub = await hubFixture(s);
    clearTimeout(setupTimer);
    const started = performance.now();
    const duration = Number(process.env.SCOPE_PERFORMANCE_REMAINING_MS);
    const offset = Number(process.env.SCOPE_PERFORMANCE_OFFSET_MS);
    const elapsed = () => performance.now() - started + offset;
    process.send?.({ ready: true, setupMs: started - report.started });
    sampleTimer = setInterval(() => {
      void s
        .sample("periodic")
        .catch((error) => report.event("failure", { operation: "sampler", error: String(error) }));
    }, 5000);
    const suite = async () => {
      await scenario("viewers", () => viewers(s));
      await scenario("publication.direct", () => publications(s, f));
      await scenario("prompts.current-library-image-export", () => prompts(s));
      await scenario("pull-requests.inventory-detail-state-windows", () => pullRequests(s));
      await scenario("librarian", () => librarian(s, f, f.native));
      await scenario("retro.reports", () => retro(s));
      await scenario("sketchpad.edit-autosave-present", () => sketchpad(s));
      await scenario("workspace", () => tabs(s));
      await scenario("settings", () => settings(s));
      await scenario("transfer.service", () => transfer(s));
      await scenario("transfer.renderer", () => transferRenderer(s));
      await scenario("publication.hub-offline-reconnect", () => relay(s, hub!));
      await scenario("voice.receipts-audio", () => voice(s));
      await scenario("maintenance", () => maintenance(s, hub!));
    };
    const checkpoint = async (label: string) => {
      s.workload = "equivalent-small";
      await scenario("scale", async () => {
        await scaleTabs(s, 0);
        await scaleLibraries(s, f, options.smoke ? 4 : 10);
      });
      await s.open("Performance text");
      await s.settle();
      await s.sample(`${label}-before`);
      report.event("checkpoint", {
        label,
        phase: s.phase,
        workload: s.workload,
        sessionAgeMs: performance.now() - s.sessionStart,
      });
      await suite();
      await s.open("Performance text");
      await s.settle();
      await s.sample(`${label}-after`);
    };
    s.phase = "baseline";
    report.event("phase", { phase: s.phase, measuredElapsedMs: elapsed() });
    await checkpoint("beginning");
    await scenario("external-delay-attribution", () => pullRequests(s, true));
    await scenario("memory.sync", () => memorySync(s, f));
    if (options.injectFailure)
      await scenario("injected-failure", async () => {
        await s.run("intentional-failure", "integration", async () => {
          throw new Error("Intentional smoke failure; subsequent scenarios must continue");
        });
      });
    let cycle = 0,
      middle = false;
    const mixedEnd =
      duration + offset - Math.max((duration + offset) * 0.2, options.smoke ? 75_000 : 0);
    while (!closing && elapsed() < mixedEnd) {
      const nextPhase = elapsed() < (duration + offset) * 0.2 ? "baseline" : "mixed";
      if (nextPhase !== s.phase) {
        s.phase = nextPhase;
        report.event("phase", { phase: s.phase, measuredElapsedMs: elapsed() });
      }
      if (!middle && elapsed() >= (duration + offset) * 0.5) {
        await checkpoint("middle");
        middle = true;
        if (elapsed() >= mixedEnd) break;
      }
      s.workload = ["small", "medium", "large"][cycle % 3];
      const target = options.smoke ? [0, 8, 20][cycle % 3] : [0, 50, 150][cycle % 3];
      await scenario("scale", async () => {
        await scaleTabs(s, target);
        await scaleLibraries(
          s,
          f,
          options.smoke ? [4, 8, 12][cycle % 3] : [10, 100, 1000][cycle % 3],
        );
      });
      await suite();
      await s.sample(`cycle-${cycle++}`);
      await delay(options.smoke ? 100 : 5000);
    }
    if (!closing) {
      s.phase = "repeat-cleanup-restart";
      report.event("phase", { phase: s.phase, measuredElapsedMs: elapsed() });
      await s.sample("before-repeat-cleanup");
      await checkpoint("end");
      await s.sample("after-repeat-cleanup");
      await scenario("workspace.restart", () => restart(s));
      await scenario("librarian.legacy-recovery", () => legacyRecovery(s, f));
      await scenario("maintenance", () => maintenance(s, hub!));
      await s.sample("after-cleanup-restart");
      while (!closing && elapsed() < duration + offset) {
        await scenario("publication.direct", () => publications(s, f));
        await s.sample("repeat");
        await delay(1000);
      }
    }
    if (f.native && s.coverage.get("librarian.browse-search-read")?.status === "measured")
      s.status(
        "librarian.native-engine",
        "measured",
        "Explicit native binary with isolated synthetic memory, external timing log",
      );
  } finally {
    clearTimeout(setupTimer);
    clearInterval(sampleTimer);
    const timer = setTimeout(hardCleanup, 25_000);
    await s.sample("before-final-close").catch(() => {});
    await s
      .close()
      .catch((error) => report.event("failure", { operation: "close", error: String(error) }));
    await hub
      ?.close()
      .catch((error) => report.event("failure", { operation: "hub-close", error: String(error) }));
    for (const feature of expected)
      if (s.coverage.get(feature)?.reason === "Not reached yet")
        s.status(feature, "unmeasured", "Run ended before this scenario completed");
    report.event("cleanup", {
      event: "worker-finished",
      remainingIsolatedProfile: fixture.directory,
    });
    report.sync();
    clearTimeout(timer);
    clearInterval(heartbeat);
  }
}
await main()
  .catch((error) => {
    report.event("failure", {
      operation: "worker",
      error: error instanceof Error ? error.stack : String(error),
    });
    report.sync();
    process.exitCode = 1;
  })
  .finally(() => clearInterval(heartbeat));
