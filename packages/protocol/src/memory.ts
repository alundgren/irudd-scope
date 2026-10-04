import { Schema } from "effect";

export const MAX_MEMORY_STATUS_BYTES = 256 * 1024;
export const MEMORY_BUNDLE_NAME = "personal";
export const MEMORY_CONFLICT_BRANCH_PREFIX = "memory-conflict/";

const Message = Schema.String.check(Schema.isMaxLength(2048));
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160));
const Path = Schema.String.check(Schema.isMaxLength(4096));
const Time = Schema.String.check(
  Schema.isMaxLength(40),
  Schema.isPattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/),
);

export const MemoryRepository = Schema.String.check(
  Schema.isMaxLength(140),
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/),
  Schema.makeFilter((value) => !/\/\.\.?$/.test(value), {
    expected: "a GitHub OWNER/NAME repository",
    toJsonSchema: () => ({ type: "string" }),
  }),
);
export type MemoryRepository = typeof MemoryRepository.Type;

export const MemoryConfiguration = Schema.Struct({
  enabled: Schema.Boolean,
  repository: Schema.NullOr(MemoryRepository),
});
export type MemoryConfiguration = typeof MemoryConfiguration.Type;
export const disabledMemory = (): MemoryConfiguration => ({ enabled: false, repository: null });

export const MemoryConflict = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(2048), Schema.isPattern(/^https:\/\//)),
  title: Schema.String.check(Schema.isMaxLength(512)),
  branch: Schema.String.check(Schema.isMaxLength(255)),
});
export type MemoryConflict = typeof MemoryConflict.Type;

export const MemoryMachineStatus = Schema.Struct({
  machine: Name,
  phase: Schema.Literals(["off", "waiting", "syncing", "synced", "error"]),
  message: Message,
  repository: Schema.NullOr(MemoryRepository),
  root: Schema.optionalKey(Path),
  lastSyncAt: Schema.optionalKey(Time),
  bundle: Schema.Literals(["registered", "name-taken", "unavailable"]),
  bundleMessage: Schema.optionalKey(Message),
  okf: Schema.Struct({
    installed: Schema.Boolean,
    version: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
    message: Schema.optionalKey(Message),
  }),
  conflicts: Schema.Array(MemoryConflict).check(Schema.isMaxLength(100)),
});
export type MemoryMachineStatus = typeof MemoryMachineStatus.Type;

export const MemoryMachine = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  name: Name,
  local: Schema.Boolean,
  status: Schema.optionalKey(MemoryMachineStatus),
  message: Schema.optionalKey(Message),
});
export type MemoryMachine = typeof MemoryMachine.Type;

export const MemoryStatus = Schema.Struct({
  configuration: MemoryConfiguration,
  okfInstalled: Schema.Boolean,
  machines: Schema.Array(MemoryMachine).check(Schema.isMaxLength(101)),
  conflicts: Schema.Array(MemoryConflict).check(Schema.isMaxLength(100)),
});
export type MemoryStatus = typeof MemoryStatus.Type;

export const MemoryConnectRequest = Schema.Struct({ repository: MemoryRepository });
export type MemoryConnectRequest = typeof MemoryConnectRequest.Type;

export const MemoryGuide = {
  enable:
    "The operator turns on Memory in Scope Settings on the Mac. irudd-okf must already be installed there. Scope never installs irudd-okf; it upgrades an installed copy daily.",
  create:
    "Suggest personal-memory under the gh account (gh api user --jq .login) and wait for explicit operator acceptance of the exact OWNER/NAME. Stop if gh repo view OWNER/NAME succeeds; never reuse or overwrite an existing repository. Create it only with gh repo create OWNER/NAME --private; never create a public or internal repository. Clone it to a temporary folder, run irudd-okf init in the clone, commit, push the default branch, then run irudd-scope memory connect OWNER/NAME.",
  connect:
    "For an existing repository, confirm the operator owns it and that index.md exists at its root (gh api repos/OWNER/NAME/contents/index.md), then run irudd-scope memory connect OWNER/NAME. Visibility is the operator's choice.",
  sync: "Every machine with Scope clones the repository into ~/.local/share/irudd-scope/memory/NAME, registers it as the irudd-okf bundle named personal, and syncs every five minutes. It commits and pushes only when files changed.",
  conflicts:
    "A conflicting machine pushes its changes to a memory-conflict/HOST-TIME branch, opens a pull request and returns to the default branch. Resolve each pull request in a separate temporary clone, never in Scope's synced folder: merge the default branch into the conflict branch, resolve, push and merge the pull request. Scope never merges conflict pull requests.",
  status:
    "irudd-scope memory status reads the desktop view through the Mac, or this machine's hub status when the Mac is offline.",
};
