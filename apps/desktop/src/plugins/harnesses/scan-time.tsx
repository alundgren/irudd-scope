import { useEffect, useState } from "react";

const MINUTE = 60_000;

/** "just now", "5 min ago", "3 hours ago", "yesterday", then a date. */
export function relativeTime(scanned: Date, now: Date): string {
  const elapsed = now.getTime() - scanned.getTime();
  if (elapsed < MINUTE) return "just now";
  if (elapsed < 60 * MINUTE) return `${Math.floor(elapsed / MINUTE)} min ago`;
  const days = calendarDays(scanned, now);
  if (days === 0) {
    const hours = Math.floor(elapsed / (60 * MINUTE));
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  if (days === 1) return "yesterday";
  return scanned.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(scanned.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

function calendarDays(from: Date, to: Date) {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((end.getTime() - start.getTime()) / (24 * 60 * MINUTE));
}

/** The relative time refreshes every 30 seconds; the exact time is the tooltip and spoken text. */
export function ScanTime({ iso }: { iso: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const scanned = new Date(iso);
  const exact = scanned.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return (
    <time dateTime={iso} title={exact}>
      <span aria-hidden="true">{relativeTime(scanned, now)}</span>
      <span className="sr-only">{exact}</span>
    </time>
  );
}
