import { Monitor } from "lucide-react";
import type { GuestCatalogView } from "../guest/contract.ts";
import type { TabLabel, TabLabelContext } from "../plugins/api.ts";
import { tabLabel as pluginLabel } from "../plugins/registry.renderer.ts";
import type { Tab } from "./contract.ts";

export type TabLabels = TabLabelContext & { guests: GuestCatalogView };

const ownerStatus = {
  connected: undefined,
  connecting: "Connecting",
  offline: "Offline",
  disabled: "Sharing off",
  setup: "Sharing setup required",
  "access-denied": "Access denied",
  "update-required": "Update Scope",
  forgotten: "Forgotten",
};

export function tabLabel(
  tab: Tab,
  context: TabLabels,
): (TabLabel & { sharedBy?: string }) | undefined {
  if (tab.type !== "guest") return pluginLabel(tab, context);
  const record = context.guests.records.find((record) => record.tab.id === tab.id);
  const owner = context.guests.owners.find((owner) => owner.deviceId === record?.ownerDeviceId);
  const sharedBy = `Shared by ${owner?.name ?? "another Scope"}`;
  const status = owner
    ? (ownerStatus[owner.state] ??
      (context.guests.available.includes(tab.id) ? undefined : "Source unavailable"))
    : "Checking source";
  const kind = record?.source.artifact?.kind ?? record?.source.kind ?? "guest";
  return {
    title: tab.title,
    icon: Monitor,
    sharedBy,
    detail: `${kind} · ${sharedBy}`,
    tooltip: [tab.title, sharedBy, status].filter(Boolean).join("\n"),
    keywords: `guest shared ${owner?.name ?? ""}`,
  };
}
