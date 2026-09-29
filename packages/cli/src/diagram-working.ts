import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { Schema } from "effect";
import { ArtifactId, ArtifactName, decode, MAX_CONTENT_BYTES } from "@irudd-scope/protocol";
import {
  applyDiagramDelta,
  diagramDelta,
  DiagramVersion,
  NativeDiagram,
  parseNativeDiagram,
  type DiagramDelta,
} from "@irudd-scope/protocol/diagram-sync";
import type { ScopeClient } from "@irudd-scope/protocol/client";

const Base = Schema.Struct({
  elements: NativeDiagram.fields.elements,
  appState: NativeDiagram.fields.appState,
  files: Schema.Record(Schema.String, DiagramVersion),
});
const WorkingDiagram = Schema.Struct({
  format: Schema.Literal("scope-diagram-1"),
  name: ArtifactName,
  id: ArtifactId,
  version: DiagramVersion,
  base: Base,
  document: NativeDiagram,
  conflicts: Schema.Array(Schema.String),
});
type WorkingDiagram = typeof WorkingDiagram.Type;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function checkpoint(document: NativeDiagram): WorkingDiagram["base"] {
  return {
    elements: document.elements,
    appState: document.appState,
    files: Object.fromEntries(Object.entries(document.files).map(([id, file]) => [id, hash(file)])),
  };
}

export async function readWorking(file: string) {
  if ((await stat(file)).size > MAX_CONTENT_BYTES * 3)
    throw new Error("Working diagram exceeds 96 MiB.");
  const original = await readFile(file, "utf8");
  const model = decode(WorkingDiagram, JSON.parse(original));
  parseNativeDiagram(model.document);
  return { model, original };
}

async function saveWorking(file: string, model: WorkingDiagram, original?: string) {
  const data = JSON.stringify(model);
  if (original === undefined) {
    await writeFile(file, data, { flag: "wx", mode: 0o600 });
    return;
  }
  if ((await readFile(file, "utf8")) !== original)
    throw new Error(
      "The working file changed during the request. Its edits were preserved. Rebase before retrying.",
    );
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function workingDelta(model: WorkingDiagram): DiagramDelta {
  const delta = diagramDelta(
    { ...model.document, elements: model.base.elements, appState: model.base.appState, files: {} },
    { ...model.document, files: {} },
  );
  const files = Object.fromEntries([
    ...Object.entries(model.document.files).filter(
      ([id, file]) => model.base.files[id] !== hash(file),
    ),
    ...Object.keys(model.base.files)
      .filter((id) => !Object.hasOwn(model.document.files, id))
      .map((id) => [id, null]),
  ]);
  return { ...delta, files };
}

function mergeProperties(
  base: Record<string, unknown>,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  path: string,
  conflicts: string[],
) {
  const result = { ...local };
  for (const key of new Set([...Object.keys(base), ...Object.keys(remote)])) {
    if (equal(base[key], remote[key])) continue;
    if (equal(local[key], base[key]) || equal(local[key], remote[key])) {
      if (Object.hasOwn(remote, key)) result[key] = remote[key];
      else delete result[key];
    } else if (!["version", "versionNonce", "updated"].includes(key))
      conflicts.push(`${path}.${key}`);
    else result[key] = remote[key];
  }
  return result;
}

function mergeRemote(
  model: WorkingDiagram,
  remote: NativeDiagram,
  fileChanges: DiagramDelta["files"],
  fileHashes: WorkingDiagram["base"]["files"],
  version: string,
): WorkingDiagram {
  const conflicts: string[] = [...model.conflicts];
  const base = new Map(model.base.elements.map((element) => [String(element.id), element]));
  const local = new Map(model.document.elements.map((element) => [String(element.id), element]));
  const incoming = new Map(remote.elements.map((element) => [String(element.id), element]));
  for (const id of new Set([...base.keys(), ...incoming.keys()])) {
    const before = base.get(id),
      ours = local.get(id),
      theirs = incoming.get(id);
    if (equal(before, theirs)) continue;
    if (equal(before, ours) || equal(ours, theirs)) {
      if (theirs) local.set(id, theirs);
      else local.delete(id);
    } else if (before && ours && theirs)
      local.set(id, mergeProperties(before, ours, theirs, `elements.${id}`, conflicts));
    else conflicts.push(`elements.${id}`);
  }
  const localOrder = model.document.elements.map((element) => String(element.id));
  const baseOrder = model.base.elements.map((element) => String(element.id));
  const remoteOrder = remote.elements.map((element) => String(element.id));
  let order = localOrder.filter((id) => local.has(id));
  const rearranged = (ids: string[]) =>
    !equal(ids, [
      ...baseOrder.filter((id) => ids.includes(id)),
      ...ids.filter((id) => !base.has(id)),
    ]);
  // Remote insertions retain their position when local ordering only appends objects.
  if (!rearranged(localOrder)) order = remoteOrder.filter((id) => local.has(id));
  else if (rearranged(remoteOrder) && !equal(localOrder, remoteOrder))
    conflicts.push("elements.order");
  order.push(...[...local.keys()].filter((id) => !order.includes(id)));
  const files = { ...model.document.files };
  for (const [id, file] of Object.entries(fileChanges)) {
    const ours = files[id] ? hash(files[id]) : undefined;
    const theirs = file ? hash(file) : undefined;
    if (ours === model.base.files[id] || ours === theirs) {
      if (file) files[id] = file;
      else delete files[id];
    } else conflicts.push(`files.${id}`);
  }
  return {
    ...model,
    version,
    base: { elements: remote.elements, appState: remote.appState, files: fileHashes },
    conflicts,
    document: {
      ...model.document,
      elements: order.map((id) => local.get(id)!),
      appState: mergeProperties(
        model.base.appState,
        model.document.appState,
        remote.appState,
        "appState",
        conflicts,
      ),
      files,
    },
  };
}

export async function pullDiagram(client: ScopeClient, name: string, output: string) {
  const artifact = await client.named(name);
  const result = await client.syncDiagram({ action: "read", name });
  if (result.type !== "full") throw new Error("Scope did not return a full diagram.");
  await saveWorking(output, {
    format: "scope-diagram-1",
    name,
    id: artifact.id,
    version: result.version,
    document: result.document,
    base: checkpoint(result.document),
    conflicts: [],
  });
  return {
    name,
    id: artifact.id,
    version: result.version,
    output,
    elements: result.document.elements.length,
    assets: Object.keys(result.document.files).length,
  };
}

export async function rebaseDiagram(client: ScopeClient, file: string) {
  const { model, original } = await readWorking(file);
  const artifact = await client.named(model.name);
  if (artifact.id !== model.id)
    throw new Error("This name now belongs to another tab. Pull it into a new working file.");
  const result = await client.syncDiagram({
    action: "read",
    name: model.name,
    since: model.version,
  });
  if (result.type !== "full" && result.type !== "delta")
    throw new Error("Scope did not return diagram changes.");
  const baseline = {
    ...model.document,
    elements: model.base.elements,
    appState: model.base.appState,
    files: {},
  };
  const remote =
    result.type === "full" ? result.document : applyDiagramDelta(baseline, result.delta);
  const fileChanges =
    result.type === "full"
      ? {
          ...Object.fromEntries(
            Object.keys(model.base.files)
              .filter((id) => !Object.hasOwn(remote.files, id))
              .map((id) => [id, null]),
          ),
          ...Object.fromEntries(
            Object.entries(remote.files).filter(
              ([id, file]) => model.base.files[id] !== hash(file),
            ),
          ),
        }
      : result.delta.files;
  const hashes = { ...model.base.files };
  for (const [id, value] of Object.entries(fileChanges)) {
    if (value) hashes[id] = hash(value);
    else delete hashes[id];
  }
  const next = mergeRemote(model, remote, fileChanges, hashes, result.version);
  await saveWorking(file, next, original);
  return {
    name: model.name,
    version: next.version,
    received: result.type,
    conflicts: next.conflicts,
    output: file,
  };
}

export async function pushDiagram(
  client: ScopeClient,
  file: string,
  options: { full?: boolean; resolved?: boolean; note?: string },
) {
  const { model, original } = await readWorking(file);
  if (model.conflicts.length && !options.resolved)
    throw new Error(
      `Resolve these fields, then use --resolved or submit a proposal: ${model.conflicts.join(", ")}`,
    );
  const result = await client.syncDiagram(
    options.note !== undefined
      ? {
          action: "propose",
          name: model.name,
          expectedVersion: model.version,
          delta: workingDelta(model),
          note: options.note,
        }
      : options.full
        ? {
            action: "replace",
            name: model.name,
            expectedVersion: model.version,
            document: model.document,
          }
        : {
            action: "write",
            name: model.name,
            expectedVersion: model.version,
            delta: workingDelta(model),
          },
  );
  if (result.type === "conflict") {
    process.exitCode = 2;
    return {
      type: "conflict",
      name: model.name,
      version: result.version,
      changesAvailable: Boolean(result.delta),
      instruction:
        "Run diagram rebase on this working file. Review conflicting fields, then push --resolved or propose with --note. Your local edits are preserved.",
    };
  }
  if (result.type === "applied") {
    const document = applyDiagramDelta(model.document, result.delta);
    await saveWorking(
      file,
      { ...model, version: result.version, document, base: checkpoint(document), conflicts: [] },
      original,
    );
  }
  return {
    type: result.type,
    name: result.name,
    version: result.version,
    revision: result.revision,
    ...(result.type === "proposal" ? { proposalId: result.proposal?.id } : {}),
  };
}
