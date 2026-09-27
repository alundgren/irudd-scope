import { Schema } from "effect";
import { ArtifactId, decode } from "@irudd-scope/protocol";

export const Uuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
);
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160));
export const TabGroup = Schema.Struct({
  id: Uuid,
  owner: Schema.Struct({ kind: Name, id: Name }),
});
export type TabGroup = typeof TabGroup.Type;
export const TabState = Schema.Struct({
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  data: Schema.JsonObject,
});
export type TabState = typeof TabState.Type;
export const Tab = Schema.Struct({
  id: Uuid,
  groupId: Uuid,
  type: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/)),
  title: Name,
  state: TabState,
});
export type Tab = typeof Tab.Type;
export const Workspace = Schema.Struct({
  version: Schema.Literal(2),
  groups: Schema.Array(TabGroup),
  tabs: Schema.Array(Tab).check(Schema.isMaxLength(100)),
  selected: Schema.NullOr(Uuid),
  closed: Schema.Array(Tab),
});
export type Workspace = typeof Workspace.Type;

export function emptyWorkspace(): Workspace {
  const id = crypto.randomUUID();
  return {
    version: 2,
    groups: [{ id, owner: { kind: "workspace", id } }],
    tabs: [],
    selected: null,
    closed: [],
  };
}

export function decodeWorkspace(value: unknown): Workspace {
  const workspace = decode(Workspace, value);
  const groups = new Set(workspace.groups.map((group) => group.id));
  const tabs = [...workspace.tabs, ...workspace.closed];
  if (
    !groups.size ||
    groups.size !== workspace.groups.length ||
    new Set(tabs.map((tab) => tab.id)).size !== tabs.length ||
    tabs.some((tab) => !groups.has(tab.groupId)) ||
    (workspace.selected !== null && !workspace.tabs.some((tab) => tab.id === workspace.selected))
  )
    throw new Error("Invalid workspace selection or group membership.");
  return workspace;
}

const LegacyWorkspace = Schema.Struct({
  tabs: Schema.Array(ArtifactId).check(Schema.isMaxLength(100)),
  selected: Schema.NullOr(ArtifactId),
  closed: Schema.optionalKey(Schema.Array(ArtifactId)),
});

export function importWorkspace(value: unknown): Workspace {
  if (value && typeof value === "object" && "version" in value) return decodeWorkspace(value);
  const old = decode(LegacyWorkspace, value);
  const workspace = emptyWorkspace();
  const makeTab = (artifactId: string): Tab => ({
    id: crypto.randomUUID(),
    groupId: workspace.groups[0].id,
    type: "file",
    title: artifactId,
    state: { version: 1, data: { artifactId } },
  });
  const tabs = old.tabs.map(makeTab);
  if (
    new Set([...old.tabs, ...(old.closed ?? [])]).size !==
    old.tabs.length + (old.closed?.length ?? 0)
  )
    throw new Error("Invalid saved tabs.");
  if (old.selected !== null && !old.tabs.includes(old.selected))
    throw new Error("Invalid saved selection.");
  return decodeWorkspace({
    ...workspace,
    tabs,
    closed: (old.closed ?? []).map(makeTab),
    selected: tabs.find((tab) => tab.state.data.artifactId === old.selected)?.id ?? null,
  });
}
