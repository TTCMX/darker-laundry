// Money is always an integer number of minor units (cents). Floats never
// hold money: they are only used transiently for percentages and rates, and
// every result is rounded back to an integer immediately.

export type Cents = number;

export const toCents = (amount: number): Cents => Math.round(amount * 100);

export const fromCents = (cents: Cents): number => cents / 100;

export const roundCents = (value: number): Cents => Math.round(value);

export const percentOf = (cents: Cents, percent: number): Cents =>
  Math.round((cents * percent) / 100);

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export function formatMoney(cents: Cents, currency = "MXN", locale = "es-MX"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

/**
 * Split `amount` across `weights` proportionally so that the parts always
 * add up to exactly `amount`. The rounding remainder goes to the last
 * non-zero weight, so no cent is lost or invented.
 */
export function allocate(amount: Cents, weights: number[]): Cents[] {
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
  const parts = weights.map(() => 0);
  if (amount === 0 || total <= 0) return parts;
  let lastIndex = -1;
  weights.forEach((w, i) => {
    if (w > 0) lastIndex = i;
  });
  let remaining = amount;
  weights.forEach((w, i) => {
    if (w <= 0) return;
    const part = i === lastIndex ? remaining : Math.round((amount * w) / total);
    parts[i] = part;
    remaining -= part;
  });
  return parts;
}
