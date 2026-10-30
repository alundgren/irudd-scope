import { useState, type ReactNode } from "react";
import type { SessionCall } from "@irudd-scope/sessions/contract";
import { modelName } from "./model.ts";

export function Stats({ items }: { items: Array<[string, string, string?]> }) {
  return (
    <div className="sessions-stats">
      {items.map(([value, label, tone]) => (
        <div key={label} className="sessions-stat">
          <div className={`sessions-stat-value ${tone ?? ""}`}>{value}</div>
          <div className="sessions-stat-label">{label}</div>
        </div>
      ))}
    </div>
  );
}

/** A bar behind the number, scaled to the largest row. */
export function Bar({
  value,
  max,
  label,
  tone,
}: {
  value: number;
  max: number;
  label: string;
  tone?: string;
}) {
  return (
    <div className="sessions-total">
      <span
        className={`sessions-total-bar ${tone ?? ""}`}
        style={{ width: `${(100 * value) / (max || 1)}%` }}
      />
      <span>{label}</span>
    </div>
  );
}

export function Toggle({ open }: { open: boolean }) {
  return (
    <td className="sessions-twist" aria-hidden="true">
      {open ? "▾" : "▸"}
    </td>
  );
}

export function useOpen() {
  const [open, setOpen] = useState(new Set<string>());
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return [open, toggle] as const;
}

export function ExpandRow({
  label,
  open,
  onToggle,
  children,
  className,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <tr
      className={`sessions-row ${className ?? ""}`}
      tabIndex={0}
      aria-expanded={open}
      aria-label={label}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggle();
        }
      }}
    >
      {children}
    </tr>
  );
}

export function byModel(calls: SessionCall[]) {
  const models = new Map<string, { calls: number; ms: number }>();
  for (const call of calls) {
    const name = modelName(call.model);
    const entry = models.get(name) ?? { calls: 0, ms: 0 };
    entry.calls += 1;
    entry.ms += call.durationMs ?? 0;
    models.set(name, entry);
  }
  return [...models].sort((a, b) => b[1].ms - a[1].ms || b[1].calls - a[1].calls);
}
