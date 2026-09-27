import { describe, expect, it } from "vitest";
import { customerStatus } from "./customers.js";
import { allocate, formatMoney } from "./money.js";
import { canTransition } from "./orders.js";
import { derivePaymentState, type LedgerEntry } from "./payments.js";
import { normalizePhone } from "./phone.js";
import { riskLevel, stepActions, type ProductionStepLike } from "./production.js";
import { DEFAULT_SETTINGS, resolveSettings } from "./settings.js";
import { renderTemplate } from "./templates.js";

describe("allocate", () => {
  it("splits exactly, remainder to the last weight", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([33, 33, 34]);
    expect(allocate(1000, [0, 3, 0, 1])).toEqual([0, 750, 0, 250]);
    expect(allocate(7, [0, 0])).toEqual([0, 0]);
    const parts = allocate(9999, [17, 23, 31, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(9999);
  });

  it("formats money", () => {
    expect(formatMoney(123456)).toContain("1,234.56");
  });
});

describe("normalizePhone", () => {
  const cases: [string, string | null][] = [
    ["55 1234 5678", "+525512345678"],
    ["(55) 1234-5678", "+525512345678"],
    ["+52 55 1234 5678", "+525512345678"],
    ["+52 1 55 1234 5678", "+525512345678"],
    ["525512345678", "+525512345678"],
    ["0052 55 1234 5678", "+525512345678"],
    ["+1 415 555 0100", "+14155550100"],
    ["12345", null],
    ["", null],
    ["abc", null],
  ];
  it.each(cases)("%s → %s", (raw, expected) => {
    expect(normalizePhone(raw, "MX")).toBe(expected);
  });

  it("uses the tenant default country for national numbers", () => {
    expect(normalizePhone("415 555 0100", "US")).toBe("+14155550100");
    expect(normalizePhone("612 345 678", "ES")).toBe("+34612345678");
  });
});

describe("derivePaymentState", () => {
  const e = (kind: LedgerEntry["kind"], amount: number, status: LedgerEntry["status"] = "succeeded", t = "1"): LedgerEntry => ({
    kind,
    status,
    amount_cents: amount,
    created_at: t,
  });

  it("pending → partial → paid", () => {
    expect(derivePaymentState(10000, []).status).toBe("pending");
    expect(derivePaymentState(10000, [e("payment", 4000)])).toEqual({
      amount_paid_cents: 4000,
      balance_cents: 6000,
      status: "partially_paid",
    });
    expect(derivePaymentState(10000, [e("payment", 4000), e("payment", 6000)]).status).toBe("paid");
  });

  it("ignores failed and pending entries in the amounts", () => {
    const s = derivePaymentState(10000, [e("payment", 10000, "failed", "2")]);
    expect(s.status).toBe("failed");
    expect(s.balance_cents).toBe(10000);
    expect(derivePaymentState(10000, [e("payment", 10000, "pending")]).status).toBe("pending");
  });

  it("refunds", () => {
    expect(derivePaymentState(10000, [e("payment", 10000), e("refund", 10000)]).status).toBe("refunded");
    expect(derivePaymentState(10000, [e("payment", 10000), e("refund", 3000)]).status).toBe("partially_paid");
  });

  it("zero-total orders are paid, unless they have no items yet", () => {
    expect(derivePaymentState(0, []).status).toBe("paid");
    expect(derivePaymentState(0, [], false).status).toBe("pending");
  });
});

describe("order transitions", () => {
  it("allows the main path and blocks leaving terminal states", () => {
    expect(canTransition("created", "picked_up")).toBe(true);
    expect(canTransition("ready", "delivered")).toBe(true);
    expect(canTransition("delivered", "ready")).toBe(false);
    expect(canTransition("cancelled", "created")).toBe(false);
  });
});

describe("production", () => {
  const step = (over: Partial<ProductionStepLike> = {}): ProductionStepLike => ({
    id: "s",
    position: 1,
    status: "pending",
    assigned_to: null,
    requires_assignment: false,
    estimated_minutes: 30,
    ...over,
  });
  const worker = { user_id: "me", can_work: true, can_manage: false };
  const manager = { user_id: "boss", can_work: true, can_manage: true };

  it("assignment rules", () => {
    expect(stepActions(step({ assigned_to: "me" }), worker)).toEqual(["complete"]);
    expect(stepActions(step(), worker)).toEqual(["claim", "complete"]);
    expect(stepActions(step({ requires_assignment: true }), worker)).toEqual(["claim"]);
    expect(stepActions(step({ assigned_to: "other" }), worker)).toEqual(["none"]);
    expect(stepActions(step({ assigned_to: "other" }), manager)).toEqual(["complete", "reassign"]);
    expect(stepActions(step({ status: "done" }), manager)).toEqual(["none"]);
    expect(stepActions(step(), { user_id: "x", can_work: false, can_manage: false })).toEqual(["none"]);
  });

  it("risk levels", () => {
    const now = new Date("2026-06-15T12:00:00Z");
    const s = { approaching_hours: 12 };
    expect(riskLevel(null, now, 0, s)).toBe("normal");
    expect(riskLevel("2026-06-15T11:00:00Z", now, 0, s)).toBe("overdue");
    expect(riskLevel("2026-06-15T13:00:00Z", now, 120, s)).toBe("at_risk");
    expect(riskLevel("2026-06-15T20:00:00Z", now, 60, s)).toBe("approaching");
    expect(riskLevel("2026-06-17T12:00:00Z", now, 60, s)).toBe("normal");
  });
});

describe("customer status", () => {
  const now = new Date("2026-06-15T12:00:00Z");
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
  it("uses configurable thresholds", () => {
    expect(customerStatus(0, null, now)).toBe("new");
    expect(customerStatus(1, daysAgo(3), now)).toBe("new");
    expect(customerStatus(5, daysAgo(3), now)).toBe("active");
    expect(customerStatus(5, daysAgo(45), now)).toBe("at_risk");
    expect(customerStatus(5, daysAgo(90), now)).toBe("inactive");
    expect(customerStatus(5, daysAgo(200), now)).toBe("churned");
    expect(customerStatus(5, daysAgo(10), now, { active_days: 7, at_risk_days: 14, churned_days: 21 })).toBe("at_risk");
  });
});

describe("templates and settings", () => {
  it("renders variables and blanks unknown ones", () => {
    expect(renderTemplate("Hola {{ customer_name }}, tu orden #{{order_number}} {{nope}}", {
      customer_name: "Ana",
      order_number: 12,
    })).toBe("Hola Ana, tu orden #12 ");
  });

  it("merges partial stored settings over defaults", () => {
    const s = resolveSettings({ tax: { mode: "exclusive" }, delivery: { windows: [] } });
    expect(s.tax).toEqual({ ...DEFAULT_SETTINGS.tax, mode: "exclusive" });
    expect(s.delivery.windows).toEqual([]);
    expect(s.operations).toEqual(DEFAULT_SETTINGS.operations);
    expect(resolveSettings(null)).toEqual(DEFAULT_SETTINGS);
  });
});
