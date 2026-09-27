import { readlink } from "node:fs/promises";
import { join } from "node:path";
import {
  activateBuild,
  pruneBuilds,
  readInstallation,
  type Installation,
} from "./installation-files.ts";
import { runInstallationCommand } from "./installation-process.ts";
import type { UpdateStatus } from "./installation-contract.ts";

export class AppUpdates {
  private value: UpdateStatus;
  private controller?: AbortController;
  private pending?: Promise<void>;
  private prepared?: string;

  constructor(
    private readonly installation: Installation | undefined,
    private readonly installer: string,
    private readonly onChange: (status: UpdateStatus) => void,
  ) {
    this.value = installation
      ? {
          phase: "idle",
          message: "Updates are checked when Scope opens.",
          currentCommit: installation.commit,
        }
      : {
          phase: "unmanaged",
          message: "Automatic updates are available in the installed Mac app.",
        };
  }

  snapshot(): UpdateStatus {
    return { ...this.value };
  }
  private change(next: Partial<UpdateStatus>) {
    this.value = { ...this.value, ...next };
    this.onChange(this.snapshot());
  }

  check(): Promise<void> {
    if (!this.installation || this.value.phase === "ready") return Promise.resolve();
    if (this.pending) return this.pending;
    this.controller = new AbortController();
    this.pending = this.prepare(this.installation, this.controller.signal).finally(() => {
      this.pending = undefined;
      this.controller = undefined;
    });
    return this.pending;
  }

  private async prepare(installation: Installation, signal: AbortSignal) {
    this.change({
      phase: "checking",
      message: "Checking main for updates…",
      output: undefined,
      nextCommit: undefined,
    });
    try {
      const source = join(installation.root, "source");
      const response = await runInstallationCommand(
        "git",
        ["ls-remote", "origin", "refs/heads/main"],
        {
          cwd: source,
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        },
      );
      const commit = /^([0-9a-f]{40})\s+refs\/heads\/main$/.exec(response)?.[1];
      if (!commit) throw new Error("Git did not return the main commit. Try checking again.");
      if (commit === installation.commit) {
        this.change({ phase: "idle", message: "Scope is up to date." });
        return;
      }
      this.change({
        phase: "building",
        message: "Building the update on this Mac…",
        nextCommit: commit,
      });
      await runInstallationCommand("/bin/bash", [this.installer, "--prepare", commit], {
        cwd: source,
        env: { SCOPE_INSTALL_ROOT: installation.root, SCOPE_VP: installation.vp },
        signal: AbortSignal.any([signal, AbortSignal.timeout(20 * 60_000)]),
        onOutput: (output) => this.change({ output }),
      });
      const build = await readlink(join(installation.root, "prepared"));
      if (build !== join(installation.root, "builds", commit))
        throw new Error("The prepared update has an unexpected location.");
      const metadata = await readInstallation(join(build, "Scope.app/Contents/Resources/app"));
      if (metadata.commit !== commit || metadata.root !== installation.root)
        throw new Error("The prepared update has a different commit or installation directory.");
      this.prepared = build;
      this.change({
        phase: "ready",
        message: "Update ready. Restart when you are ready.",
        output: undefined,
      });
    } catch (error) {
      this.change({
        phase: signal.aborted ? "idle" : "error",
        message: signal.aborted
          ? "Update canceled. You can check again."
          : "Could not prepare the update. Scope is still using the current version.",
        output: error instanceof Error ? error.message : "Try checking again.",
      });
    }
  }

  async activate(): Promise<string> {
    if (!this.installation || !this.prepared || this.value.phase !== "ready")
      throw new Error("No update is ready.");
    const application = await activateBuild(this.installation.root, this.prepared);
    return join(application, "Contents/MacOS/Scope");
  }

  async cancel() {
    this.controller?.abort();
    await this.pending;
  }

  async prune() {
    if (this.installation) await pruneBuilds(this.installation);
  }
}
