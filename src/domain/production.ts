// Production steps and deadline risk.

export type StepStatus = "pending" | "in_progress" | "done" | "skipped";

export interface ProductionStepLike {
  id: string;
  position: number;
  status: StepStatus;
  assigned_to: string | null;
  requires_assignment: boolean;
  estimated_minutes: number | null;
}

export type StepAction = "claim" | "complete" | "reassign" | "none";

export interface Actor {
  user_id: string;
  can_work: boolean; // production.work
  can_manage: boolean; // production.manage
}

/**
 * What the current user may do with a step. Mirrors `complete_production_step`
 * / `assign_production_step` in the database, which is what enforces it.
 *  - a step assigned to me: I can complete it
 *  - a free step: I can take it (and complete it if it does not require assignment)
 *  - someone else's step: only a manager can reassign or complete it
 */
export function stepActions(step: ProductionStepLike, actor: Actor): StepAction[] {
  if (step.status === "done" || step.status === "skipped") return ["none"];
  if (actor.can_manage) return ["complete", "reassign"];
  if (!actor.can_work) return ["none"];
  if (step.assigned_to === actor.user_id) return ["complete"];
  if (!step.assigned_to) return step.requires_assignment ? ["claim"] : ["claim", "complete"];
  return ["none"];
}

export type RiskLevel = "normal" | "approaching" | "at_risk" | "overdue";

export const RISK_LABEL: Record<RiskLevel, string> = {
  normal: "En tiempo",
  approaching: "Por vencer",
  at_risk: "En riesgo",
  overdue: "Atrasada",
};

export interface RiskSettings {
  /** Warn when the promised time is closer than this. */
  approaching_hours: number;
}

/**
 * - overdue: the promised time has passed
 * - at_risk: the remaining estimated work does not fit before the promise
 * - approaching: the promise is within `approaching_hours`
 */
export function riskLevel(
  promisedAt: string | null,
  now: Date,
  remainingMinutes: number,
  settings: RiskSettings,
): RiskLevel {
  if (!promisedAt) return "normal";
  const promised = new Date(promisedAt).getTime();
  const t = now.getTime();
  if (t > promised) return "overdue";
  if (t + remainingMinutes * 60_000 > promised) return "at_risk";
  if (promised - t <= settings.approaching_hours * 3_600_000) return "approaching";
  return "normal";
}

export const remainingMinutes = (steps: ProductionStepLike[]): number =>
  steps
    .filter((s) => s.status === "pending" || s.status === "in_progress")
    .reduce((sum, s) => sum + (s.estimated_minutes ?? 0), 0);
