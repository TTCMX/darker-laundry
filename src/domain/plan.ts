// Subscription state of a business. For now every business gets a free trial
// with every feature; when it ends the business becomes read-only. The
// database enforces it (app.tenant_access / app.allowed_read_only); the UI
// mirrors it to hide what can't be done.

import type { Permission } from "./permissions.js";

export type Access = "full" | "read_only";

export const TRIAL_MONTHS = 3;
/** Show the "trial ending" notice this many days before the end. */
export const TRIAL_WARNING_DAYS = 15;

/** Besides every "*.view" permission, these still work in read-only mode. */
export const READ_ONLY_EXTRA: Permission[] = ["settings.manage", "team.manage"];

export const allowedReadOnly = (p: Permission) => p.endsWith(".view") || READ_ONLY_EXTRA.includes(p);

/** Same rule as app.tenant_access in the database. */
export function tenantAccess(t: { plan: string; plan_status: string; trial_ends_at: string | null }, now = new Date()): Access {
  if (t.plan_status === "suspended" || t.plan_status === "cancelled") return "read_only";
  if (t.plan === "trial" && t.trial_ends_at && new Date(t.trial_ends_at).getTime() <= now.getTime()) return "read_only";
  return "full";
}

export interface PlanState {
  plan: string;
  plan_status: string;
  created_at: string | null;
  trial_ends_at: string | null;
  access: Access;
}

export interface PlanInfo {
  kind: "trial" | "trial_over" | "suspended" | "active";
  readOnly: boolean;
  /** Whole days left in the trial (0 on the last day). */
  daysLeft: number | null;
  /** 0..1 of the trial used. */
  progress: number | null;
}

export function planInfo(s: PlanState, now = new Date()): PlanInfo {
  const readOnly = s.access === "read_only";
  if (s.plan_status === "suspended" || s.plan_status === "cancelled") return { kind: "suspended", readOnly, daysLeft: null, progress: null };
  if (s.plan !== "trial" || !s.trial_ends_at) return { kind: "active", readOnly, daysLeft: null, progress: null };
  const end = new Date(s.trial_ends_at).getTime();
  const left = end - now.getTime();
  if (left <= 0) return { kind: "trial_over", readOnly: true, daysLeft: 0, progress: 1 };
  const start = s.created_at ? new Date(s.created_at).getTime() : end - TRIAL_MONTHS * 30 * 86_400_000;
  return {
    kind: "trial",
    readOnly,
    daysLeft: Math.floor(left / 86_400_000),
    progress: Math.min(1, Math.max(0, (now.getTime() - start) / Math.max(1, end - start))),
  };
}
