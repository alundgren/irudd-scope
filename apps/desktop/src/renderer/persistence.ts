import { useCallback, useLayoutEffect, useRef, useState } from "react";

const saves = new Set<() => Promise<void>>();

export async function flushWorkspace(): Promise<void> {
  const results = await Promise.allSettled([...saves].map((save) => save()));
  if (results.some((result) => result.status === "rejected"))
    throw new Error("Could not save the workspace.");
}

export function useAutosave<T>(getValue: () => T | undefined, save: (value: T) => Promise<void>) {
  const current = useRef({ getValue, save });
  current.current = { getValue, save };
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef(Promise.resolve());
  const saved = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const [error, setError] = useState(false);
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const value = current.current.getValue();
    if (value === undefined) return pending.current;
    const document = JSON.stringify(value);
    const write = current.current.save;
    const task = pending.current.then(async () => {
      if (document === saved.current) return;
      await write(value);
      saved.current = document;
    });
    pending.current = task.catch(() => {});
    return task.then(
      () => {
        if (mounted.current) setError(false);
        else saves.delete(flush);
      },
      (failure: unknown) => {
        if (mounted.current) setError(true);
        throw failure;
      },
    );
  }, []);
  const schedule = useCallback(() => {
    if (timer.current === undefined)
      timer.current = setTimeout(() => {
        void flush().catch(() => {});
      }, 250);
  }, [flush]);
  useLayoutEffect(() => {
    mounted.current = true;
    saves.add(flush);
    return () => {
      mounted.current = false;
      // Capture before Excalidraw clears its scene on unmount. Keep the write in the close barrier.
      void flush().then(
        () => {
          if (!mounted.current) saves.delete(flush);
        },
        () => {},
      );
    };
  }, [flush]);
  return { schedule, flush, error };
}
