import type { Cents } from "../money.js";

export interface PricingProduct {
  id: string;
  sku: string | null;
  name: string;
  unit: string;
  category_id: string | null;
  base_price_cents: Cents;
  taxable: boolean;
  /** Price is entered per order (e.g. repairs, custom quotes). */
  variable_price: boolean;
  active: boolean;
}

/**
 * Volume pricing. `packages` are exact prices for an exact integer quantity
 * ("2 units → $280"); `tiers` set the unit price from a minimum quantity on
 * ("6+ units → $100 each"). An exact package wins over a tier.
 */
export interface VolumeRuleConfig {
  packages?: { qty: number; total_cents: Cents }[];
  tiers?: { min_qty: number; unit_price_cents: Cents }[];
}

export interface VolumeRule {
  id: string;
  name: string;
  active: boolean;
  product_id: string | null;
  category_id: string | null;
  priority: number;
  starts_at: string | null;
  ends_at: string | null;
  config: VolumeRuleConfig;
}

export type DiscountKind = "percentage" | "fixed";

export interface Discount {
  id: string;
  name: string;
  code: string | null;
  kind: DiscountKind;
  /** Percentage (0–100) for "percentage"; cents for "fixed". */
  value: number;
  /** Empty lists = the whole order is eligible. */
  product_ids: string[];
  category_ids: string[];
  min_order_cents: Cents | null;
  max_discount_cents: Cents | null;
  starts_at: string | null;
  ends_at: string | null;
  usage_limit: number | null;
  usage_count: number;
  active: boolean;
}

export type TaxMode = "none" | "inclusive" | "exclusive";

export interface TaxSettings {
  mode: TaxMode;
  rate_percent: number;
  delivery_fee_taxable: boolean;
}

/** Stages run in this order. Future modules (memberships, credits) plug in here. */
export type PricingStage = "volume" | "discounts" | "membership" | "credits" | "delivery_fee" | "tax";

export interface PricingSettings {
  stages: PricingStage[];
  /**
   * parallel: every discount is computed on the price before discounts.
   * sequential: each discount applies to what the previous ones left.
   */
  discount_stacking: "parallel" | "sequential";
}

export interface DeliveryFeeRule {
  fee_cents: Cents;
  /** Fee is waived when the discounted subtotal reaches this amount. */
  free_over_cents: Cents | null;
}

export interface PricingItemInput {
  product_id: string | null;
  quantity: number;
  /** Required for variable-price products and for ad-hoc lines. */
  unit_price_cents?: Cents | null;
  /** Ad-hoc line name when there is no product. */
  name?: string | null;
  notes?: string | null;
}

export interface PricingInput {
  items: PricingItemInput[];
  discount_ids: string[];
  delivery: DeliveryFeeRule | null;
  /** Staff override of the delivery fee (permission checked by the caller). */
  delivery_fee_override_cents?: Cents | null;
  now: Date;
}

export interface PricingContext {
  products: PricingProduct[];
  volume_rules: VolumeRule[];
  discounts: Discount[];
  tax: TaxSettings;
  settings: PricingSettings;
}

export interface LineResult {
  index: number;
  product_id: string | null;
  sku: string | null;
  name: string;
  unit: string;
  category_id: string | null;
  quantity: number;
  unit_price_cents: Cents;
  list_total_cents: Cents;
  volume_rule_id: string | null;
  volume_savings_cents: Cents;
  /** Price after volume rules, before discounts. */
  gross_cents: Cents;
  discount_cents: Cents;
  net_cents: Cents;
  taxable: boolean;
  custom_price: boolean;
  notes: string | null;
}

export interface AppliedDiscount {
  id: string;
  name: string;
  kind: DiscountKind;
  value: number;
  amount_cents: Cents;
}

export interface RejectedDiscount {
  id: string;
  reason:
    | "not_found"
    | "inactive"
    | "not_started"
    | "expired"
    | "usage_limit"
    | "min_order"
    | "no_eligible_items";
}

export interface BreakdownStep {
  key: string;
  label: string;
  amount_cents: Cents;
}

export interface PricingResult {
  version: 1;
  lines: LineResult[];
  list_subtotal_cents: Cents;
  volume_savings_cents: Cents;
  subtotal_cents: Cents;
  applied_discounts: AppliedDiscount[];
  rejected_discounts: RejectedDiscount[];
  discount_cents: Cents;
  delivery_fee_cents: Cents;
  delivery_fee_waived: boolean;
  tax_mode: TaxMode;
  tax_rate_percent: number;
  /** Added on top of the total (exclusive mode). */
  tax_cents: Cents;
  /** Informational: tax contained in the prices (inclusive mode). */
  tax_included_cents: Cents;
  total_cents: Cents;
  steps: BreakdownStep[];
}

export class PricingError extends Error {
  constructor(
    public code: "unknown_product" | "inactive_product" | "invalid_quantity" | "missing_price" | "invalid_stages",
    message: string,
    public index?: number,
  ) {
    super(message);
    this.name = "PricingError";
  }
}
