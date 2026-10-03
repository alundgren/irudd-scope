import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { SavedCredential } from "./credentials.ts";

async function post(origin: string, path: string, input: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  return { response, value: (await response.json()) as Record<string, unknown> };
}
function openBrowser(url: string) {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const child = spawn(
    command,
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url],
    { detached: true, stdio: "ignore" },
  );
  child.on("error", () => {
    process.stderr.write("Open the approval URL above in your browser.\n");
  });
  child.unref();
}
export async function login(
  endpoint: string,
  agent: string,
  noBrowser: boolean,
): Promise<SavedCredential> {
  const origin = new URL(endpoint).origin;
  const { response, value: pairing } = await post(origin, "/auth/pairing", {
    resource: endpoint,
    agent,
  });
  if (!response.ok) throw new Error(String(pairing.error_description ?? pairing.error));
  const input = { pairing_id: pairing.pairing_id, pairing_secret: pairing.pairing_secret };
  process.stdout.write(
    `Approve ${agent} in your browser.\nCode: ${String(pairing.user_code)}\n${String(pairing.verification_uri)}\n`,
  );
  if (!noBrowser) openBrowser(String(pairing.verification_uri));
  let cancelled = false;
  let redeemed = false;
  const abort = new AbortController();
  const cancel = () => {
    cancelled = true;
    abort.abort();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const deadline = Date.now() + Number(pairing.expires_in) * 1000;
  let interval = Number(pairing.interval) * 1000;
  try {
    while (Date.now() < deadline && !cancelled) {
      await delay(interval, undefined, { signal: abort.signal });
      let value: Record<string, unknown>;
      try {
        ({ value } = await post(origin, "/auth/pairing/poll", input));
      } catch {
        process.stderr.write("Waiting for the server to reconnect.\n");
        continue;
      }
      if (typeof value.access_token === "string") {
        redeemed = true;
        return {
          endpoint,
          token: value.access_token,
          expires: Date.now() + Number(value.expires_in) * 1000,
        };
      }
      if (value.error === "authorization_pending") continue;
      if (value.error === "slow_down") {
        interval = Number(value.interval) * 1000;
        continue;
      }
      throw new Error(
        value.error === "access_denied"
          ? "Browser authorization was denied or cancelled."
          : "Authorization expired. Run login again.",
      );
    }
    throw new Error("Authorization expired. Run login again.");
  } catch (error) {
    if (cancelled) throw new Error("Login cancelled.");
    throw error;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    if (!redeemed) await post(origin, "/auth/pairing/cancel", input).catch(() => undefined);
  }
}
