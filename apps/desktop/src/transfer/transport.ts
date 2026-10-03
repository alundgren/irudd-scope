import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import {
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  missingTailcatError,
  transportError,
  validAddress,
  validBody,
  validPort,
  type CliCommand,
  type CliInput,
  type CliOutput,
} from "./cli-contract.ts";

export interface TransferTransport {
  listen(handler: (body: string) => Promise<string>): Promise<{
    address: string;
    port: number;
    close: () => Promise<void>;
  }>;
  request(address: string, port: number, body: string): Promise<string>;
}

function send(child: ChildProcess, message: CliInput) {
  if (child.connected) child.send(message, () => {});
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    if (child.connected) child.disconnect();
  });
}

export class TailcatCliTransport implements TransferTransport {
  constructor(
    private readonly binary?: string,
    private readonly supervisor = join(import.meta.dirname, "cli-process.mjs"),
  ) {}

  private start(command: CliCommand) {
    const child = fork(this.supervisor, [], {
      execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= stop(child));
    const result = new Promise<CliOutput>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          reject(transportError());
          void close();
        },
        command.mode === "listen" ? 40_000 : 70_000,
      );
      const fail = (error = transportError()) => {
        clearTimeout(timer);
        reject(error);
        void close();
      };
      child.once("error", () => fail());
      child.once("exit", () => fail());
      child.on("message", (input: unknown) => {
        if (!input || typeof input !== "object" || !("type" in input)) return fail();
        const message = input as CliOutput;
        if (message.type === "error")
          return fail(message.error === "missing" ? missingTailcatError() : transportError());
        if (message.type === "request") return;
        if (
          (command.mode === "listen" &&
            message.type === "listening" &&
            validAddress(message.address) &&
            validPort(message.port)) ||
          (command.mode === "request" &&
            message.type === "result" &&
            validBody(message.body, MAX_RESPONSE_BYTES))
        ) {
          clearTimeout(timer);
          resolve(message);
        } else fail();
      });
    });
    return { child, close, result, begin: () => send(child, { type: "start", command }) };
  }

  async listen(handler: (body: string) => Promise<string>) {
    const worker = this.start({ mode: "listen", binary: this.binary });
    let active = 0;
    worker.child.on("message", (input: unknown) => {
      if (!input || typeof input !== "object" || !("type" in input)) return;
      const message = input as CliOutput;
      if (message.type !== "request") return;
      if (
        !Number.isSafeInteger(message.id) ||
        !validBody(message.body, MAX_REQUEST_BYTES) ||
        active >= 4
      ) {
        void worker.close();
        return;
      }
      active++;
      void handler(message.body)
        .then((body) => {
          if (!validBody(body, MAX_RESPONSE_BYTES)) throw transportError();
          send(worker.child, { type: "response", id: message.id, body });
        })
        .catch(() => send(worker.child, { type: "handler-error", id: message.id }))
        .finally(() => active--);
    });
    worker.begin();
    try {
      const message = await worker.result;
      if (message.type !== "listening") throw transportError();
      return { address: message.address, port: message.port, close: worker.close };
    } catch (error) {
      await worker.close();
      throw error;
    }
  }

  async request(address: string, port: number, body: string) {
    if (!validAddress(address) || !validPort(port) || !validBody(body, MAX_REQUEST_BYTES))
      throw new Error("Invalid Scope transfer request.");
    const worker = this.start({ mode: "request", binary: this.binary, address, port, body });
    worker.begin();
    try {
      const message = await worker.result;
      if (message.type !== "result") throw transportError();
      return message.body;
    } finally {
      await worker.close();
    }
  }
}
