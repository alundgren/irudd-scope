import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { HubUpdateRequest, type HubUpdateStatus } from "@irudd-scope/protocol/remote";
import { decode } from "@irudd-scope/protocol";
import type { HubState } from "./state.ts";
import { runSkillCommand, type Installation } from "./installation.ts";

const exec = promisify(execFile);
export const updateUnit = "irudd-scope-update.service";

export class HubUpdates {
  private pending = Promise.resolve();
  private launching = false;

  constructor(
    private readonly state: HubState,
    readonly installation: Installation | undefined,
    private readonly directory: string,
  ) {}

  async snapshot(): Promise<HubUpdateStatus> {
    if (!this.installation || process.platform !== "linux")
      return {
        supported: false,
        phase: "idle",
        message: "Remote updates require the standalone installation and a Linux user service.",
      };
    let saved = this.state.updateStatus();
    if (saved && ["building", "restarting"].includes(saved.phase) && !this.launching) {
      const running = await exec("systemctl", ["--user", "is-active", "--quiet", updateUnit], {
        timeout: 5000,
      }).then(
        () => true,
        () => false,
      );
      if (!running) {
        saved = {
          ...saved,
          phase: this.installation.commit === saved.targetCommit ? "idle" : "error",
          message:
            this.installation.commit === saved.targetCommit
              ? "Remote tools are up to date."
              : "The remote update was interrupted. Retry the update.",
        };
        this.state.saveUpdate(saved);
      }
    }
    const status: HubUpdateStatus = {
      supported: true,
      phase: "idle",
      message: "Remote tools are ready.",
      ...saved,
      currentCommit: this.installation.commit,
    };
    if (!["building", "restarting"].includes(status.phase)) {
      try {
        const installed = await runSkillCommand(this.installation, "check");
        if (!installed && status.phase === "idle")
          return {
            ...status,
            message:
              "Remote tools are ready. The Scope skill is not installed. Run irudd-scope skill install on the remote to enable it.",
          };
      } catch (error) {
        return {
          ...status,
          phase: "error",
          message: "The installed Scope skill needs attention. See details, then Retry update.",
          output:
            error instanceof Error ? error.message : "Could not check the installed Scope skill.",
        };
      }
    }
    return status;
  }

  request(value: HubUpdateRequest) {
    const input = decode(HubUpdateRequest, value);
    const task = this.pending.then(() => this.start(input));
    this.pending = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  private async start(input: HubUpdateRequest) {
    const status = await this.snapshot();
    if (!status.supported || !this.installation) return status;
    if (["building", "restarting"].includes(status.phase)) return status;
    if (status.currentCommit === input.commit && status.phase !== "error" && !input.retry)
      return status;
    const saved = this.state.updateStatus();
    if (saved?.phase === "error" && saved.targetCommit === input.commit && !input.retry)
      return status;
    const servicePid = await exec(
      "systemctl",
      ["--user", "show", "--property=MainPID", "--value", "irudd-scope-hub.service"],
      { timeout: 5000 },
    ).then(
      (result) => result.stdout.trim(),
      () => "",
    );
    if (servicePid !== String(process.pid))
      return {
        ...status,
        supported: false,
        message:
          "Run irudd-scope setup on this remote so updates can restart its managed hub service.",
      };
    const next: HubUpdateStatus = {
      supported: true,
      phase: "building",
      currentCommit: this.installation.commit,
      targetCommit: input.commit,
      message:
        status.currentCommit === input.commit
          ? "Checking and repairing the installed Scope skill…"
          : "Building the hub, CLI, and skill to match this Mac…",
    };
    this.launching = true;
    this.state.saveUpdate(next);
    try {
      await exec(
        "systemd-run",
        [
          "--user",
          "--collect",
          `--unit=${updateUnit}`,
          "--service-type=exec",
          "--property=RuntimeMaxSec=1200",
          "--property=TimeoutStopSec=30",
          "--property=UMask=0077",
          "--property=NoNewPrivileges=true",
          `--setenv=SCOPE_HUB_DATA_DIR=${this.directory}`,
          `--setenv=PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
          "flock",
          "--nonblock",
          "--no-fork",
          join(this.installation.root, ".installation.lock"),
          process.execPath,
          resolve(import.meta.dirname, "update-runner.mjs"),
          input.commit,
        ],
        { timeout: 15_000, maxBuffer: 4096 },
      );
    } catch {
      this.state.saveUpdate({
        ...next,
        phase: "error",
        message: "Could not start the remote updater. Check the systemd user service and retry.",
      });
    } finally {
      this.launching = false;
    }
    return this.snapshot();
  }

  async close() {
    await this.pending;
  }
}
