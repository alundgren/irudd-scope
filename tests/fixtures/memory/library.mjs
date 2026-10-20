import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const hash = (raw) => createHash("sha256").update(raw).digest("hex");
const output = (value) => process.stdout.write(JSON.stringify(value));
const failure = (message, code = "CONFLICT") => {
  process.stderr.write(JSON.stringify({ version: 1, error: { code, message } }));
  process.exit(2);
};
export function librarianFixture(args, root) {
  if (args[0] === "init") {
    writeFileSync(
      "memory-bundle.json",
      JSON.stringify({ formatVersion: 2, id: randomUUID(), name: "personal" }),
    );
    writeFileSync("index.md", "# Memory\n");
    output({ version: 1 });
    return true;
  }
  if (!root) return false;
  const marker = join(root, "memory-bundle.json");
  if (args[0] === "bundle" && args[1] === "inspect") {
    const saved = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")) : {};
    output({
      version: 1,
      bundle: "personal",
      root,
      name: "personal",
      id: saved.id ?? null,
      formatVersion: saved.formatVersion ?? null,
      cliVersion: "2.0.0",
      supportedFormatVersion: 2,
      status: saved.formatVersion === 2 ? "current" : "migration-required",
    });
    return true;
  }
  if (args[0] === "browse") {
    const path = args.includes("--path") ? args[args.indexOf("--path") + 1] : "";
    const offset = args.includes("--offset") ? Number(args[args.indexOf("--offset") + 1]) : 0;
    const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : 20;
    const entries = readdirSync(join(root, path), { withFileTypes: true })
      .filter(
        (entry) =>
          !entry.name.startsWith(".") &&
          (entry.isDirectory() || (entry.name.endsWith(".md") && entry.name !== "index.md")),
      )
      .map((entry) => ({
        path: [path, entry.name].filter(Boolean).join("/"),
        kind: entry.isDirectory() ? "directory" : "memory",
        title: entry.name.replace(/\.md$/, ""),
      }));
    output({
      version: 1,
      bundle: "personal",
      path,
      entries: entries.slice(offset, offset + limit),
      offset,
      limit,
      truncated: offset + limit < entries.length,
    });
    return true;
  }
  if (args[0] !== "change") return false;
  const historyPath = join(root, "fixture-changes.json");
  const history = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")) : [];
  const request = args.includes("--file")
    ? JSON.parse(readFileSync(args[args.indexOf("--file") + 1], "utf8"))
    : null;
  let change = history.find((item) => item.id === args[3]);
  const title = (raw) =>
    /^title: (.+)$/m.exec(raw ?? "")?.[1] ?? /^# (.+)$/m.exec(raw ?? "")?.[1] ?? "Memory";
  const body = (raw) => (raw === null ? null : raw.replace(/^---\n[\s\S]*?\n---\n/, ""));
  const snapshot = (raw) => (raw === null ? null : { raw, hash: hash(raw) });
  if (args[1] === "propose" || args[1] === "undo") {
    const repeated = history.find((item) => item.requestId === request.requestId);
    if (repeated) {
      output(repeated);
      return true;
    }
    const path = args[1] === "undo" ? change.path : request.path;
    const raw = args[1] === "undo" ? (change.before?.raw ?? null) : request.raw;
    const current = existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null;
    if (args[1] === "propose" && (current === null ? null : hash(current)) !== request.expectedHash)
      failure("The memory changed.");
    change = {
      version: 1,
      id: randomUUID(),
      bundle: "personal",
      path,
      action: raw === null ? "delete" : current === null ? "create" : "update",
      before: snapshot(current),
      after: snapshot(raw),
      revisionHash: hash(JSON.stringify([current, raw, request.sources])),
      actor: request.actor,
      reason: request.reason,
      createdAt: new Date().toISOString(),
      sources: request.sources ?? [],
      status: "pending",
      humanRequired: false,
      reviews: [],
      requestId: request.requestId,
    };
    if (raw === null) unlinkSync(join(root, path));
    else writeFileSync(join(root, path), raw);
    change.display = {
      title: title(raw ?? current),
      beforeBody: body(current),
      afterBody: body(raw),
    };
    const metadata = (text) => {
      try {
        return JSON.parse(/^memory: (.+)$/m.exec(text ?? "")?.[1] ?? "null");
      } catch {
        return null;
      }
    };
    change.display.beforeMemory = metadata(current);
    change.display.afterMemory = metadata(raw);

    for (const prior of history)
      if (prior.path === path && prior.status === "pending") {
        prior.status = "superseded";
        prior.replacementChangeId = change.id;
      }
    history.push(change);
  } else if (args[1] === "review") {
    if (!change || change.revisionHash !== request.expectedRevisionHash)
      failure("The proposal changed.");
    const current = existsSync(join(root, change.path))
      ? hash(readFileSync(join(root, change.path), "utf8"))
      : null;
    if (current !== (change.after?.hash ?? null)) failure("The proposal changed outside Scope.");
    // Synthetic stand-in for irudd-okf rechecking a removal when it is reviewed.
    if (request.actor.type === "agent" && change.path.startsWith("rechecked-"))
      failure("This change requires a human decision.", "HUMAN_REVIEW_REQUIRED");
    if (JSON.stringify(change.sources) !== JSON.stringify(request.sources))
      failure("The sources changed.");
    for (const source of change.sources)
      if (hash(readFileSync(join(root, source.path), "utf8")) !== source.hash)
        failure("The source revision changed.");
    change.review = {
      actor: request.actor,
      reason: request.reason,
      at: new Date().toISOString(),
      decision: request.decision,
      revisionHash: request.expectedRevisionHash,
      sources: request.sources,
    };
    change.reviews.push(change.review);
    change.status = request.decision === "accept" ? "accepted" : "rejected";
    if (change.status === "rejected") {
      if (change.before) writeFileSync(join(root, change.path), change.before.raw);
      else if (existsSync(join(root, change.path))) unlinkSync(join(root, change.path));
    }
  } else if (args[1] === "list") {
    const option = (name, fallback) =>
      args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
    const status = option("--status");
    const offset = Number(option("--offset", 0));
    const limit = Number(option("--limit", 30));
    const matching = history.filter((item) => !status || item.status === status);
    output({
      version: 1,
      bundle: "personal",
      changes: matching.slice(offset, offset + limit),
      limit,
      offset,
      total: matching.length,
      truncated: offset + limit < matching.length,
    });
    return true;
  }
  if (!change) failure("The change does not exist.");
  writeFileSync(historyPath, JSON.stringify(history));
  output(change);
  return true;
}
