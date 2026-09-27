// Date ranges, period comparison and CSV export for the analytics back office.
// Dates are plain "YYYY-MM-DD" strings in the tenant's time zone; the database
// turns them into instants.

export type PresetKey = "today" | "yesterday" | "7d" | "30d" | "month" | "last_month" | "90d" | "year" | "custom";

export interface DateRange {
  from: string;
  to: string;
}

export const PRESETS: { key: Exclude<PresetKey, "custom">; label: string }[] = [
  { key: "today", label: "Hoy" },
  { key: "yesterday", label: "Ayer" },
  { key: "7d", label: "7 días" },
  { key: "30d", label: "30 días" },
  { key: "month", label: "Este mes" },
  { key: "last_month", label: "Mes pasado" },
  { key: "90d", label: "90 días" },
  { key: "year", label: "Este año" },
];

const parse = (d: string) => new Date(`${d}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
  const d = parse(day);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

export const daysBetween = (from: string, to: string) => Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000) + 1;

export function presetRange(key: Exclude<PresetKey, "custom">, today: string): DateRange {
  const t = parse(today);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  switch (key) {
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "90d":
      return { from: addDays(today, -89), to: today };
    case "month":
      return { from: fmt(new Date(Date.UTC(y, m, 1))), to: today };
    case "last_month":
      return { from: fmt(new Date(Date.UTC(y, m - 1, 1))), to: fmt(new Date(Date.UTC(y, m, 0))) };
    case "year":
      return { from: fmt(new Date(Date.UTC(y, 0, 1))), to: today };
  }
}

/** Which preset (if any) a range corresponds to. */
export function matchPreset(r: DateRange, today: string): PresetKey {
  return PRESETS.find((p) => {
    const x = presetRange(p.key, today);
    return x.from === r.from && x.to === r.to;
  })?.key ?? "custom";
}

/** The period of the same length right before (what the database compares with). */
export function previousRange(r: DateRange): DateRange {
  const n = daysBetween(r.from, r.to);
  return { from: addDays(r.from, -n), to: addDays(r.from, -1) };
}

/** Relative change, or null when there is nothing to compare with. */
export function change(current: number, previous: number): number | null {
  if (!previous) return current ? null : 0;
  return (current - previous) / Math.abs(previous);
}

export const MAX_DAYS = 1100;

export function validRange(r: DateRange): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.from) || !/^\d{4}-\d{2}-\d{2}$/.test(r.to)) return "Elige las dos fechas.";
  if (r.to < r.from) return "La fecha final es anterior a la inicial.";
  if (daysBetween(r.from, r.to) > MAX_DAYS) return "El periodo máximo es de 3 años.";
  return null;
}

export type Bucket = "day" | "week" | "month";

export function bucketLabel(day: string, bucket: Bucket, locale = "es-MX"): string {
  const d = parse(day);
  if (bucket === "month") return new Intl.DateTimeFormat(locale, { month: "short", year: "2-digit", timeZone: "UTC" }).format(d);
  const s = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(d);
  return bucket === "week" ? `Sem. ${s}` : s;
}

export function rangeLabel(r: DateRange, locale = "es-MX"): string {
  const f = (d: string, year: boolean) =>
    new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" }).format(parse(d));
  if (r.from === r.to) return f(r.from, true);
  return `${f(r.from, r.from.slice(0, 4) !== r.to.slice(0, 4))} – ${f(r.to, true)}`;
}

// ── CSV ─────────────────────────────────────────────────────────────────────

export type CsvValue = string | number | boolean | null | undefined;

const csvCell = (v: CsvValue) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // Quote when needed; neutralise formulas so a customer name can't run in Excel.
  const safe = /^[=+\-@\t\r]/.test(s) && typeof v === "string" ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(header: string[], rows: CsvValue[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

/** Cents as a plain decimal for spreadsheets ("1234.50"). */
export const csvMoney = (cents: number | null | undefined) => (cents === null || cents === undefined ? "" : (Number(cents) / 100).toFixed(2));

export function downloadCsv(filename: string, csv: string) {
  // BOM so Excel opens accents correctly.
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
