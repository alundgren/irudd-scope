import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { readFile, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { decode, decodeLocalConnection } from "@irudd-scope/protocol";
import { BuildCommit, HubStatus, readRemoteJson } from "@irudd-scope/protocol/remote";
import { HubState } from "./state.ts";
import {
  InstalledSkillError,
  readInstallation,
  runSkillCommand,
  selectBuild,
  type Installation,
} from "./installation.ts";

const exec = promisify(execFile);
const commit = decode(BuildCommit, process.argv[2]);
const installation = await readInstallation();
if (!installation) throw new Error("The remote updater requires a managed installation.");
const directory = process.env.SCOPE_HUB_DATA_DIR;
if (!directory) throw new Error("The hub data directory is missing.");
const state = await HubState.open(directory);
const cancellation = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => cancellation.abort());

function progress(
  phase: "building" | "restarting" | "idle" | "error",
  message: string,
  output?: string,
) {
  state.saveUpdate({
    supported: true,
    phase,
    currentCommit: installation!.commit,
    targetCommit: commit,
    message: message.slice(-2048),
    ...(output ? { output: stripVTControlCharacters(output).slice(-8192) } : {}),
  });
  console.log(message);
  if (output) console.error(stripVTControlCharacters(output).slice(-8192));
}

async function restart() {
  await exec("systemctl", ["--user", "restart", "irudd-scope-hub.service"], { timeout: 15_000 });
}

async function waitForCommit(expected: string) {
  const connection = decodeLocalConnection(
    JSON.parse(await readFile(state.configuration().connectionFile, "utf8")),
  );
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await fetch(`${connection.endpoint}/v1/hub/status`, {
      headers: { Authorization: `Bearer ${connection.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(1000),
    })
      .then(async (response) =>
        response.ok ? decode(HubStatus, await readRemoteJson(response)) : undefined,
      )
      .catch(() => undefined);
    if (status?.commit === expected) return;
    await delay(250);
  }
  throw new Error("The replacement hub did not become ready.");
}

let previous: string | undefined;
let activated = false;
async function prepareAndRestart(installation: Installation, previous: string) {
  progress("building", "Building the hub, CLI, and skill to match this Mac…");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    SCOPE_CLI_INSTALL_ROOT: installation.root,
    SCOPE_CLI_BIN_DIR: installation.bin,
    SCOPE_CLI_CURRENT_COMMIT: installation.commit,
    SCOPE_CLI_LOCK_HELD: "1",
    SCOPE_VP: installation.vp,
    GIT_TERMINAL_PROMPT: "0",
  };
  delete environment.SCOPE_CLI_SOURCE;
  await exec(
    "/bin/bash",
    [resolve(import.meta.dirname, "../install-cli.sh"), "--prepare", commit],
    {
      env: environment,
      timeout: 18 * 60_000,
      signal: cancellation.signal,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  cancellation.signal.throwIfAborted();
  const prepared = await readlink(join(installation.root, "prepared"));
  const metadata = await readInstallation(prepared);
  if (metadata?.root !== installation.root || metadata.commit !== commit)
    throw new Error("The prepared remote build does not match the requested commit.");
  // This worker runs in its own systemd unit so replacing the hub cannot kill it.
  progress("restarting", "Restarting the hub with the updated remote tools…");
  await selectBuild(installation.root, "previous", previous);
  await selectBuild(installation.root, "current", prepared);
  activated = true;
  await restart();
  await waitForCommit(commit);
}

try {
  previous = await readlink(join(installation.root, "current"));
  const current = await readInstallation(previous);
  if (current?.commit !== installation.commit)
    throw new Error("The installation changed. Reconnect before retrying the update.");
  if (commit !== installation.commit) await prepareAndRestart(installation, previous);
  progress("building", "Checking and repairing the installed Scope skill…");
  const installed = await runSkillCommand(installation, "sync");
  progress(
    "idle",
    installed
      ? "Remote tools and the installed Scope skill are up to date. Refresh or start a new agent session to reload skill guidance."
      : "Remote tools are up to date. The Scope skill is not installed. Run irudd-scope skill install on the remote to enable it.",
  );
} catch (error) {
  const output = error instanceof Error ? error.message : String(error);
  let message = output.includes("Update the Mac first.")
    ? "The remote has a newer or different version. Update the Mac first."
    : "The remote update failed. Retry the update.";
  if (error instanceof InstalledSkillError) {
    message = "The installed Scope skill needs attention. See details, then Retry update.";
  } else if (activated && previous) {
    try {
      await selectBuild(installation.root, "current", previous);
      await restart();
      await waitForCommit(installation.commit);
      message = "The previous remote tools were restored. Retry the update.";
    } catch {
      message = "The hub could not restart. Run irudd-scope setup on the remote.";
    }
  }
  progress("error", message, output);
  process.exitCode = 1;
} finally {
  state.close();
}
