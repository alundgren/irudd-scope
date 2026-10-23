import { useEffect, useRef, type RefObject } from "react";

export function useDocumentScroll(
  iframe: RefObject<HTMLIFrameElement | null>,
  active: boolean,
  documentKey: string,
  savedY: number,
  save: (y: number) => void,
) {
  const latest = useRef({ active, savedY, save });
  latest.current = { active, savedY, save };
  const previous = useRef({ active, documentKey });
  const recording = useRef(false);
  const remove = useRef<() => void>(() => {});
  const generation = useRef(0);
  if (previous.current.active !== active || previous.current.documentKey !== documentKey)
    recording.current = false;
  previous.current = { active, documentKey };

  function restore() {
    const current = ++generation.current;
    recording.current = false;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (current !== generation.current || !latest.current.active) return;
        try {
          iframe.current?.contentWindow?.scrollTo(0, latest.current.savedY);
        } catch {
          /* An authored link can navigate to another origin. */
        }
        recording.current = true;
      }),
    );
  }
  useEffect(() => {
    if (active) restore();
    return () => {
      generation.current++;
      recording.current = false;
    };
  }, [active, documentKey]);
  useEffect(() => () => remove.current(), []);

  return function observe() {
    remove.current();
    try {
      const win = iframe.current?.contentWindow;
      if (!win) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const record = () => {
        try {
          if (recording.current && latest.current.active) latest.current.save(win.scrollY);
        } catch {
          /* Navigation may have changed the document origin. */
        }
      };
      const scroll = () => {
        clearTimeout(timer);
        timer = setTimeout(record, 100);
      };
      win.addEventListener("scroll", scroll);
      remove.current = () => {
        clearTimeout(timer);
        try {
          win.removeEventListener("scroll", scroll);
        } catch {
          /* The navigated window may no longer be accessible. */
        }
      };
      restore();
    } catch {
      /* Cross-origin documents keep their own browser reading state. */
    }
  };
}
