import { useEffect, useState } from "react";
import type { MemoryStatus } from "@irudd-scope/protocol/memory";

/** Memory configuration and per-machine sync status, kept current by desktop notifications. */
export function useMemory() {
  const [status, setStatus] = useState<MemoryStatus>();
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    let observed = false;
    const unsubscribe = window.scope.onMemoryChange((next) => {
      observed = true;
      if (current) {
        setStatus(next);
        setError("");
      }
    });
    void window.scope
      .memory()
      .then((next) => {
        if (current && !observed) setStatus(next);
      })
      .catch(() => {
        if (current && !observed)
          setError("Could not read memory status. Close this view and retry.");
      });
    return () => {
      current = false;
      unsubscribe();
    };
  }, []);
  return { status, error, setStatus, setError };
}
