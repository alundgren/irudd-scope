// A stand-in for `codex app-server` in tests. It speaks the app-server's JSON lines from shapes
// in recording.json and never reaches a model or the network.
//
// FAKE_CODEX_LOG          file that gets one JSON line per thing the fake received
// FAKE_CODEX_ACCOUNT_FILE file holding "chatgpt" (the default) or "api-key", read at start
// FAKE_CODEX_SCRIPT       JSON file of turns that call Scope's card tools, in the same form as
//                         the fake claude's: { "words": [{ "call": ..., "arguments": ... }] }
//
// Otherwise what the person writes picks the turn: "command" asks to run a command, "file" asks
// to change a file, "long" waits until Stop, "helper" first finishes a helper agent's turn on
// another thread, and anything else gets a short reply. With "slow", the answer to turn/start
// comes 1.5 seconds late.
import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli 0.169.0");
  process.exit(0);
}
const recording = JSON.parse(readFileSync(new URL("./recording.json", import.meta.url), "utf8"));
const log = (entry) => {
  if (process.env.FAKE_CODEX_LOG)
    appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(entry)}\n`);
};
log({ event: "start", args, cwd: process.cwd() });

const login = process.env.FAKE_CODEX_ACCOUNT_FILE
  ? readFileSync(process.env.FAKE_CODEX_ACCOUNT_FILE, "utf8").trim()
  : "chatgpt";
const account =
  login === "api-key"
    ? { type: "apiKey" }
    : { type: "chatgpt", email: "person@example.com", planType: "pro", workspaceName: null };

const fill = (template, values) =>
  JSON.parse(JSON.stringify(template), (_key, value) =>
    typeof value === "string" && value in values ? values[value] : value,
  );
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

let threadId = "";
let cwd = process.cwd();
let turnId = "";
let next = 0;
const waiting = new Map();
let interrupted;

/** Asks Scope something, the way the app-server asks for approvals and tool calls. */
function ask(template, values) {
  const id = next++;
  send(fill(template, { ...values, REQUEST_ID: id }));
  return new Promise((resolve) => waiting.set(id, resolve));
}

const ids = () => ({ THREAD_ID: threadId, TURN_ID: turnId, CWD: cwd });

function say(text) {
  const item = `msg_${randomUUID()}`;
  const values = { ...ids(), ITEM_ID: item, PHASE: "final_answer" };
  send(fill(recording.messageStarted, values));
  for (const piece of text.match(/.{1,8}/gs) ?? [])
    send(fill(recording.messageDelta, { ...values, TEXT: piece }));
  send(fill(recording.messageCompleted, { ...values, TEXT: text }));
}

let lastRead;
const filled = (value) => {
  if (value === "@version") return lastRead?.version;
  if (typeof value === "string" && value.startsWith("@id:")) {
    const text = value.slice(4);
    return lastRead?.boxes.find((box) => box.text === text)?.id ?? `missing-${text}`;
  }
  if (Array.isArray(value)) return value.map(filled);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, filled(item)]));
  return value;
};

async function cardTool(tool, input) {
  const values = { ...ids(), ITEM_ID: `exec-${randomUUID()}`, TOOL: tool, ARGUMENTS: input };
  send(fill(recording.toolStarted, values));
  const answer = await ask(recording.toolCall, values);
  const text = answer?.result?.contentItems?.[0]?.text ?? JSON.stringify(answer?.error ?? answer);
  const success = answer?.result?.success === true;
  log({ event: "tool-result", tool, text, isError: !success });
  if (tool === "read_diagram" && success) lastRead = JSON.parse(text);
  send(
    fill(recording.toolCompleted, {
      ...values,
      TEXT: text,
      SUCCESS: success,
      STATUS: success ? "completed" : "failed",
    }),
  );
}

async function command() {
  const values = { ...ids(), ITEM_ID: `exec-${randomUUID()}`, COMMAND: "echo hello" };
  send(fill(recording.commandStarted, values));
  const answer = await ask(recording.commandApproval, { ...values, REASON: "Print hello" });
  const decision = answer?.result?.decision ?? "none";
  log({ event: "decision", kind: "command", decision });
  const ran = decision === "accept";
  send(
    fill(recording.commandCompleted, {
      ...values,
      STATUS: ran ? "completed" : "declined",
      OUTPUT: ran ? "hello\n" : null,
    }),
  );
  say(ran ? "It printed hello." : "I didn't run it.");
}

// The app-server's generated types describe these; the recorded session changed no file.
async function fileChange() {
  const item = `call_${randomUUID()}`;
  const change = { path: `${cwd}/notes.txt`, kind: { type: "add" }, diff: "hi\n" };
  const base = { threadId, turnId, startedAtMs: 0 };
  send({
    method: "item/started",
    params: {
      ...base,
      item: { type: "fileChange", id: item, changes: [change], status: "inProgress" },
    },
  });
  const answer = await ask(
    {
      method: "item/fileChange/requestApproval",
      id: "REQUEST_ID",
      params: { threadId, turnId, itemId: item, startedAtMs: 0, reason: null, grantRoot: null },
    },
    {},
  );
  const decision = answer?.result?.decision ?? "none";
  log({ event: "decision", kind: "file", decision });
  const wrote = decision === "accept";
  send({
    method: "item/completed",
    params: {
      ...base,
      completedAtMs: 0,
      item: {
        type: "fileChange",
        id: item,
        changes: [change],
        status: wrote ? "completed" : "declined",
      },
    },
  });
  say(wrote ? "I wrote notes.txt." : "I didn't write it.");
}

function scripted(text) {
  if (!process.env.FAKE_CODEX_SCRIPT) return undefined;
  const script = JSON.parse(readFileSync(process.env.FAKE_CODEX_SCRIPT, "utf8"));
  const key = Object.keys(script).find((words) => text.includes(words));
  return key && script[key];
}

async function turn(text) {
  send(fill(recording.turnStarted, ids()));
  let status = "completed";
  const steps = scripted(text);
  if (steps) {
    for (const step of steps)
      if (step.say) say(step.say);
      else await cardTool(step.call, filled(step.arguments ?? {}));
  } else if (text.includes("command")) await command();
  else if (text.includes("file")) await fileChange();
  else if (text.includes("helper")) {
    const helper = { ...ids(), THREAD_ID: randomUUID(), TURN_ID: randomUUID() };
    send(fill(recording.turnCompleted, { ...helper, STATUS: "completed", ERROR: null }));
    say("The helper finished.");
  } else if (text.includes("long")) {
    say("Counting slowly…");
    await new Promise((resolve) => (interrupted = resolve));
    status = "interrupted";
  } else say(`Fake reply to: ${text}`);
  send(fill(recording.turnCompleted, { ...ids(), STATUS: status, ERROR: null }));
  turnId = "";
}

const answer = (id, result) => send({ id, result });
let turns = Promise.resolve();
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    const resolve = waiting.get(message.id);
    waiting.delete(message.id);
    resolve?.(message);
    return;
  }
  log({ event: "request", method: message.method });
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize":
      return answer(message.id, {
        userAgent: "scope/0.169.0 (Fake OS; x86_64) unknown (scope; 1)",
        codexHome: "CODEX_HOME",
        platformFamily: "unix",
        platformOs: "linux",
      });
    case "initialized":
      return;
    case "account/read":
      return answer(message.id, {
        account,
        requiresOpenaiAuth: true,
        userId: null,
        workspaceRouting: null,
      });
    case "thread/start":
    case "thread/resume":
      threadId = params.threadId ?? randomUUID();
      cwd = params.cwd ?? cwd;
      log({
        event: "thread",
        method: message.method,
        thread: threadId,
        cwd,
        tools: (params.dynamicTools ?? []).map((tool) => tool.name),
      });
      return send(fill(recording.threadStart, { ...ids(), REQUEST_ID: message.id, MODEL: "fake" }));
    case "turn/start": {
      turnId = randomUUID();
      const text = params.input?.[0]?.text ?? "";
      log({ event: "message", text, thread: threadId });
      const reply = fill(recording.turnStart, { ...ids(), REQUEST_ID: message.id });
      if (text.includes("slow")) setTimeout(() => send(reply), 1500);
      else send(reply);
      turns = turns.then(() => turn(text));
      return;
    }
    case "turn/interrupt":
      answer(message.id, {});
      return interrupted?.();
    default:
      return send({ id: message.id, error: { code: -32601, message: "Not in the fake." } });
  }
});
lines.on("close", () => {
  log({ event: "exit" });
  process.exit(0);
});
