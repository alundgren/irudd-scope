import { useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Popover } from "@base-ui/react/popover";
import { ChevronDown, File, Search, X } from "lucide-react";
import type { Artifact } from "@irudd-scope/protocol";
import { Button } from "../renderer/components/ui/button.tsx";
import { Input } from "../renderer/components/ui/input.tsx";
import { tabArtifactId } from "../plugins/registry.renderer.ts";
import type { Tab } from "./contract.ts";

export function TabOverflow({
  tabs,
  hiddenIds,
  artifacts,
  unread,
  tabButtons,
  onSelect,
  open,
  onOpenChange,
  restoreFocus,
}: {
  tabs: readonly Tab[];
  hiddenIds: ReadonlySet<string>;
  artifacts: ReadonlyMap<string, Artifact>;
  unread: ReadonlySet<string>;
  tabButtons: RefObject<Map<string, HTMLButtonElement>>;
  onSelect: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  restoreFocus: boolean;
}) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const chosen = useRef<string | null>(null);
  const needle = query.trim().toLowerCase();
  const entries = tabs.toReversed().flatMap((tab) => {
    const artifactId = tabArtifactId(tab);
    const artifact = artifacts.get(artifactId ?? "");
    const title = artifact?.title ?? tab.title;
    const hidden = hiddenIds.has(tab.id);
    if (needle ? !`${title} ${artifact?.kind ?? tab.type}`.toLowerCase().includes(needle) : !hidden)
      return [];
    return [{ tab, title, hidden, updated: Boolean(artifactId && unread.has(artifactId)) }];
  });
  const hasUnread = tabs.some(
    (tab) => hiddenIds.has(tab.id) && unread.has(tabArtifactId(tab) ?? ""),
  );

  function navigate(event: KeyboardEvent) {
    if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
    const buttons = Array.from(
      results.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    );
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0 && document.activeElement !== input.current) return;
    event.preventDefault();
    if (event.key === "Enter") buttons[Math.max(0, index)]?.click();
    else {
      const next =
        index < 0
          ? event.key === "ArrowDown"
            ? 0
            : buttons.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }

  return (
    <Popover.Root
      open={open}
      modal="trap-focus"
      onOpenChange={(value) => {
        onOpenChange(value);
        if (value) {
          setQuery("");
          chosen.current = null;
        }
      }}
    >
      <Popover.Trigger
        render={<Button variant="ghost" className="tab-overflow-trigger" />}
        aria-label={`More tabs, ${hiddenIds.size} hidden`}
        title={`${hiddenIds.size} more tabs`}
      >
        <ChevronDown aria-hidden="true" />
        <span>{hiddenIds.size}</span>
        {hasUnread && <span className="unread-dot" role="img" aria-label="Updated artifact" />}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          className="tab-overflow-positioner"
        >
          <Popover.Popup
            className="tab-overflow-popup"
            initialFocus={input}
            finalFocus={() =>
              restoreFocus &&
              (chosen.current ? (tabButtons.current.get(chosen.current) ?? false) : true)
            }
            onKeyDown={navigate}
          >
            <div className="tab-overflow-heading">
              <Popover.Title>More tabs</Popover.Title>
              <span>
                {hiddenIds.size} hidden · {tabs.length} total
              </span>
              <Popover.Close
                render={<Button variant="ghost" size="icon-xs" aria-label="Close tab picker" />}
              >
                <X />
              </Popover.Close>
            </div>
            <div className="workspace-search-field">
              <Search aria-hidden="true" />
              <Input
                ref={input}
                aria-label="Search tabs"
                placeholder={`Search all ${tabs.length} tabs…`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Clear tab search"
                  onClick={() => {
                    setQuery("");
                    input.current?.focus();
                  }}
                >
                  <X />
                </Button>
              )}
            </div>
            <div className="tab-overflow-results" ref={results}>
              {entries.map(({ tab, title, hidden, updated }) => (
                <button
                  className="tab-overflow-result"
                  key={tab.id}
                  title={title}
                  onClick={() => {
                    chosen.current = tab.id;
                    onSelect(tab.id);
                    onOpenChange(false);
                  }}
                >
                  <File aria-hidden="true" />
                  <span>{title}</span>
                  {!hidden && <small>In tab bar</small>}
                  {updated && (
                    <span className="unread-dot" role="img" aria-label="Updated artifact" />
                  )}
                </button>
              ))}
              {!entries.length && (
                <p className="search-empty" role="status">
                  No tabs match "{query}".
                </p>
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
