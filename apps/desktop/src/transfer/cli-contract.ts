export const MAX_REQUEST_BYTES = 16 * 1024;
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
export const validAddress = (value: unknown): value is string =>
  typeof value === "string" && /^tc[A-Za-z0-9_-]{38,4094}$/.test(value);
export const validPort = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
export const validBody = (value: unknown, limit: number): value is string =>
  typeof value === "string" && Buffer.byteLength(value) <= limit;

export type CliCommand =
  | { mode: "listen"; binary?: string }
  | { mode: "request"; binary?: string; address: string; port: number; body: string };
export type CliInput =
  | { type: "start"; command: CliCommand }
  | { type: "response"; id: number; body: string }
  | { type: "handler-error"; id: number };
export type CliOutput =
  | { type: "listening"; address: string; port: number }
  | { type: "request"; id: number; body: string }
  | { type: "result"; body: string }
  | { type: "error"; error: "missing" | "unavailable" };

export const transportError = () =>
  new Error(
    "Tailcat could not start or disconnected. Tab transfers require a compatible Tailcat CLI.",
  );
export const missingTailcatError = () =>
  new Error("Tab transfers require the Tailcat CLI installed separately on this Mac.");
