import { describe, expect, it } from "vitest";
import { allowedReadOnly, planInfo, tenantAccess } from "./plan.js";

const now = new Date("2026-10-01T12:00:00Z");
const base = { plan: "trial", plan_status: "active", created_at: "2026-09-01T12:00:00Z", trial_ends_at: "2026-12-01T12:00:00Z", access: "full" as const };

describe("plan", () => {
  it("trial: days left and progress", () => {
    const i = planInfo(base, now);
    expect(i.kind).toBe("trial");
    expect(i.readOnly).toBe(false);
    expect(i.daysLeft).toBe(61);
    expect(i.progress).toBeGreaterThan(0.3);
    expect(i.progress).toBeLessThan(0.35);
    expect(planInfo({ ...base, trial_ends_at: "2026-10-01T20:00:00Z" }, now).daysLeft).toBe(0);
  });

  it("trial over, suspended, exempt", () => {
    expect(planInfo({ ...base, trial_ends_at: "2026-09-30T00:00:00Z", access: "read_only" }, now)).toMatchObject({ kind: "trial_over", readOnly: true });
    expect(planInfo({ ...base, plan_status: "suspended", access: "read_only" }, now)).toMatchObject({ kind: "suspended", readOnly: true });
    expect(planInfo({ ...base, plan: "internal" }, now)).toMatchObject({ kind: "active", readOnly: false, daysLeft: null });
  });

  it("read-only keeps views, settings and team", () => {
    expect(allowedReadOnly("orders.view")).toBe(true);
    expect(allowedReadOnly("reports.view")).toBe(true);
    expect(allowedReadOnly("settings.manage")).toBe(true);
    expect(allowedReadOnly("orders.create")).toBe(false);
    expect(allowedReadOnly("payments.record")).toBe(false);
    expect(allowedReadOnly("delivery.execute")).toBe(false);
  });
  it("access mirrors app.tenant_access (used by the API)", () => {
    const now = new Date("2026-10-05T12:00:00Z");
    expect(tenantAccess({ plan: "trial", plan_status: "active", trial_ends_at: "2026-12-01T00:00:00Z" }, now)).toBe("full");
    expect(tenantAccess({ plan: "trial", plan_status: "active", trial_ends_at: "2026-10-01T00:00:00Z" }, now)).toBe("read_only");
    expect(tenantAccess({ plan: "internal", plan_status: "active", trial_ends_at: "2026-10-01T00:00:00Z" }, now)).toBe("full");
    expect(tenantAccess({ plan: "pro", plan_status: "suspended", trial_ends_at: null }, now)).toBe("read_only");
  });
});
