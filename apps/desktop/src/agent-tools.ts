import { access, appendFile, mkdir, readFile, readlink, symlink, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Installation } from "./installation-files.ts";
import { runInstallationCommand } from "./installation-process.ts";
import type { AgentToolStatus } from "./installation-contract.ts";

const SKILLS_PACKAGE = "skills@1.7.0";
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
      cliPath: join(home, ".local/bin/irudd-scope"),
      skillInstalled: false,
      busy: null,
      message: "",
    };
  }

  private cliTarget() {
    return join(
      this.installation!.root,
      "current/Scope.app/Contents/Resources/app/bin/irudd-scope",
    );
  }
  async snapshot(): Promise<AgentToolStatus> {
    this.value.cliInstalled = Boolean(
      this.installation &&
      (await readlink(this.value.cliPath).then(
        (value) => value === this.cliTarget(),
        () => false,
      )),
    );
    this.value.skillInstalled = await access(
      join(this.home, ".agents/skills/irudd-scope/SKILL.md"),
    ).then(
      () => true,
      () => false,
    );
    return { ...this.value };
  }

  private run(tool: "cli" | "skill", action: (signal: AbortSignal) => Promise<string>) {
    if (!this.installation)
      return Promise.reject(new Error("Install the Mac app to manage agent tools."));
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
    return this.run("cli", async () => {
      const target = this.cliTarget();
      await access(target);
      await mkdir(dirname(this.value.cliPath), { recursive: true });
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
    return this.run("cli", async () => {
      if ((await readlink(this.value.cliPath).catch(() => "")) !== this.cliTarget())
        throw new Error("This CLI was not installed by Scope.");
      await unlink(this.value.cliPath);
      return "CLI removed.";
    });
  }

  installSkill() {
    return this.skillCommand(
      ["add", "alundgren/irudd-scope", "--skill", "irudd-scope"],
      "Skill installed globally for Codex and Claude Code.",
    );
  }
  removeSkill() {
    return this.skillCommand(
      ["remove", "irudd-scope"],
      "Scope skill removed from Codex and Claude Code.",
    );
  }
  private skillCommand(args: string[], success: string) {
    return this.run("skill", async (signal) => {
      // npm rejects the clone's pnpm devEngines, so its project directory is the install root.
      await runInstallationCommand(
        this.installation!.vp,
        [
          "exec",
          "npx",
          "--prefix",
          this.installation!.root,
          "--yes",
          SKILLS_PACKAGE,
          ...args,
          "--global",
          "--agent",
          "codex",
          "claude-code",
          "--yes",
        ],
        {
          cwd: join(this.installation!.root, "source"),
          signal: AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]),
          env: { DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" },
        },
      );
      return success;
    });
  }

  async cancel() {
    this.controller?.abort();
    await this.pending;
  }
}
