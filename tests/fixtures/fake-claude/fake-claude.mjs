// A stand-in for the claude program in tests. It speaks the stream-json protocol the Claude
// Agent SDK uses, from shapes in recording.json, and never reaches a model or the network.
//
// FAKE_CLAUDE_LOG     file that gets one JSON line per thing the fake received
// FAKE_CLAUDE_ACCOUNT_FILE file holding "plan" (the default) or "api-key", read at start
//
// What the person writes picks the turn: "command" asks to run Bash, "file" asks to write a
// file, "long" waits until Stop, "forever" never ends, and anything else gets a short reply.
import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("2.1.325 (Claude Code)");
  process.exit(0);
}
const recording = JSON.parse(readFileSync(new URL("./recording.json", import.meta.url), "utf8"));
const log = (entry) => {
  if (process.env.FAKE_CLAUDE_LOG)
    appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(entry)}\n`);
};
log({ event: "start", args, cwd: process.cwd() });

const resumed = args.find((arg) => arg.startsWith("--resume="))?.slice("--resume=".length);
const session = resumed ?? randomUUID();
const login = process.env.FAKE_CLAUDE_ACCOUNT_FILE
  ? readFileSync(process.env.FAKE_CLAUDE_ACCOUNT_FILE, "utf8").trim()
  : "plan";
const account =
  login === "api-key"
    ? { apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" }
    : { email: "person@example.com", subscriptionType: "Claude Max", apiProvider: "firstParty" };

const fill = (template, values) =>
  JSON.parse(JSON.stringify(template), (_key, value) =>
    typeof value === "string" && value in values ? values[value] : value,
  );
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const base = { SESSION_ID: session, UUID: randomUUID(), CWD: process.cwd() };

const waiting = new Map();
function ask(request) {
  const id = randomUUID();
  send({ type: "control_request", request_id: id, request });
  return new Promise((resolve) => waiting.set(id, resolve));
}
let interrupted;

async function useTool(name, input, output) {
  const tool = `toolu_${randomUUID().slice(0, 12)}`;
  send(fill(recording.toolUse, { ...base, TOOL_ID: tool, TOOL_NAME: name, TOOL_INPUT: input }));
  const answer = await ask({
    subtype: "can_use_tool",
    tool_name: name,
    input,
    tool_use_id: tool,
  });
  const allowed = answer?.behavior === "allow";
  log({ event: "approval", tool: name, behavior: answer?.behavior ?? "none" });
  send(
    fill(recording.toolResult, {
      ...base,
      TOOL_ID: tool,
      TOOL_OUTPUT: allowed ? output : "The person denied this.",
      IS_ERROR: !allowed,
    }),
  );
  return allowed;
}

function reply(text) {
  send(fill(recording.text, { ...base, MESSAGE_ID: `msg_${randomUUID()}`, TEXT: text }));
}
function finish(text, stopped = false) {
  send(
    stopped
      ? {
          ...fill(recording.result, { ...base, TEXT: "" }),
          subtype: "error_during_execution",
          is_error: true,
          errors: [],
        }
      : fill(recording.result, { ...base, TEXT: text }),
  );
}

async function turn(text) {
  send(fill(recording.init, base));
  if (text.includes("command")) {
    const ran = await useTool(
      "Bash",
      { command: "echo hello", description: "Print hello" },
      "hello",
    );
    reply(ran ? "It printed hello." : "I didn't run it.");
    return finish("done");
  }
  if (text.includes("file")) {
    const wrote = await useTool(
      "Write",
      { file_path: "notes.txt", content: "hi" },
      "Wrote notes.txt",
    );
    reply(wrote ? "I wrote notes.txt." : "I didn't write it.");
    return finish("done");
  }
  if (text.includes("long") || text.includes("forever")) {
    reply("Counting slowly…");
    await new Promise((resolve) => (interrupted = text.includes("long") ? resolve : undefined));
    return finish("", true);
  }
  reply(`Fake reply to: ${text}`);
  finish("done");
}

let turns = Promise.resolve();
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_response") {
    const resolve = waiting.get(message.response.request_id);
    waiting.delete(message.response.request_id);
    resolve?.(message.response.response);
    return;
  }
  if (message.type === "control_request") {
    log({ event: "control", subtype: message.request.subtype });
    if (message.request.subtype === "initialize")
      send(
        fill(recording.initialize, {
          REQUEST_ID: message.request_id,
          ACCOUNT: account,
        }),
      );
    else {
      send({
        type: "control_response",
        response: { subtype: "success", request_id: message.request_id, response: {} },
      });
      if (message.request.subtype === "interrupt") interrupted?.();
    }
    return;
  }
  if (message.type === "user") {
    const text = typeof message.message.content === "string" ? message.message.content : "";
    log({ event: "message", text, session });
    turns = turns.then(() => turn(text));
  }
});
lines.on("close", () => {
  log({ event: "exit" });
  process.exit(0);
});
