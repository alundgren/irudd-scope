import { useEffect, useRef } from "react";

export function PresentationPointer() {
  const pointer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const overlay = pointer.current;
    if (!overlay) return;
    const marks = Array.from(overlay.children) as HTMLElement[];

    const move = (event: PointerEvent) => {
      if (
        event.pointerType === "touch" ||
        !(event.target instanceof Element && event.target.closest(".diagram-view"))
      ) {
        overlay.style.opacity = "0";
        return;
      }
      for (const mark of marks) {
        mark.style.transform = `translate3d(${event.clientX}px, ${event.clientY}px, 0) translate(-50%, -50%)`;
      }
      overlay.style.opacity = "1";
    };
    const hide = () => {
      overlay.style.opacity = "0";
    };
    const leave = (event: PointerEvent) => {
      if (!event.relatedTarget) hide();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerout", leave);
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerout", leave);
      window.removeEventListener("blur", hide);
    };
  }, []);

  return (
    <div className="presentation-pointer" ref={pointer} aria-hidden="true">
      <span className="presentation-pointer-trail" />
      <span className="presentation-pointer-trail" />
      <span className="presentation-pointer-trail" />
      <span className="presentation-pointer-tip" />
    </div>
  );
}
