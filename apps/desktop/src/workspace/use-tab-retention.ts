import { useCallback, useEffect, useRef, useState } from "react";
import type { RetainedTab } from "./retention.ts";
import { flushWorkspace } from "./persistence.ts";

export function useTabRetention(enabled: boolean, onError: (message: string) => void) {
  const [tabs, setTabs] = useState<RetainedTab[]>([]);
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState<string[]>([]);
  const visibleIds = useRef(visible);
  visibleIds.current = visible;
  const reportVisible = useCallback((ids: string[]) => {
    setVisible((previous) => (previous.join() === ids.join() ? previous : ids));
  }, []);

  useEffect(() => {
    let active = true;
    let received = false;
    const unsubscribe = window.scope.onRetentionChanged((next) => {
      received = true;
      if (active) setTabs(next);
    });
    void window.scope
      .retainedTabs()
      .then((next) => {
        if (active) {
          if (!received) setTabs(next);
          setReady(true);
        }
      })
      .catch(() => onError("Could not load tab retention. Reopen Scope to retry."));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [onError]);

  useEffect(() => {
    if (!ready || !enabled) return;
    const report = () =>
      window.scope
        .reportVisibleTabs(visibleIds.current)
        .catch(() => onError("Could not record visible tabs. Reopen Scope to retry."));
    void report();
    const timer = setInterval(report, 30_000);
    document.addEventListener("visibilitychange", report);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", report);
    };
  }, [visible, ready, enabled, onError]);

  useEffect(() => {
    if (!ready || !enabled) return;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        await flushWorkspace();
        await window.scope.checkTabRetention(visibleIds.current);
      } catch {
        onError("Tab cleanup could not finish. Scope will retry in a minute.");
      } finally {
        checking = false;
      }
    };
    const startup = setTimeout(check, 1000);
    const timer = setInterval(check, 60_000);
    return () => {
      clearTimeout(startup);
      clearInterval(timer);
    };
  }, [ready, enabled, onError]);

  async function setPermanent(id: string, permanent: boolean) {
    try {
      await window.scope.setTabPermanent(id, permanent);
    } catch {
      onError("Could not change tab retention. Try again.");
    }
  }
  return { tabs, ready, reportVisible, setPermanent };
}
