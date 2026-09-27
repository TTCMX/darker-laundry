// The pricing engine: the single source of truth for every amount charged.
//
// It is pure (no I/O, no clock, no globals), so the exact same function runs
// in the browser for the live quote and on the server when the order is
// saved. The server always recomputes; the stored result is what the
// customer sees on the receipt and the tracking page, so the breakdown shown
// equals the amount charged by construction.

import { allocate, percentOf, type Cents } from "../money.js";
import {
  PricingError,
  type AppliedDiscount,
  type BreakdownStep,
  type Discount,
  type LineResult,
  type PricingContext,
  type PricingInput,
  type PricingProduct,
  type PricingResult,
  type PricingStage,
  type RejectedDiscount,
  type VolumeRule,
} from "./types.js";

export const DEFAULT_STAGES: PricingStage[] = [
  "volume",
  "discounts",
  "membership",
  "credits",
  "delivery_fee",
  "tax",
];

const QTY_EPSILON = 1e-9;

const inWindow = (now: Date, startsAt: string | null, endsAt: string | null) => {
  if (startsAt && now < new Date(startsAt)) return "not_started" as const;
  if (endsAt && now > new Date(endsAt)) return "expired" as const;
  return null;
};

export function validateStages(stages: PricingStage[]): void {
  const known = new Set(DEFAULT_STAGES);
  const seen = new Set<PricingStage>();
  for (const s of stages) {
    if (!known.has(s)) throw new PricingError("invalid_stages", `Unknown pricing stage "${s}"`);
    if (seen.has(s)) throw new PricingError("invalid_stages", `Duplicated pricing stage "${s}"`);
    seen.add(s);
  }
  // Volume sets the gross price everything else is computed on, and tax is
  // computed on the final amounts: those two positions are not configurable.
  if (stages[0] !== "volume") throw new PricingError("invalid_stages", `"volume" must be the first stage`);
  if (stages[stages.length - 1] !== "tax") throw new PricingError("invalid_stages", `"tax" must be the last stage`);
}

/** Best volume price for a line, or null when no rule applies. */
export function volumePrice(
  rules: VolumeRule[],
  product: PricingProduct,
  quantity: number,
  now: Date,
): { rule: VolumeRule; total: Cents } | null {
  const candidates = rules
    .filter((r) => r.active && !inWindow(now, r.starts_at, r.ends_at))
    .filter((r) =>
      r.product_id ? r.product_id === product.id : r.category_id ? r.category_id === product.category_id : false,
    )
    // Product-specific rules beat category rules; then explicit priority.
    .sort((a, b) => Number(!!b.product_id) - Number(!!a.product_id) || b.priority - a.priority);

  for (const rule of candidates) {
    const isInteger = Math.abs(quantity - Math.round(quantity)) < QTY_EPSILON;
    const pkg = isInteger ? rule.config.packages?.find((p) => p.qty === Math.round(quantity)) : undefined;
    if (pkg) return { rule, total: pkg.total_cents };
    const tier = [...(rule.config.tiers ?? [])]
      .filter((t) => quantity + QTY_EPSILON >= t.min_qty)
      .sort((a, b) => b.min_qty - a.min_qty)[0];
    if (tier) return { rule, total: Math.round(tier.unit_price_cents * quantity) };
  }
  return null;
}

function buildLines(input: PricingInput, ctx: PricingContext): LineResult[] {
  const byId = new Map(ctx.products.map((p) => [p.id, p]));
  return input.items.map((item, index) => {
    if (!(item.quantity > 0) || !Number.isFinite(item.quantity)) {
      throw new PricingError("invalid_quantity", `Line ${index + 1}: quantity must be greater than zero`, index);
    }
    const product = item.product_id ? byId.get(item.product_id) : undefined;
    if (item.product_id && !product) {
      throw new PricingError("unknown_product", `Line ${index + 1}: product not found`, index);
    }
    if (product && !product.active) {
      throw new PricingError("inactive_product", `Line ${index + 1}: product "${product.name}" is inactive`, index);
    }
    const customPrice = !product || product.variable_price;
    const unitPrice = customPrice ? item.unit_price_cents : product.base_price_cents;
    if (unitPrice === null || unitPrice === undefined || !Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new PricingError("missing_price", `Line ${index + 1}: a price is required`, index);
    }
    const unitPriceCents = Math.round(unitPrice);
    const listTotal = Math.round(unitPriceCents * item.quantity);
    return {
      index,
      product_id: product?.id ?? null,
      sku: product?.sku ?? null,
      name: product?.name ?? (item.name?.trim() || "Servicio"),
      unit: product?.unit ?? "item",
      category_id: product?.category_id ?? null,
      quantity: item.quantity,
      unit_price_cents: unitPriceCents,
      list_total_cents: listTotal,
      volume_rule_id: null,
      volume_savings_cents: 0,
      gross_cents: listTotal,
      discount_cents: 0,
      net_cents: listTotal,
      taxable: product?.taxable ?? true,
      custom_price: customPrice,
      notes: item.notes ?? null,
    };
  });
}

function applyVolume(lines: LineResult[], input: PricingInput, ctx: PricingContext) {
  const byId = new Map(ctx.products.map((p) => [p.id, p]));
  for (const line of lines) {
    if (line.custom_price || !line.product_id) continue;
    const product = byId.get(line.product_id)!;
    const vp = volumePrice(ctx.volume_rules, product, line.quantity, input.now);
    // Volume pricing never makes a line more expensive than list price.
    if (vp && vp.total < line.list_total_cents) {
      line.volume_rule_id = vp.rule.id;
      line.volume_savings_cents = line.list_total_cents - vp.total;
      line.gross_cents = vp.total;
      line.net_cents = vp.total;
    }
  }
}

const isEligible = (line: LineResult, d: Discount) => {
  if (!d.product_ids.length && !d.category_ids.length) return true;
  return (
    (!!line.product_id && d.product_ids.includes(line.product_id)) ||
    (!!line.category_id && d.category_ids.includes(line.category_id))
  );
};

function applyDiscounts(
  lines: LineResult[],
  input: PricingInput,
  ctx: PricingContext,
): { applied: AppliedDiscount[]; rejected: RejectedDiscount[] } {
  const applied: AppliedDiscount[] = [];
  const rejected: RejectedDiscount[] = [];
  const byId = new Map(ctx.discounts.map((d) => [d.id, d]));
  const subtotal = lines.reduce((s, l) => s + l.gross_cents, 0);
  const uniqueIds = [...new Set(input.discount_ids)];

  for (const id of uniqueIds) {
    const d = byId.get(id);
    if (!d) {
      rejected.push({ id, reason: "not_found" });
      continue;
    }
    if (!d.active) {
      rejected.push({ id, reason: "inactive" });
      continue;
    }
    const windowIssue = inWindow(input.now, d.starts_at, d.ends_at);
    if (windowIssue) {
      rejected.push({ id, reason: windowIssue });
      continue;
    }
    if (d.usage_limit !== null && d.usage_count >= d.usage_limit) {
      rejected.push({ id, reason: "usage_limit" });
      continue;
    }
    if (d.min_order_cents !== null && subtotal < d.min_order_cents) {
      rejected.push({ id, reason: "min_order" });
      continue;
    }
    const eligible = lines.filter((l) => isEligible(l, d));
    const remaining = eligible.map((l) => Math.max(0, l.gross_cents - l.discount_cents));
    const remainingTotal = remaining.reduce((s, v) => s + v, 0);
    if (!eligible.length || remainingTotal <= 0) {
      rejected.push({ id, reason: "no_eligible_items" });
      continue;
    }

    const base =
      ctx.settings.discount_stacking === "sequential"
        ? remainingTotal
        : eligible.reduce((s, l) => s + l.gross_cents, 0);

    let amount =
      d.kind === "percentage" ? percentOf(base, Math.min(100, Math.max(0, d.value))) : Math.max(0, Math.round(d.value));
    if (d.max_discount_cents !== null) amount = Math.min(amount, d.max_discount_cents);
    // Discounts can never push the eligible lines below zero.
    amount = Math.min(amount, remainingTotal);

    const parts = allocate(amount, remaining);
    eligible.forEach((line, i) => {
      line.discount_cents += parts[i]!;
      line.net_cents = line.gross_cents - line.discount_cents;
    });
    applied.push({ id: d.id, name: d.name, kind: d.kind, value: d.value, amount_cents: amount });
  }
  return { applied, rejected };
}

export function quote(input: PricingInput, ctx: PricingContext): PricingResult {
  const stages = ctx.settings.stages?.length ? ctx.settings.stages : DEFAULT_STAGES;
  validateStages(stages);

  const lines = buildLines(input, ctx);
  let applied: AppliedDiscount[] = [];
  let rejected: RejectedDiscount[] = [];
  let deliveryFee: Cents = 0;
  let deliveryWaived = false;
  let taxCents: Cents = 0;
  let taxIncluded: Cents = 0;

  const netTotal = () => lines.reduce((s, l) => s + l.net_cents, 0);

  for (const stage of stages) {
    switch (stage) {
      case "volume":
        applyVolume(lines, input, ctx);
        break;
      case "discounts":
        ({ applied, rejected } = applyDiscounts(lines, input, ctx));
        break;
      case "membership":
      case "credits":
        // Extension points for the Loyalty / Memberships modules (V1).
        break;
      case "delivery_fee": {
        // An order booked before knowing what the customer sends has nothing
        // to charge yet: the fee is computed once items are captured.
        if (!lines.length) break;
        if (input.delivery_fee_override_cents !== null && input.delivery_fee_override_cents !== undefined) {
          deliveryFee = Math.max(0, Math.round(input.delivery_fee_override_cents));
        } else if (input.delivery) {
          const free = input.delivery.free_over_cents;
          deliveryWaived = free !== null && netTotal() >= free;
          deliveryFee = deliveryWaived ? 0 : Math.max(0, input.delivery.fee_cents);
        }
        break;
      }
      case "tax": {
        const { mode, rate_percent: rate, delivery_fee_taxable } = ctx.tax;
        if (mode === "none" || rate <= 0) break;
        const taxableBase =
          lines.filter((l) => l.taxable).reduce((s, l) => s + l.net_cents, 0) + (delivery_fee_taxable ? deliveryFee : 0);
        if (mode === "exclusive") taxCents = percentOf(taxableBase, rate);
        else taxIncluded = taxableBase - Math.round(taxableBase / (1 + rate / 100));
        break;
      }
    }
  }

  const listSubtotal = lines.reduce((s, l) => s + l.list_total_cents, 0);
  const volumeSavings = lines.reduce((s, l) => s + l.volume_savings_cents, 0);
  const subtotal = lines.reduce((s, l) => s + l.gross_cents, 0);
  const discount = lines.reduce((s, l) => s + l.discount_cents, 0);
  const total = subtotal - discount + deliveryFee + taxCents;

  const steps: BreakdownStep[] = [{ key: "list_subtotal", label: "Subtotal", amount_cents: listSubtotal }];
  if (volumeSavings) steps.push({ key: "volume", label: "Precio por volumen", amount_cents: -volumeSavings });
  for (const d of applied) steps.push({ key: `discount:${d.id}`, label: d.name, amount_cents: -d.amount_cents });
  if (lines.length && (deliveryFee || deliveryWaived || input.delivery)) {
    steps.push({
      key: "delivery_fee",
      label: deliveryWaived ? "Envío (gratis)" : "Envío",
      amount_cents: deliveryFee,
    });
  }
  if (taxCents) steps.push({ key: "tax", label: `Impuestos (${ctx.tax.rate_percent}%)`, amount_cents: taxCents });
  steps.push({ key: "total", label: "Total", amount_cents: total });

  return {
    version: 1,
    lines,
    list_subtotal_cents: listSubtotal,
    volume_savings_cents: volumeSavings,
    subtotal_cents: subtotal,
    applied_discounts: applied,
    rejected_discounts: rejected,
    discount_cents: discount,
    delivery_fee_cents: deliveryFee,
    delivery_fee_waived: deliveryWaived,
    tax_mode: ctx.tax.mode,
    tax_rate_percent: ctx.tax.rate_percent,
    tax_cents: taxCents,
    tax_included_cents: taxIncluded,
    total_cents: total,
    steps,
  };
}
