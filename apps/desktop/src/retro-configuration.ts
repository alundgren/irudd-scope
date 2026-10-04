import { hostname } from "node:os";
import type { RetroConfiguration } from "@irudd-scope/protocol/retro";
import type { Remote } from "./remote-contract.ts";

export function machineRetroConfiguration(
  saved: RetroConfiguration,
  remotes: ReadonlyArray<Remote>,
): RetroConfiguration {
  const local =
    saved.sources.find((source) => source.location?.type === "desktop") ??
    saved.sources.find((source) => source.id === "local" && source.sshAlias === null) ??
    saved.sources.find((source) => !source.location && source.sshAlias === null);
  const machines = [
    {
      id: local?.id ?? "local",
      name: "This machine",
      location: { type: "desktop" as const, hostname: hostname() },
      sshAlias: null,
    },
    ...remotes.map((remote) => {
      const prior = saved.sources.find(
        (source) =>
          (source.location?.type === "remote" && source.location.remoteId === remote.id) ||
          source.id === remote.id,
      );
      return {
        id: prior?.id ?? remote.id,
        name: remote.name,
        location: { type: "remote" as const, remoteId: remote.id, endpoint: remote.endpoint },
        sshAlias: prior?.sshAlias ?? null,
      };
    }),
  ];
  const sources = machines.map((machine) => {
    const prior = saved.sources.find((source) => source.id === machine.id);
    return {
      included: prior?.included ?? true,
      runtimes: prior?.runtimes ?? ["codex" as const, "claude" as const],
      runtimeRoots: prior?.runtimeRoots ?? { codex: null, claude: null },
      ...machine,
    };
  });
  return {
    ...saved,
    sources,
    memory: {
      ...saved.memory,
      destinations: saved.memory.destinations.filter((destination) =>
        sources.some((source) => source.id === destination.sourceId),
      ),
    },
  };
}
