import { setTimeout as delay } from "node:timers/promises";
import { decode, validateEndpoint } from "@irudd-scope/protocol";
import { HubUpdateStatus, readRemoteJson } from "@irudd-scope/protocol/remote";

export async function synchronizeRemote(
  endpoint: string,
  token: string,
  commit: string,
  signal: AbortSignal,
  onChange: (status: HubUpdateStatus) => void,
  retry = false,
) {
  const url = `${validateEndpoint(endpoint)}/v1/relay/update`;
  async function request(update = false): Promise<HubUpdateStatus> {
    const response = await fetch(url, {
      method: update ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(update ? { body: JSON.stringify({ commit, retry }) } : {}),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return {
        supported: false,
        phase: "idle",
        message:
          "Run the standalone installer and irudd-scope setup once on this remote to enable automatic updates.",
      };
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Could not check or update remote tools. Retry the update.");
    }
    return decode(HubUpdateStatus, await readRemoteJson(response, 65_536));
  }
  try {
    let requested = false;
    while (!signal.aborted) {
      let status = await request();
      const busy = status.phase === "building" || status.phase === "restarting";
      if (status.supported && !busy) {
        if (status.currentCommit === commit) {
          onChange({
            ...status,
            phase: "idle",
            message: "Remote tools match this Mac.",
            output: undefined,
          });
          return;
        }
        if (!requested) {
          requested = true;
          status = await request(true);
        }
      }
      onChange(status);
      if (!status.supported || !["building", "restarting"].includes(status.phase)) return;
      await delay(2000, undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted)
      onChange({
        supported: true,
        phase: "error",
        message:
          error instanceof Error
            ? error.message.slice(0, 2048)
            : "Could not update remote tools. Retry the update.",
      });
  }
}
