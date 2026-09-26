// Phone numbers arrive in every shape ("55 1234 5678", "+52 1 55...",
// "(55) 1234-5678"). Customers are identified by phone, so the stored key
// must be a single canonical form: "+<country code><national number>".

const COUNTRY_CODES: Record<string, { code: string; nationalLength: number }> = {
  MX: { code: "52", nationalLength: 10 },
  US: { code: "1", nationalLength: 10 },
  CA: { code: "1", nationalLength: 10 },
  CO: { code: "57", nationalLength: 10 },
  ES: { code: "34", nationalLength: 9 },
  AR: { code: "54", nationalLength: 10 },
  CL: { code: "56", nationalLength: 9 },
  PE: { code: "51", nationalLength: 9 },
};

export const digitsOnly = (raw: string | null | undefined): string =>
  String(raw ?? "").replace(/\D/g, "");

/**
 * Returns "+<cc><national>" or null when the input cannot be a phone number.
 * Numbers written without a country code use the tenant's default country.
 */
export function normalizePhone(raw: string | null | undefined, defaultCountry = "MX"): string | null {
  const input = String(raw ?? "").trim();
  if (!input) return null;
  let digits = digitsOnly(input);
  if (!digits) return null;
  if (digits.startsWith("00")) digits = digits.slice(2);

  const country = COUNTRY_CODES[defaultCountry.toUpperCase()] ?? COUNTRY_CODES.MX!;
  const hasPlus = input.startsWith("+") || input.startsWith("00");

  if (!hasPlus && digits.length === country.nationalLength) {
    return `+${country.code}${digits}`;
  }

  // Mexico: the legacy mobile prefix "1" after the country code (+52 1 55...)
  // is no longer dialled; both forms are the same line.
  if (digits.startsWith("521") && digits.length === 13) {
    return `+52${digits.slice(3)}`;
  }

  if (digits.startsWith(country.code) && digits.length === country.code.length + country.nationalLength) {
    return `+${digits}`;
  }

  // Explicit international numbers from other countries are kept as given.
  if (hasPlus && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

/** WhatsApp click-to-chat links take the number without "+". */
export const whatsappNumber = (normalized: string | null): string | null =>
  normalized ? normalized.replace(/^\+/, "") : null;
