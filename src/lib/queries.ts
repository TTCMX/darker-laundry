import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PricingContext } from "../domain/pricing";
import { useToast } from "../ui/components";
import { api } from "./api";
import { errorMessage } from "./errors";
import { useTenant } from "./session";
import { supabase } from "./supabase";
import type { Category, DiscountRow, PricingRuleRow, Product, Role, TeamMember, Workflow, WorkflowStep, Zone } from "./types";

export function useCatalog() {
  const { tenantId, settings } = useTenant();
  const q = useQuery({
    queryKey: ["catalog", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const [categories, products, rules, discounts, zones] = await Promise.all([
        supabase.from("product_categories").select("*").eq("tenant_id", tenantId).order("sort_order").order("name"),
        supabase.from("products").select("*").eq("tenant_id", tenantId).order("sort_order").order("name"),
        supabase.from("pricing_rules").select("*").eq("tenant_id", tenantId).order("priority", { ascending: false }),
        supabase.from("discounts").select("*").eq("tenant_id", tenantId).order("name"),
        supabase.from("delivery_zones").select("*").eq("tenant_id", tenantId).order("sort_order").order("name"),
      ]);
      for (const r of [categories, products, rules, discounts, zones]) if (r.error) throw r.error;
      return {
        categories: (categories.data ?? []) as Category[],
        products: (products.data ?? []).map((p) => ({ ...p, base_price_cents: Number(p.base_price_cents) })) as Product[],
        rules: (rules.data ?? []) as PricingRuleRow[],
        discounts: (discounts.data ?? []).map((d) => ({ ...d, value: Number(d.value) })) as DiscountRow[],
        zones: (zones.data ?? []).map((z) => ({
          ...z,
          fee_cents: Number(z.fee_cents),
          free_over_cents: z.free_over_cents === null ? null : Number(z.free_over_cents),
          min_order_cents: z.min_order_cents === null ? null : Number(z.min_order_cents),
        })) as Zone[],
      };
    },
  });

  const pricingContext: PricingContext | null = q.data
    ? {
        products: q.data.products,
        volume_rules: q.data.rules,
        discounts: q.data.discounts.map((d) => ({ ...d, usage_count: 0 })),
        tax: settings.tax,
        settings: settings.pricing,
      }
    : null;
  return { ...q, pricingContext };
}

export function useTeam() {
  const { tenantId } = useTenant();
  return useQuery({
    queryKey: ["team", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("team_members", { p_tenant: tenantId });
      if (error) throw error;
      return (data ?? []) as TeamMember[];
    },
  });
}

export function useRoles() {
  const { tenantId } = useTenant();
  return useQuery({
    queryKey: ["roles", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const [roles, perms] = await Promise.all([
        supabase.from("roles").select("*").eq("tenant_id", tenantId).order("is_owner", { ascending: false }).order("name"),
        supabase.from("role_permissions").select("role_id, permission").eq("tenant_id", tenantId),
      ]);
      if (roles.error) throw roles.error;
      if (perms.error) throw perms.error;
      const byRole = new Map<string, string[]>();
      for (const p of perms.data ?? []) byRole.set(p.role_id, [...(byRole.get(p.role_id) ?? []), p.permission]);
      return ((roles.data ?? []) as Role[]).map((r) => ({ ...r, permissions: byRole.get(r.id) ?? [] }));
    },
  });
}

export function useWorkflows() {
  const { tenantId } = useTenant();
  return useQuery({
    queryKey: ["workflows", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const [w, s] = await Promise.all([
        supabase.from("workflows").select("*").eq("tenant_id", tenantId).order("created_at"),
        supabase.from("workflow_steps").select("*").eq("tenant_id", tenantId).order("position"),
      ]);
      if (w.error) throw w.error;
      if (s.error) throw s.error;
      return { workflows: (w.data ?? []) as Workflow[], steps: (s.data ?? []) as WorkflowStep[] };
    },
  });
}

/** Member names by user id, for "assigned to / completed by". */
export function useMemberNames() {
  const team = useTeam();
  const map = new Map((team.data ?? []).map((m) => [m.user_id, m.display_name]));
  return (userId: string | null | undefined) => (userId ? (map.get(userId) ?? "—") : "—");
}

/**
 * Runs a database function (or any async action) with the standard UX:
 * toast on error, invalidate the listed queries on success.
 */
export function useAction<TArgs>(
  fn: (args: TArgs) => Promise<unknown>,
  opts: { invalidate?: string[][]; success?: string; dispatch?: boolean } = {},
) {
  const qc = useQueryClient();
  const toast = useToast();
  const { tenantId } = useTenant();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of opts.invalidate ?? [["orders"], ["order"], ["board"], ["dashboard"]]) qc.invalidateQueries({ queryKey: key });
      if (opts.success) toast.show(opts.success);
      // Actions may queue automatic notifications: send them right away.
      if (opts.dispatch !== false && tenantId) api("/api/notifications/dispatch", { tenant_id: tenantId }).catch(() => {});
    },
    onError: (err) => toast.show(errorMessage(err), { error: true }),
  });
}

/** supabase.rpc that throws on error. */
export async function rpc<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data as T;
}

export async function signedUrl(path: string) {
  const { data } = await supabase.storage.from("evidence").createSignedUrl(path, 3600);
  return data?.signedUrl ?? null;
}

export async function uploadEvidence(tenantId: string, file: File, folder: string) {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
  const path = `${tenantId}/${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage.from("evidence").upload(path, file, { contentType: file.type || "image/jpeg" });
  if (error) throw error;
  return path;
}
