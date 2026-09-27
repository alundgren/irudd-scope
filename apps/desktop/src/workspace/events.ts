import { decode } from "@irudd-scope/protocol";
import type { Tab } from "./contract.ts";
import { TabEvent, type TabEventEnvelope, type TabEvents } from "../plugins/events.ts";

type Listener = (envelope: TabEventEnvelope) => void | Promise<void>;
type Membership = { groupId: string };

export class TabEventRouter {
  private tabs = new Map<string, Membership>();
  private listeners = new Set<{ tabId?: string; receive: Listener }>();
  private queue: { envelope: TabEventEnvelope; membership: Membership }[] = [];
  private dispatching = false;

  constructor(private readonly onError: (error: unknown) => void) {}

  update(tabs: readonly Tab[]): void {
    const previous = this.tabs;
    this.tabs = new Map(
      tabs.map((tab) => [
        tab.id,
        this.tabs.get(tab.id)?.groupId === tab.groupId
          ? this.tabs.get(tab.id)!
          : { groupId: tab.groupId },
      ]),
    );
    for (const listener of this.listeners)
      if (listener.tabId && previous.get(listener.tabId) !== this.tabs.get(listener.tabId))
        this.listeners.delete(listener);
  }

  subscribe(receive: Listener): () => void {
    const listener = { receive };
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  forTab(tabId: string): TabEvents & { dispose: () => void } {
    const owned = new Set<() => void>();
    const membership = this.tabs.get(tabId);
    return {
      emit: (value) => {
        if (!membership || this.tabs.get(tabId) !== membership) return;
        const { groupId } = membership;
        this.queue.push({
          membership,
          envelope: { tabId, groupId, event: structuredClone(decode(TabEvent, value)) },
        });
        if (this.dispatching) return;
        this.dispatching = true;
        try {
          while (this.queue.length) {
            const { envelope, membership: sender } = this.queue.shift()!;
            if (this.tabs.get(envelope.tabId) !== sender) continue;
            const listeners = [...this.listeners];
            for (const listener of listeners) {
              if (!this.listeners.has(listener)) continue;
              if (listener.tabId === envelope.tabId) continue;
              if (listener.tabId && this.tabs.get(listener.tabId)?.groupId !== envelope.groupId)
                continue;
              try {
                void Promise.resolve(listener.receive(structuredClone(envelope))).catch(
                  this.onError,
                );
              } catch (error) {
                this.onError(error);
              }
            }
          }
        } finally {
          this.dispatching = false;
        }
      },
      on: (type, receive) => {
        if (!membership || this.tabs.get(tabId) !== membership) return () => {};
        const listener = {
          tabId,
          receive: ({ event }: TabEventEnvelope) => {
            if (event.type === type) return receive(event as Parameters<typeof receive>[0]);
          },
        };
        this.listeners.add(listener);
        const unsubscribe = () => {
          this.listeners.delete(listener);
          owned.delete(unsubscribe);
        };
        owned.add(unsubscribe);
        return unsubscribe;
      },
      dispose: () => {
        for (const unsubscribe of owned) unsubscribe();
      },
    };
  }
}
