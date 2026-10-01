import { useEffect, useRef, type RefObject } from "react";

export function useDocumentScroll(
  iframe: RefObject<HTMLIFrameElement | null>,
  active: boolean,
  revision?: number,
) {
  const position = useRef({ x: 0, y: 0 });
  const previous = useRef({ active, revision });
  const recording = useRef(active);
  const remove = useRef<() => void>(() => {});
  if (previous.current.active !== active) recording.current = false;
  if (previous.current.revision !== revision) position.current = { x: 0, y: 0 };
  previous.current = { active, revision };
  useEffect(() => {
    let cancelled = false;
    if (active)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (cancelled) return;
          try {
            iframe.current?.contentWindow?.scrollTo(position.current.x, position.current.y);
          } catch {
            /* A plan can navigate outside its initial origin. */
          }
          recording.current = true;
        }),
      );
    return () => {
      cancelled = true;
    };
  }, [active, revision]);
  useEffect(() => () => remove.current(), []);
  function observeDocument() {
    remove.current();
    try {
      const documentWindow = iframe.current?.contentWindow;
      if (!documentWindow) return;
      const record = () => {
        if (recording.current)
          position.current = { x: documentWindow.scrollX, y: documentWindow.scrollY };
      };
      documentWindow.addEventListener("scroll", record);
      remove.current = () => {
        try {
          documentWindow.removeEventListener("scroll", record);
        } catch {
          /* Navigation may have changed the document's origin. */
        }
      };
    } catch {
      /* Cross-origin navigation keeps its native browser state. */
    }
  }
  return observeDocument;
}
