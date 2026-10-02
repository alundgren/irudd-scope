// Frame events do not bubble to the workspace. Each accessible document needs its own listeners.
export function observeFrameDocuments(
  root: HTMLElement,
  listen: (document: Document, frames: readonly HTMLIFrameElement[]) => () => void,
): () => void {
  function observe(container: HTMLElement | Document, parents: readonly HTMLIFrameElement[]) {
    const frames = new Map<HTMLIFrameElement, () => void>();
    function scan() {
      const present = new Set(container.querySelectorAll<HTMLIFrameElement>("iframe"));
      for (const [frame, dispose] of frames) {
        if (!present.has(frame)) {
          dispose();
          frames.delete(frame);
        }
      }
      for (const frame of present) {
        if (frames.has(frame)) continue;
        let stopDocument: (() => void) | undefined;
        function load() {
          stopDocument?.();
          stopDocument = undefined;
          try {
            const document = frame.contentDocument;
            if (!document) return;
            const path = [...parents, frame];
            const stopListening = listen(document, path);
            const stopChildren = observe(document, path);
            stopDocument = () => {
              stopChildren();
              stopListening();
            };
          } catch {
            // Authored HTML can navigate to another origin; its native interactions remain available.
          }
        }
        frame.addEventListener("load", load);
        frames.set(frame, () => {
          frame.removeEventListener("load", load);
          stopDocument?.();
        });
        load();
      }
    }
    const observer = new MutationObserver(scan);
    observer.observe(container, { childList: true, subtree: true });
    scan();
    return () => {
      observer.disconnect();
      for (const dispose of frames.values()) dispose();
      frames.clear();
    };
  }
  return observe(root, []);
}

export function framePoint(
  frames: readonly HTMLIFrameElement[],
  x: number,
  y: number,
): { x: number; y: number } {
  for (const frame of frames.toReversed()) {
    const bounds = frame.getBoundingClientRect();
    x = bounds.left + (x + frame.clientLeft) * (bounds.width / (frame.offsetWidth || 1));
    y = bounds.top + (y + frame.clientTop) * (bounds.height / (frame.offsetHeight || 1));
  }
  return { x, y };
}

function pageOwnsEscape(document: Document, frames: readonly HTMLIFrameElement[]) {
  if (
    document.activeElement?.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable=false])",
    )
  )
    return true;
  return [document, ...frames.map((frame) => frame.ownerDocument)].some((document) =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        "dialog[open], [role=dialog][aria-modal=true], :popover-open",
      ),
    ).some((dialog) => dialog.getClientRects().length > 0),
  );
}

export function observeFrameKeyboard(root: HTMLElement, keyboard: (event: KeyboardEvent) => void) {
  return observeFrameDocuments(root, (document, frames) => {
    let active = true;
    const frameKeyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const pageEscape = event.key === "Escape" && pageOwnsEscape(document, frames);
      // Later window handlers can still claim this key, and native dialog dismissal must finish first.
      setTimeout(() => {
        if (!active || event.defaultPrevented) return;
        if (event.key === "Escape" && (pageEscape || pageOwnsEscape(document, frames))) return;
        keyboard(event);
      }, 0);
    };
    const frameWindow = document.defaultView;
    frameWindow?.addEventListener("keydown", frameKeyboard);
    return () => {
      active = false;
      try {
        frameWindow?.removeEventListener("keydown", frameKeyboard);
      } catch {
        // A WindowProxy can change origin before its previous document is cleaned up.
      }
    };
  });
}
