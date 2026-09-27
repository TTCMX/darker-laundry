// Tenant configuration. Everything that differs between laundries lives here
// (stored in `tenants.settings`), with defaults so a new tenant works on day one.

import { DEFAULT_CUSTOMER_RULES, type CustomerStatusRules } from "./customers.js";
import { DEFAULT_LOYALTY, type LoyaltySettings } from "./loyalty.js";
import type { PaymentMethod } from "./payments.js";
import { DEFAULT_STAGES } from "./pricing/engine.js";
import type { PricingSettings, TaxSettings } from "./pricing/types.js";

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface DeliveryWindow {
  id: string;
  label: string;
  start: string; // "HH:MM"
  end: string;
}

export interface TenantSettings {
  locale: string;
  operations: {
    /** Default promise when creating an order. */
    default_turnaround_hours: number;
    /** Orders created after this local time count as next day. */
    order_cutoff: string | null;
    working_days: Weekday[];
    opening_time: string;
    closing_time: string;
    approaching_hours: number;
  };
  delivery: {
    windows: DeliveryWindow[];
    /** Used when the address has no zone. */
    default_fee_cents: number;
    default_free_over_cents: number | null;
    min_order_cents: number | null;
    auto_assign_single_courier: boolean;
  };
  pricing: PricingSettings;
  tax: TaxSettings;
  customers: { status_rules: CustomerStatusRules };
  payments: { methods: PaymentMethod[]; allow_overpayment: boolean };
  notifications: { email_enabled: boolean; whatsapp_enabled: boolean; reply_to: string | null };
  loyalty: LoyaltySettings;
}

export const DEFAULT_SETTINGS: TenantSettings = {
  locale: "es-MX",
  operations: {
    default_turnaround_hours: 48,
    order_cutoff: null,
    working_days: ["mon", "tue", "wed", "thu", "fri", "sat"],
    opening_time: "09:00",
    closing_time: "19:00",
    approaching_hours: 12,
  },
  delivery: {
    windows: [
      { id: "morning", label: "Mañana", start: "09:00", end: "13:00" },
      { id: "afternoon", label: "Tarde", start: "13:00", end: "18:00" },
    ],
    default_fee_cents: 0,
    default_free_over_cents: null,
    min_order_cents: null,
    auto_assign_single_courier: true,
  },
  pricing: { stages: DEFAULT_STAGES, discount_stacking: "parallel" },
  tax: { mode: "none", rate_percent: 16, delivery_fee_taxable: false },
  customers: { status_rules: DEFAULT_CUSTOMER_RULES },
  payments: { methods: ["cash", "card", "transfer", "online"], allow_overpayment: false },
  notifications: { email_enabled: true, whatsapp_enabled: true, reply_to: null },
  loyalty: DEFAULT_LOYALTY,
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined || override === null ? base : override) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

/** Stored settings may be partial or from an older version: fill the gaps. */
export const resolveSettings = (stored: unknown): TenantSettings => deepMerge(DEFAULT_SETTINGS, stored ?? {});
