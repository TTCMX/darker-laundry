import type { Session, User } from "@supabase/supabase-js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Permission } from "../domain/permissions";
import { allowedReadOnly, type Access } from "../domain/plan";
import { operation, type Operation, type OperationModel } from "../domain/operation";
import { resolveSettings, type TenantSettings } from "../domain/settings";
import { setFormatContext } from "./format";
import { supabase } from "./supabase";

// ── Auth ────────────────────────────────────────────────────────────────────

interface AuthState {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({ session: null, user: null, loading: true, signOut: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setLoading(false);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    qc.clear();
  }, [qc]);

  return (
    <AuthContext.Provider value={{ session, user: session?.user ?? null, loading, signOut }}>{children}</AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

// ── Tenant membership ───────────────────────────────────────────────────────

export interface Membership {
  member_id: string;
  tenant_id: string;
  tenant_name: string;
  slug: string;
  logo_url: string | null;
  country: string;
  currency: string;
  timezone: string;
  settings: unknown;
  display_name: string;
  role_id: string;
  role_name: string;
  role_home: "backoffice" | "courier";
  is_owner: boolean;
  permissions: Permission[];
  plan: string;
  plan_status: string;
  created_at: string | null;
  trial_ends_at: string | null;
  access: Access;
  operation_model: OperationModel;
}

interface TenantState {
  memberships: Membership[];
  loading: boolean;
  tenant: Membership | null;
  tenantId: string;
  settings: TenantSettings;
  /** Counter only / home delivery only / hybrid: which features apply. */
  ops: Operation;
  can: (...anyOf: Permission[]) => boolean;
  switchTenant: (id: string) => void;
  refresh: () => Promise<unknown>;
}

const TenantContext = createContext<TenantState | null>(null);

const STORAGE_KEY = "dlos.tenant";
const readStored = () => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};
const writeStored = (v: string) => {
  try {
    localStorage.setItem(STORAGE_KEY, v);
  } catch {
    /* private mode: selection just isn't remembered */
  }
};

export function TenantProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [selected, setSelected] = useState<string | null>(readStored);
  const q = useQuery({
    queryKey: ["memberships", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_memberships");
      if (error) throw error;
      return (data ?? []) as Membership[];
    },
  });

  const memberships = useMemo(() => q.data ?? [], [q.data]);
  const tenant = memberships.find((m) => m.tenant_id === selected) ?? memberships[0] ?? null;
  const settings = useMemo(() => resolveSettings(tenant?.settings), [tenant?.settings]);

  useEffect(() => {
    if (tenant) setFormatContext({ currency: tenant.currency, timezone: tenant.timezone, locale: settings.locale });
  }, [tenant, settings.locale]);

  // Read-only business (trial over): only what the database still allows.
  const perms = useMemo(
    () => new Set((tenant?.permissions ?? []).filter((p) => tenant?.access !== "read_only" || allowedReadOnly(p))),
    [tenant],
  );
  const can = useCallback((...anyOf: Permission[]) => anyOf.some((p) => perms.has(p)), [perms]);

  const value: TenantState = {
    memberships,
    loading: q.isLoading,
    tenant,
    tenantId: tenant?.tenant_id ?? "",
    settings,
    ops: operation(tenant?.operation_model),
    can,
    switchTenant: (id) => {
      writeStored(id);
      setSelected(id);
    },
    refresh: q.refetch,
  };
  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export function useTenant() {
  const ctx = useContext(TenantContext);
  if (!ctx) throw new Error("useTenant outside TenantProvider");
  return ctx;
}
