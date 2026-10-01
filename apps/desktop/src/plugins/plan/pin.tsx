import type { ReactNode } from "react";

export function PinPopover({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  const offset = `max(8px, calc(${(y > 0.5 ? 1 - y : y) * 100}% - 14px))`;
  return (
    <section
      className="plan-pin-popover"
      style={{
        left: `clamp(8px, calc(${x * 100}% + 18px), max(8px, calc(100% - 328px)))`,
        ...(y > 0.5 ? { bottom: offset } : { top: offset }),
        maxHeight: `calc(100% - ${offset} - 8px)`,
      }}
    >
      {children}
    </section>
  );
}
