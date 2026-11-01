import { Bookmark, LockKeyhole } from "lucide-react";
import { Button } from "../renderer/components/ui/button.tsx";
import { isBuiltinTab } from "../plugins/registry.ts";
import type { Tab } from "./contract.ts";

export function TabPermanence({
  tab,
  title,
  permanent,
  onPermanent,
}: {
  tab: Tab;
  title: string;
  permanent: boolean;
  onPermanent: (id: string, permanent: boolean) => Promise<void>;
}) {
  if (isBuiltinTab(tab))
    return (
      <span
        className="tab-permanent is-permanent inline-flex size-6 shrink-0 items-center justify-center"
        role="img"
        aria-label={`Built-in tab: ${title}`}
        title="Built-in · Always permanent"
        data-tab-drag-ignore
      >
        <LockKeyhole size={14} aria-hidden="true" />
      </span>
    );
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={`tab-permanent${permanent ? " is-permanent" : ""}`}
      data-tab-drag-ignore
      aria-label={`${permanent ? "Make temporary" : "Keep permanently"}: ${title}`}
      aria-pressed={permanent}
      title={permanent ? "Permanent · Make temporary" : "Keep permanently"}
      onClick={() => void onPermanent(tab.id, !permanent)}
    >
      <Bookmark fill={permanent ? "currentColor" : "none"} />
    </Button>
  );
}
