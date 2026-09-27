import { readlink } from "node:fs/promises";
import { join } from "node:path";
import {
  activateBuild,
  installationBuildDirectory,
  pruneBuilds,
  readInstallation,
  type Installation,
} from "./installation-files.ts";
import { runInstallationCommand } from "./installation-process.ts";
import type { UpdateStatus } from "./installation-contract.ts";
import { findSigningCertificate } from "./signing.ts";

export class AppUpdates {
  private value: UpdateStatus;
  private controller?: AbortController;
  private pending?: Promise<void>;
  private prepared?: string;

  constructor(
    private readonly installation: Installation | undefined,
    private readonly installer: string,
    private readonly onChange: (status: UpdateStatus) => void,
    private readonly findCertificate = findSigningCertificate,
  ) {
    this.value = installation
      ? {
          phase: "idle",
          message: "Updates are checked when Scope opens.",
          currentCommit: installation.commit,
          currentSigningIdentity: installation.signingIdentity,
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
    const installation = this.installation;
    return this.start("update", (signal) => this.prepareUpdate(installation, signal));
  }

  async signingCertificate() {
    const identity = this.installation?.signingIdentity;
    return identity ? this.findCertificate(identity, AbortSignal.timeout(15_000)) : undefined;
  }

  setSigningCertificate(reference: string | null): Promise<void> {
    if (!this.installation)
      throw new Error("Certificate signing is available in the installed Mac app.");
    if (this.pending) throw new Error("Wait for the current build to finish, or cancel it first.");
    const installation = this.installation;
    const commit = this.value.phase === "ready" ? this.value.nextCommit! : installation.commit;
    return this.start("signing", async (signal) => {
      const certificate =
        reference === null ? undefined : await this.findCertificate(reference, signal);
      this.change({ nextSigningCertificate: certificate });
      await this.prepareBuild(
        { ...installation, commit, signingIdentity: certificate?.fingerprint },
        signal,
      );
    });
  }

  private start(
    operation: "update" | "signing",
    prepare: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.prepared = undefined;
    this.change({
      operation,
      phase: "checking",
      message:
        operation === "signing"
          ? "Checking the signing certificate…"
          : "Checking main for updates…",
      output: undefined,
      nextCommit: undefined,
      nextSigningCertificate: undefined,
    });
    this.pending = prepare(signal)
      .catch((error: unknown) => {
        this.change({
          phase: signal.aborted ? "idle" : "error",
          message: signal.aborted
            ? "Build canceled. Scope is still using the current app."
            : operation === "signing"
              ? "Could not apply the certificate change. Scope is still using the current app."
              : "Could not prepare the update. Scope is still using the current version.",
          output: error instanceof Error ? error.message : "Try again.",
        });
      })
      .finally(() => {
        this.pending = undefined;
        this.controller = undefined;
      });
    return this.pending;
  }

  private async prepareUpdate(installation: Installation, signal: AbortSignal) {
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
    await this.prepareBuild({ ...installation, commit }, signal);
  }

  private async prepareBuild(installation: Installation, signal: AbortSignal) {
    const { commit } = installation;
    this.change({
      phase: "building",
      message:
        this.value.operation === "signing"
          ? "Building Scope with the selected signing identity…"
          : "Building the update on this Mac…",
      nextCommit: commit,
    });
    await runInstallationCommand("/bin/bash", [this.installer, "--prepare", commit], {
      cwd: join(installation.root, "source"),
      env: {
        SCOPE_INSTALL_ROOT: installation.root,
        SCOPE_VP: installation.vp,
        SCOPE_SIGNING_IDENTITY: installation.signingIdentity ?? "-",
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(20 * 60_000)]),
      onOutput: (output) => this.change({ output }),
    });
    const build = await readlink(join(installation.root, "prepared"));
    if (build !== installationBuildDirectory(installation))
      throw new Error("The prepared update has an unexpected location.");
    const metadata = await readInstallation(join(build, "Scope.app/Contents/Resources/app"));
    if (metadata.commit !== commit || metadata.root !== installation.root)
      throw new Error("The prepared update has a different commit or installation directory.");
    if (metadata.signingIdentity !== installation.signingIdentity)
      throw new Error("The prepared update has a different signing identity.");
    this.prepared = build;
    this.change({
      phase: "ready",
      message:
        this.value.operation === "signing"
          ? "Certificate change ready. Restart to apply it."
          : "Update ready. Restart when you are ready.",
      output: undefined,
    });
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
    if (this.value.phase === "ready") {
      this.prepared = undefined;
      this.change({
        phase: "idle",
        message: "Prepared change canceled. Scope is still using the current app.",
        nextCommit: undefined,
        nextSigningCertificate: undefined,
        output: undefined,
      });
    }
  }

  async prune() {
    if (this.installation) await pruneBuilds(this.installation);
  }
}
