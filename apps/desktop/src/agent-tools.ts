import {
  access,
  appendFile,
  copyFile,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { installationAppDirectory, type Installation } from "./installation-files.ts";
import { isWindowsLauncher } from "./windows-installation.ts";
import { runInstallationCommand, windowsPowerShell } from "./installation-process.ts";
import type { AgentToolStatus } from "./installation-contract.ts";
import { AgentSkills } from "./agent-skills.ts";

const PATH_ENTRY = '\n# Scope CLI\nexport PATH="$HOME/.local/bin:$PATH"\n';

export class AgentTools {
  private value: AgentToolStatus;
  private controller?: AbortController;
  private pending?: Promise<AgentToolStatus>;

  isBusy() {
    return this.value.busy !== null;
  }

  constructor(
    private readonly installation: Installation | undefined,
    private readonly home: string,
    private readonly onChange: (status: AgentToolStatus) => void,
  ) {
    this.value = {
      available: Boolean(installation),
      cliInstalled: false,
      cliPath:
        installation?.platform === "win32"
          ? join(installation.root, "bin/irudd-scope.exe")
          : join(home, ".local/bin/irudd-scope"),
      skillInstalled: false,
      busy: null,
      message: "",
    };
  }

  private cliTarget() {
    return join(
      installationAppDirectory(
        join(this.installation!.root, "current"),
        this.installation!.platform,
      ),
      "bin",
      this.installation!.platform === "win32" ? "irudd-scope.exe" : "irudd-scope",
    );
  }

  private windowsPath(action: "add" | "remove", signal: AbortSignal) {
    return runInstallationCommand(
      windowsPowerShell(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(
          installationAppDirectory(join(this.installation!.root, "current"), "win32"),
          "windows-cli-path.ps1",
        ),
        "-Directory",
        dirname(this.value.cliPath),
        "-Action",
        action,
      ],
      { cwd: this.installation!.root, signal },
    );
  }
  async snapshot(): Promise<AgentToolStatus> {
    this.value.cliInstalled = Boolean(
      this.installation &&
      (this.installation.platform === "win32"
        ? await isWindowsLauncher(this.value.cliPath, "CLI")
        : await readlink(this.value.cliPath).then(
            (value) => value === this.cliTarget(),
            () => false,
          )),
    );
    this.value.skillInstalled = Boolean(
      this.installation &&
      (await this.skills()
        .installed()
        .catch(() => false)),
    );
    return { ...this.value };
  }

  private run(tool: "cli" | "skill", action: (signal: AbortSignal) => Promise<string>) {
    if (!this.installation)
      return Promise.reject(new Error("Install Scope to manage agent tools."));
    if (this.pending) return this.pending;
    this.controller = new AbortController();
    this.value = { ...this.value, busy: tool, message: "", error: undefined };
    this.onChange({ ...this.value });
    this.pending = action(this.controller.signal)
      .then(
        (message) => {
          this.value.message = message;
        },
        (error: unknown) => {
          this.value.error =
            error instanceof Error ? error.message : "Installation failed. Try again.";
        },
      )
      .then(async () => {
        this.value.busy = null;
        this.pending = undefined;
        this.controller = undefined;
        const value = await this.snapshot();
        this.onChange(value);
        return value;
      });
    return this.pending;
  }

  installCli() {
    return this.run("cli", async (signal) => {
      const target = this.cliTarget();
      await access(target);
      await mkdir(dirname(this.value.cliPath), { recursive: true });
      if (this.installation!.platform === "win32") {
        let created = false;
        try {
          try {
            await copyFile(target, this.value.cliPath, constants.COPYFILE_EXCL);
            created = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (!(await isWindowsLauncher(this.value.cliPath, "CLI")))
              throw new Error(
                `${this.value.cliPath} already exists. Move it aside before installing Scope's CLI.`,
              );
          }
          await this.windowsPath("add", signal);
        } catch (error) {
          if (created) await rm(this.value.cliPath);
          throw error;
        }
        return "CLI installed. Open a new terminal to use irudd-scope.";
      }
      try {
        await symlink(target, this.value.cliPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if ((await readlink(this.value.cliPath).catch(() => "")) !== target)
          throw new Error(
            `${this.value.cliPath} already exists. Move it aside before installing Scope's CLI.`,
          );
      }
      const shell = process.env.SHELL ?? "/bin/zsh";
      if (shell.endsWith("/zsh") || shell.endsWith("/bash")) {
        const profile = join(this.home, shell.endsWith("/bash") ? ".bash_profile" : ".zprofile");
        const contents = await readFile(profile, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return "";
        });
        if (!contents.includes(PATH_ENTRY)) await appendFile(profile, PATH_ENTRY);
        return "CLI installed. Open a new terminal to use irudd-scope.";
      }
      return "CLI installed. Add ~/.local/bin to your shell's PATH to use irudd-scope.";
    });
  }

  removeCli() {
    return this.run("cli", async (signal) => {
      if (this.installation!.platform === "win32") {
        if (!(await isWindowsLauncher(this.value.cliPath, "CLI")))
          throw new Error("This CLI was not installed by Scope.");
        await this.windowsPath("remove", signal);
        await rm(this.value.cliPath);
        return "CLI removed.";
      }
      if ((await readlink(this.value.cliPath).catch(() => "")) !== this.cliTarget())
        throw new Error("This CLI was not installed by Scope.");
      await unlink(this.value.cliPath);
      return "CLI removed.";
    });
  }

  installSkill() {
    return this.run("skill", () => this.skills().install());
  }
  removeSkill() {
    return this.run("skill", () => this.skills().remove());
  }
  syncSkills() {
    if (!this.installation) return this.snapshot();
    return this.run("skill", () => this.skills().sync());
  }
  private skills() {
    return new AgentSkills(this.installation!.root, this.home, this.installation!.platform);
  }

  async cancel() {
    this.controller?.abort();
    await this.pending;
  }
}
