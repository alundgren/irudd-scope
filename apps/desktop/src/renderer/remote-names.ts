import { useEffect, useState } from "react";
import type { RemoteStatus } from "../remote-contract.ts";

/** Paired remotes by ID, kept current while Scope runs. */
export function useRemotes(): ReadonlyMap<string, RemoteStatus> {
  const [remotes, setRemotes] = useState<ReadonlyMap<string, RemoteStatus>>(new Map());
  useEffect(() => {
    let active = true;
    let received = false;
    const receive = (status: RemoteStatus[]) => {
      if (active) setRemotes(new Map(status.map((remote) => [remote.id, remote])));
    };
    const stop = window.scope.onRemotesChange((status) => {
      received = true;
      receive(status);
    });
    void window.scope
      .remotes()
      .then((status) => {
        if (!received) receive(status);
      })
      .catch(() => {});
    return () => {
      active = false;
      stop();
    };
  }, []);
  return remotes;
}

/** The name people use for this computer in machine labels. */
export function localMachineName(platform: string): string {
  return platform === "darwin" ? "This Mac" : platform === "win32" ? "This PC" : "This computer";
}
