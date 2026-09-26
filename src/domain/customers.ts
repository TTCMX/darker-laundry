// Customer lifecycle status. Thresholds are tenant settings, not constants:
// a dry cleaner and a weekly wash & fold service have very different rhythms.
// The database view `customer_overview` computes the same thing for lists.

export type CustomerStatus = "new" | "active" | "at_risk" | "inactive" | "churned";

export const CUSTOMER_STATUS_LABEL: Record<CustomerStatus, string> = {
  new: "Nuevo",
  active: "Activo",
  at_risk: "En riesgo",
  inactive: "Inactivo",
  churned: "Perdido",
};

export interface CustomerStatusRules {
  /** Days since last order to still count as active. */
  active_days: number;
  /** Up to this many days: at risk. */
  at_risk_days: number;
  /** Up to this many days: inactive. Beyond: churned. */
  churned_days: number;
}

export const DEFAULT_CUSTOMER_RULES: CustomerStatusRules = {
  active_days: 30,
  at_risk_days: 60,
  churned_days: 120,
};

export function customerStatus(
  totalOrders: number,
  lastOrderAt: string | null,
  now: Date,
  rules: CustomerStatusRules = DEFAULT_CUSTOMER_RULES,
): CustomerStatus {
  if (!lastOrderAt || totalOrders === 0) return "new";
  const days = (now.getTime() - new Date(lastOrderAt).getTime()) / 86_400_000;
  if (days <= rules.active_days) return totalOrders <= 1 ? "new" : "active";
  if (days <= rules.at_risk_days) return "at_risk";
  if (days <= rules.churned_days) return "inactive";
  return "churned";
}
