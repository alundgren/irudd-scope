import { escapeHtml } from "../html.ts";
import type { Header } from "./header.ts";
import type { Point } from "./svg.ts";
import { arrowHead, Bounds, orthoPath, svgDocument, svgText } from "./svg.ts";
import type { Tags } from "./text.ts";
import { cleanLabel, clipText, num, textWidth } from "./text.ts";

const MAX_TASKS = 60;
const DAY_MS = 86_400_000;
const WIDTH = 700;
const LABEL_PX = 12.5;
const AXIS_PX = 11.5;
const TOP_H = 18;
const AXIS_H = 38;
const ROW_H = 26;
const SECTION_H = 26;
const BAR_H = 14;
const DEFAULT_DAYS = 7;
const GANTT_TAGS = /^(?:done|now|key|milestone|muted|crit|active|s[1-7])$/;
/** Mermaid habits that are not tasks. */
const IGNORED =
  /^(?:gantt|dateformat|axisformat|title|excludes|includes|tickinterval|todaymarker|weekday)\b/i;

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  januari: 0,
  feb: 1,
  february: 1,
  februari: 1,
  mar: 2,
  march: 2,
  mars: 2,
  apr: 3,
  april: 3,
  may: 4,
  maj: 4,
  jun: 5,
  june: 5,
  juni: 5,
  jul: 6,
  july: 6,
  juli: 6,
  aug: 7,
  august: 7,
  augusti: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  okt: 9,
  oktober: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};
const SWEDISH_WORDS =
  /\b(?:januari|februari|mars|maj|juni|juli|augusti|okt|oktober|vecka|veckor|dagar|idag|efter|v\.?\s*\d{1,2})\b/i;
const MONTH_NAMES = {
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  sv: ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"],
};

/** Days since 1970-01-01 in UTC, so dates have no time zone or daylight saving drift. */
type Day = number;
type Range = { start: Day; end: Day; yearless: boolean };
type Task = {
  label: string;
  section: number;
  tags: Tags;
  milestone: boolean;
  startText: string;
  endText: string;
  after: string[];
  start: Day;
  end: Day;
  guessed: boolean;
  deps: number[];
};
type Chart = {
  tasks: Task[];
  sections: string[];
  today: Day | null;
  real: boolean;
  swedish: boolean;
};

function dayOf(year: number, month: number, date: number): Day | null {
  if (year < 1970 || year > 2100 || month < 0 || month > 11 || date < 1 || date > 31) return null;
  const time = Date.UTC(year, month, date);
  if (new Date(time).getUTCDate() !== date) return null;
  return Math.round(time / DAY_MS);
}

function parts(day: Day): { year: number; month: number; date: number; weekday: number } {
  const value = new Date(day * DAY_MS);
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth(),
    date: value.getUTCDate(),
    weekday: (value.getUTCDay() + 6) % 7,
  };
}

/** The Monday of ISO week `week`; week 1 holds January 4. */
function weekStart(year: number, week: number): Day | null {
  if (week < 1 || week > 53) return null;
  const jan4 = dayOf(year, 0, 4);
  if (jan4 === null) return null;
  return jan4 - parts(jan4).weekday + (week - 1) * 7;
}

function isoWeek(day: Day): number {
  const thursday = day - parts(day).weekday + 3;
  const jan1 = dayOf(parts(thursday).year, 0, 1) ?? thursday;
  return Math.floor((thursday - jan1) / 7) + 1;
}

function monthRange(year: number, month: number, yearless: boolean): Range | null {
  const start = dayOf(year, month, 1);
  const end = dayOf(year + Math.floor((month + 1) / 12), (month + 1) % 12, 1);
  return start === null || end === null ? null : { start, end, yearless };
}

function monthIndex(word: string): number | null {
  return MONTHS[word.toLowerCase().replace(/\.$/, "")] ?? null;
}

/**
 * The days a date token covers, end exclusive: `2026-02-03` is one day, `w6` or `v6`
 * a week, `Feb` or `mars` a month, `Q2` a quarter. Tokens without a year use `year`.
 */
function parseDate(text: string, year: number): Range | null {
  const token = cleanLabel(text).toLowerCase().replace(/,$/, "");
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(token);
  if (match) {
    const day = dayOf(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return day === null ? null : { start: day, end: day + 1, yearless: false };
  }
  match = /^(\d{4})-?w(\d{1,2})$/.exec(token);
  if (match) return weekRange(Number(match[1]), Number(match[2]), false);
  match = /^(?:w|v|wk|week|vecka|v\.)\s*(\d{1,2})(?:,?\s+(\d{4}))?$/.exec(token);
  if (match) return weekRange(match[2] ? Number(match[2]) : year, Number(match[1]), !match[2]);
  match = /^(\d{4})[-/](\d{1,2})$/.exec(token);
  if (match) return monthRange(Number(match[1]), Number(match[2]) - 1, false);
  match = /^q([1-4])(?:\s+(\d{4}))?$/.exec(token) ?? /^(\d{4})\s*q([1-4])$/.exec(token);
  if (match) {
    const [quarter, given] = token.startsWith("q") ? [match[1], match[2]] : [match[2], match[1]];
    const start = monthRange(given ? Number(given) : year, (Number(quarter) - 1) * 3, !given);
    const end = monthRange(given ? Number(given) : year, (Number(quarter) - 1) * 3 + 2, !given);
    return start && end ? { start: start.start, end: end.end, yearless: !given } : null;
  }
  match = /^([a-zåäö]+\.?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/.exec(token);
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th|\.)?\s+([a-zåäö]+\.?)(?:,?\s+(\d{4}))?$/.exec(token);
  if (match || dayFirst) {
    const [word, date, given] = match
      ? [match[1]!, match[2]!, match[3]]
      : [dayFirst![2]!, dayFirst![1]!, dayFirst![3]];
    const month = monthIndex(word);
    if (month === null) return null;
    const day = dayOf(given ? Number(given) : year, month, Number(date));
    return day === null ? null : { start: day, end: day + 1, yearless: !given };
  }
  match = /^([a-zåäö]+\.?)(?:,?\s+(\d{4}))?$/.exec(token);
  if (match) {
    const month = monthIndex(match[1]!);
    if (month === null) return null;
    return monthRange(match[2] ? Number(match[2]) : year, month, !match[2]);
  }
  return null;
}

function weekRange(year: number, week: number, yearless: boolean): Range | null {
  const start = weekStart(year, week);
  return start === null ? null : { start, end: start + 7, yearless };
}

/** `+3d`, `2w`, `10 days`, `1 month` or `3 veckor`, in days. */
function parseDuration(text: string): number | null {
  const match =
    /^\+?\s*(\d+(?:[.,]\d+)?)\s*(d|days?|dagar|dag|w|wks?|weeks?|veckor|vecka|v|m|mo|mos|months?|månader|månad|mån)$/i.exec(
      cleanLabel(text),
    );
  if (!match) return null;
  const amount = Number(match[1]!.replace(",", "."));
  const unit = match[2]!.toLowerCase();
  const days = /^(d|day|days|dag|dagar)$/.test(unit)
    ? amount
    : unit.startsWith("m")
      ? amount * 30.4
      : amount * 7;
  return Number.isFinite(days) && days <= 3660 ? Math.max(0, Math.round(days)) : null;
}

/** A yearless date that lands well before `notBefore` belongs to the next year, as in `Nov .. Jan`. */
function readDate(text: string, year: number, notBefore: Day | null, slack: number): Range | null {
  const range = parseDate(text, year);
  if (!range || !range.yearless || notBefore === null || range.start >= notBefore - slack) {
    return range;
  }
  return parseDate(text, year + 1) ?? range;
}

function takeGanttTags(text: string): { text: string; tags: Tags } {
  const names = new Set<string>();
  let rest = text.trimEnd();
  for (;;) {
    const match = /\s*\[([^\][]*)\]$/.exec(rest);
    if (!match) break;
    const group = match[1]!
      .toLowerCase()
      .split(/[\s,]+/)
      .filter(Boolean);
    if (group.length === 0 || !group.every((tag) => GANTT_TAGS.test(tag))) break;
    for (const tag of group) names.add(tag === "crit" ? "key" : tag === "active" ? "now" : tag);
    rest = rest.slice(0, match.index).trimEnd();
  }
  let series: number | null = null;
  for (const name of names) {
    const found = /^s([1-7])$/.exec(name);
    if (found) series = Number(found[1]);
  }
  return { text: rest, tags: { names, series } };
}

const RANGE_SPLIT = /\s*(?:\.{2,3}|[–—→]|->)\s*|\s+(?:-|to|till|until|tom)\s+/i;

/** Splits `start .. end`, `start, end` or `after X, 2w` into its start and end text. */
function splitSpec(spec: string): [string, string] {
  const range = RANGE_SPLIT.exec(spec);
  if (range && range.index > 0) {
    return [spec.slice(0, range.index), spec.slice(range.index + range[0].length)];
  }
  const comma = spec.lastIndexOf(",");
  // `Feb 3, 2026` is one date.
  if (comma > 0 && !/^\s*\d{4}\s*$/.test(spec.slice(comma + 1))) {
    return [spec.slice(0, comma), spec.slice(comma + 1)];
  }
  return [spec, ""];
}

function parseChart(lines: readonly string[]): Chart {
  const tasks: Task[] = [];
  const sections: string[] = [];
  let todayText = "";
  for (const raw of lines) {
    const line = raw.trim().replace(/^[-*•]\s+/u, "");
    if (IGNORED.test(line)) continue;
    const heading = /^(?:#{1,4}\s*|section\s+)(.*)$/i.exec(line);
    if (heading) {
      sections.push(cleanLabel(heading[1]!));
      continue;
    }
    const today = /^(?:today|idag|now)\s*:\s*(.*)$/i.exec(line);
    if (today) {
      todayText = today[1]!;
      continue;
    }
    if (tasks.length >= MAX_TASKS) continue;
    const colon = line.indexOf(":");
    const head = takeGanttTags(colon < 0 ? line : line.slice(0, colon));
    const spec = takeGanttTags(colon < 0 ? "" : line.slice(colon + 1));
    const label = cleanLabel(head.text);
    if (!label) continue;
    const tags = head.tags;
    for (const name of spec.tags.names) tags.names.add(name);
    if (spec.tags.series !== null) tags.series = spec.tags.series;
    const [startText, endText] = splitSpec(cleanLabel(spec.text));
    const after = /^(?:after|efter)\s+(.+)$/i.exec(startText.trim());
    tasks.push({
      label,
      section: sections.length - 1,
      tags,
      milestone: tags.names.has("milestone"),
      startText: after ? "" : startText.trim(),
      endText: endText.trim(),
      after: after
        ? after[1]!
            .split(/\s*&\s*/)
            .map((name) => cleanLabel(name).toLowerCase())
            .filter(Boolean)
        : [],
      start: 0,
      end: 0,
      guessed: false,
      deps: [],
    });
  }
  const swedish = lines.some((line) => SWEDISH_WORDS.test(line));
  const year = baseYear(lines, todayText);
  const real = resolveTasks(tasks, year);
  const today = todayText ? (parseDate(todayText, year)?.start ?? null) : null;
  return { tasks, sections, today, real, swedish };
}

/** The year for dates written without one: the first year in the chart, else this year. */
function baseYear(lines: readonly string[], todayText: string): number {
  for (const text of [todayText, ...lines]) {
    const found = /(?<!\d)(19[7-9]\d|20\d\d)(?!\d)/.exec(text);
    if (found) return Number(found[1]);
  }
  return new Date().getUTCFullYear();
}

/**
 * Places every task. `after X` starts when X ends; a task whose dates do not parse
 * starts where the task above it ends and is marked as guessed. Returns whether any
 * task has a real date, so an axis of made-up dates is never drawn.
 */
function resolveTasks(tasks: Task[], year: number): boolean {
  const byName = new Map<string, number>();
  tasks.forEach((task, index) => {
    if (!byName.has(task.label.toLowerCase())) byName.set(task.label.toLowerCase(), index);
  });
  const known = tasks.flatMap((task) => {
    const range = task.startText ? parseDate(task.startText, year) : null;
    return range ? [range.start] : [];
  });
  const lengths = tasks.flatMap((task) => {
    const start = task.startText ? parseDate(task.startText, year) : null;
    const end = start && task.endText ? readDate(task.endText, year, start.start, 0) : null;
    return start && end && end.end > start.start ? [end.end - start.start] : [];
  });
  lengths.sort((a, b) => a - b);
  const fallbackLength = lengths[Math.floor(lengths.length / 2)] ?? DEFAULT_DAYS;
  const origin = known.length > 0 ? Math.min(...known) : 0;
  const state = tasks.map(() => "new" as "new" | "busy" | "done");
  let real = false;
  let lastStart: Day | null = null;

  const resolve = (index: number): void => {
    if (state[index] !== "new") return;
    state[index] = "busy";
    const task = tasks[index]!;
    let start: Day | null = null;
    let end: Day | null = null;
    let failed = false;
    if (task.after.length > 0) {
      const deps = task.after.map((name) => byName.get(name));
      for (const dep of deps) {
        if (dep === undefined || dep === index) continue;
        resolve(dep);
        if (state[dep] !== "done") continue;
        task.deps.push(dep);
        start = Math.max(start ?? -Infinity, tasks[dep]!.end);
      }
      if (task.deps.length === 0) failed = true;
    }
    let own: Range | null = null;
    let length: number | null = null;
    if (start === null && task.startText) {
      length = parseDuration(task.startText);
      if (length === null) {
        own = readDate(task.startText, year, lastStart, 183);
        if (own) {
          start = own.start;
          real = true;
        } else failed = true;
      }
    }
    if (task.endText) {
      const duration = parseDuration(task.endText);
      if (duration !== null) length = duration;
      else {
        const until = readDate(task.endText, year, start, 0);
        if (until) real = true;
        if (until && start !== null) end = Math.max(until.end, start + 1);
        else if (until && start === null) end = until.end;
        else failed = true;
      }
    }
    if (start === null) {
      const previous = index > 0 ? tasks[index - 1] : undefined;
      if (index > 0) resolve(index - 1);
      start = previous && state[index - 1] === "done" ? previous.end : origin;
      if (end !== null && end <= start) end = null;
    }
    if (task.milestone) end = start;
    else if (end === null) end = start + (length ?? (own ? own.end - own.start : fallbackLength));
    if (!task.milestone && end <= start) end = start + 1;
    task.start = start;
    task.end = end;
    task.guessed = failed;
    lastStart = start;
    state[index] = "done";
  };
  tasks.forEach((_task, index) => resolve(index));
  return real;
}

type Scale = "day" | "week" | "month" | "year";

function pickScale(span: number): Scale {
  if (span <= 35) return "day";
  if (span <= 210) return "week";
  if (span <= 1500) return "month";
  return "year";
}

function snapDown(day: Day, scale: Scale): Day {
  const p = parts(day);
  if (scale === "week") return day - p.weekday;
  if (scale === "month") return dayOf(p.year, p.month, 1) ?? day;
  if (scale === "year") return dayOf(p.year, 0, 1) ?? day;
  return day;
}

function nextTick(day: Day, scale: Scale): Day {
  const p = parts(day);
  if (scale === "day") return day + 1;
  if (scale === "week") return day + 7;
  if (scale === "month")
    return dayOf(p.year + (p.month === 11 ? 1 : 0), (p.month + 1) % 12, 1) ?? day + 31;
  return dayOf(p.year + 1, 0, 1) ?? day + 366;
}

/**
 * `gantt`. `## Phase` headings group tasks; `Task: start .. end [done|now|key|s1..s7]`
 * lines are bars, `Task: after Other, 2w` starts when Other ends, and
 * `Milestone: 2026-03-01 [milestone]` is a diamond. `today: date` draws a today line.
 */
export function renderGantt(header: Header, lines: readonly string[]): string | null {
  const chart = parseChart(lines);
  if (chart.tasks.length === 0) return null;
  return drawChart(chart, header);
}

function drawChart(chart: Chart, header: Header): string {
  const { tasks, sections } = chart;
  const months = MONTH_NAMES[chart.swedish ? "sv" : "en"];
  const weekPrefix = chart.swedish ? "v" : "w";
  const sectionNames = new Set(tasks.map((task) => task.section).filter((index) => index >= 0));
  const widest = Math.max(
    ...tasks.map((task) => textWidth(task.label, LABEL_PX)),
    ...[...sectionNames].map((index) => textWidth(sections[index] ?? "", LABEL_PX)),
  );
  const labelW = Math.min(230, Math.max(96, widest + 18));
  const chartX = labelW;
  const chartW = WIDTH - labelW;

  let low = Math.min(...tasks.map((task) => task.start));
  let high = Math.max(...tasks.map((task) => Math.max(task.end, task.start + 1)));
  if (chart.today !== null && chart.real) {
    low = Math.min(low, chart.today);
    high = Math.max(high, chart.today + 1);
  }
  const scale = pickScale(high - low);
  low = snapDown(low, scale);
  if (scale !== "day") {
    let end = low;
    for (let guard = 0; end < high && guard < 500; guard += 1) end = nextTick(end, scale);
    high = Math.max(end, low + 1);
  }
  const perDay = chartW / (high - low);
  const xOf = (day: Day) => chartX + (day - low) * perDay;

  const rows: { kind: "section" | "task"; index: number }[] = [];
  let lastSection = -1;
  tasks.forEach((task, index) => {
    if (task.section !== lastSection && task.section >= 0)
      rows.push({ kind: "section", index: task.section });
    lastSection = task.section;
    rows.push({ kind: "task", index });
  });
  const top = chart.real ? AXIS_H + 4 : 4;
  const rowY: number[] = [];
  const taskY = new Map<number, number>();
  let y = top;
  for (const row of rows) {
    const height = row.kind === "section" ? SECTION_H : ROW_H;
    rowY.push(y);
    if (row.kind === "task") taskY.set(row.index, y + height / 2);
    y += height;
  }
  const bottom = y;

  const parts: string[] = [];
  rows.forEach((row, index) => {
    if (row.kind === "task" && index % 2 === 1) {
      parts.push(
        `<rect class="mc-gantt-zebra" x="0" y="${num(rowY[index]!)}" width="${WIDTH}" height="${ROW_H}"/>`,
      );
    }
  });
  if (chart.real)
    parts.push(axisSvg(low, high, scale, xOf, chartX, chartW, bottom, months, weekPrefix));
  parts.push(
    `<path class="mc-gantt-rule" d="M${num(chartX)} ${num(chart.real ? TOP_H : top)}V${num(bottom)}"/>`,
  );

  rows.forEach((row, index) => {
    const rowTop = rowY[index]!;
    if (row.kind === "section") {
      const name = clipText(sections[row.index] ?? "", LABEL_PX, labelW - 14);
      parts.push(svgText(name, 2, rowTop + SECTION_H / 2 + 1, "mc-gantt-section", "start"));
      const members = tasks.filter((task) => task.section === row.index);
      const from = Math.min(...members.map((task) => task.start));
      const to = Math.max(...members.map((task) => task.end));
      const cy = rowTop + SECTION_H / 2 + 1;
      parts.push(
        `<path class="mc-gantt-span" d="M${num(xOf(from))} ${num(cy + 3)}V${num(cy - 2)}H${num(xOf(to))}V${num(cy + 3)}"/>`,
      );
      return;
    }
    const task = tasks[row.index]!;
    const label = clipText(task.label, LABEL_PX, labelW - 18);
    const labelClass = task.tags.names.has("now") ? "mc-gantt-label is-now" : "mc-gantt-label";
    parts.push(svgText(label, 12, rowTop + ROW_H / 2, labelClass, "start"));
  });

  tasks.forEach((task, index) => {
    for (const dep of task.deps)
      parts.push(dependencySvg(tasks[dep]!, dep, task, index, taskY, xOf));
  });
  tasks.forEach((task, index) => {
    parts.push(taskSvg(task, taskY.get(index)!, xOf, chart.real, months, chart.swedish));
  });

  if (chart.today !== null && chart.real) {
    const x = xOf(chart.today);
    const text = chart.swedish ? "Idag" : "Today";
    const w = textWidth(text, AXIS_PX - 1) + 10;
    parts.push(
      `<g class="mc-gantt-today"><path d="M${num(x)} ${num(AXIS_H)}V${num(bottom + 2)}"/>` +
        `<rect x="${num(x - w / 2)}" y="${num(bottom + 2)}" width="${num(w)}" height="16" rx="8"/>` +
        `${svgText(text, x, bottom + 10, "mc-gantt-today-text")}</g>`,
    );
  }
  const bounds = new Bounds();
  bounds.add(0, 0, WIDTH, bottom + (chart.today !== null && chart.real ? 18 : 0));
  return svgDocument(parts.join(""), bounds, header.title || "Gantt chart");
}

function axisSvg(
  low: Day,
  high: Day,
  scale: Scale,
  xOf: (day: Day) => number,
  chartX: number,
  chartW: number,
  bottom: number,
  months: readonly string[],
  weekPrefix: string,
): string {
  const out: string[] = [];
  const perDay = chartW / (high - low);
  const ticks: Day[] = [];
  for (let day = low, guard = 0; day < high && guard < 500; guard += 1) {
    ticks.push(day);
    day = nextTick(day, scale);
  }
  const stepPx = scale === "day" ? perDay : scale === "week" ? perDay * 7 : perDay * 30.4;
  const minGap = scale === "day" ? 20 : scale === "week" ? 30 : scale === "month" ? 30 : 40;
  const every = Math.max(1, Math.ceil(minGap / Math.max(stepPx, 0.01)));
  ticks.forEach((day, index) => {
    const x = xOf(day);
    if (index > 0)
      out.push(`<path class="mc-gantt-grid" d="M${num(x)} ${AXIS_H - 6}V${num(bottom)}"/>`);
    if (index % every !== 0) return;
    const p = parts(day);
    const text =
      scale === "day"
        ? String(p.date)
        : scale === "week"
          ? `${weekPrefix}${isoWeek(day)}`
          : scale === "month"
            ? months[p.month]!
            : String(p.year);
    const next = Math.min(xOf(ticks[index + every] ?? high), chartX + chartW);
    out.push(svgText(text, (x + next) / 2, TOP_H + 10, "mc-gantt-tick"));
  });
  // The upper row names the months, or the years for a month or year scale.
  if (scale !== "year") {
    const upper: Day[] = [];
    let day = low;
    for (let guard = 0; day < high && guard < 200; guard += 1) {
      upper.push(day);
      const p = parts(day);
      day =
        scale === "month"
          ? (dayOf(p.year + 1, 0, 1) ?? high)
          : (dayOf(p.year + (p.month === 11 ? 1 : 0), (p.month + 1) % 12, 1) ?? high);
    }
    upper.forEach((start, index) => {
      const x = Math.max(xOf(start), chartX);
      const end = Math.min(xOf(upper[index + 1] ?? high), chartX + chartW);
      if (index > 0) out.push(`<path class="mc-gantt-period" d="M${num(x)} 0V${num(bottom)}"/>`);
      const p = parts(start);
      const full = scale === "month" ? String(p.year) : `${months[p.month]} ${p.year}`;
      const short = scale === "month" ? String(p.year) : months[p.month]!;
      const room = end - x - 8;
      const text =
        textWidth(full, AXIS_PX) <= room ? full : textWidth(short, AXIS_PX) <= room ? short : "";
      if (text) out.push(svgText(text, x + 5, TOP_H / 2, "mc-gantt-period-text", "start"));
    });
  }
  out.push(`<path class="mc-gantt-axis" d="M${num(chartX)} ${AXIS_H}H${num(chartX + chartW)}"/>`);
  return out.join("");
}

function dependencySvg(
  from: Task,
  fromIndex: number,
  to: Task,
  toIndex: number,
  taskY: Map<number, number>,
  xOf: (day: Day) => number,
): string {
  const y1 = taskY.get(fromIndex);
  const y2 = taskY.get(toIndex);
  if (y1 === undefined || y2 === undefined || y1 === y2) return "";
  const x1 = xOf(from.end) + (from.milestone ? 7 : 0);
  const x2 = xOf(to.start) - (to.milestone ? 7 : 0);
  const out = x1 + 7;
  let points: Point[];
  if (x2 - out >= 8) {
    points = [
      { x: x1, y: y1 },
      { x: out, y: y1 },
      { x: out, y: y2 },
      { x: x2, y: y2 },
    ];
  } else {
    const gap = y2 + (y2 > y1 ? -ROW_H / 2 : ROW_H / 2);
    points = [
      { x: x1, y: y1 },
      { x: out, y: y1 },
      { x: out, y: gap },
      { x: x2 - 9, y: gap },
      { x: x2 - 9, y: y2 },
      { x: x2, y: y2 },
    ];
  }
  return (
    `<g class="mc-link mc-gantt-dep"><path class="mc-edge" d="${orthoPath(points)}"/>` +
    `${arrowHead(points.at(-2)!, points.at(-1)!)}</g>`
  );
}

function dateText(day: Day, months: readonly string[], swedish: boolean): string {
  const p = parts(day);
  return swedish ? `${p.date} ${months[p.month]}` : `${months[p.month]} ${p.date}`;
}

function taskSvg(
  task: Task,
  cy: number,
  xOf: (day: Day) => number,
  real: boolean,
  months: readonly string[],
  swedish: boolean,
): string {
  const names = task.tags.names;
  const classes = ["mc-gantt-task"];
  for (const name of ["done", "now", "key", "muted"])
    if (names.has(name)) classes.push(`is-${name}`);
  if (task.guessed) classes.push("is-guessed");
  if (task.tags.series !== null) classes.push(`mc-s${task.tags.series}`);
  const when = !real
    ? ""
    : task.milestone
      ? dateText(task.start, months, swedish)
      : `${dateText(task.start, months, swedish)} – ${dateText(task.end - 1, months, swedish)}`;
  const title = `<title>${escapeHtml(when ? `${task.label}: ${when}` : task.label)}</title>`;
  const x = xOf(task.start);
  if (task.milestone) {
    const r = 7;
    // A milestone near the right edge has its date on its left.
    const left = x + r + 5 + textWidth(when, 11.5) > WIDTH;
    const label = real
      ? svgText(when, left ? x - r - 5 : x + r + 5, cy, "mc-gantt-date", left ? "end" : "start")
      : "";
    return (
      `<g class="${classes.join(" ")} is-milestone">${title}` +
      `<path class="mc-gantt-bar" d="M${num(x)} ${num(cy - r)}L${num(x + r)} ${num(cy)}L${num(x)} ${num(cy + r)}L${num(x - r)} ${num(cy)}Z"/>${label}</g>`
    );
  }
  const width = Math.max(3, xOf(task.end) - x);
  return (
    `<g class="${classes.join(" ")}">${title}` +
    `<rect class="mc-gantt-bar" x="${num(x)}" y="${num(cy - BAR_H / 2)}" width="${num(width)}" height="${BAR_H}" rx="3"/></g>`
  );
}
