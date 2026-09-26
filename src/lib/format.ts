import { formatMoney } from "../domain/money";

let currency = "MXN";
let locale = "es-MX";
let timeZone = "America/Mexico_City";

export function setFormatContext(c: { currency?: string; locale?: string; timezone?: string }) {
  if (c.currency) currency = c.currency;
  if (c.locale) locale = c.locale;
  if (c.timezone) timeZone = c.timezone;
}

export const money = (cents: number | string | null | undefined) => formatMoney(Number(cents ?? 0), currency, locale);

export const dateTime = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat(locale, { timeZone, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : "—";

export const dateOnly = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const plain = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  return new Intl.DateTimeFormat(locale, {
    timeZone: plain ? "UTC" : timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(plain ? `${iso}T12:00:00Z` : iso));
};

export const timeOnly = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : "";

export const relative = (iso: string | null | undefined) => {
  if (!iso) return "";
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
};

/** Today in the tenant's time zone, as YYYY-MM-DD. */
export const todayISO = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return parts;
};

/** Converts a <input type="datetime-local"> value (tenant local time) to ISO. */
export const localInputToISO = (value: string) => (value ? new Date(value).toISOString() : null);

export const isoToLocalInput = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const qty = (n: number | string) => {
  const v = Number(n);
  return Number.isInteger(v) ? String(v) : v.toLocaleString(locale, { maximumFractionDigits: 3 });
};

export const UNIT_LABEL: Record<string, string> = {
  kg: "kg",
  piece: "pza",
  pair: "par",
  load: "carga",
  item: "art.",
  m2: "m²",
  bag: "bolsa",
};
export const unitLabel = (u: string) => UNIT_LABEL[u] ?? u;

export const centsToInput = (cents: number | null | undefined) => (cents === null || cents === undefined ? "" : String(Number(cents) / 100));
export const inputToCents = (v: string) => {
  const n = Number(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && v !== "" ? Math.round(n * 100) : null;
};
