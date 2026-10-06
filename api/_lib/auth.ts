import { PERMISSION_CODES, type Permission } from "../../src/domain/permissions.js";
import { allowedReadOnly, tenantAccess } from "../../src/domain/plan.js";
import { HttpError } from "./http.js";
import { adminClient } from "./supabase.js";

export interface AuthUser {
  id: string;
  email: string | null;
}

/** Verifies the Supabase session sent as "Authorization: Bearer <jwt>". */
export async function requireUser(request: Request): Promise<AuthUser> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "Authentication required");
  const { data, error } = await adminClient().auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Invalid session");
  return { id: data.user.id, email: data.user.email ?? null };
}

export interface Membership {
  tenant_id: string;
  permissions: Set<Permission>;
}

/** Loads the user's active membership in a tenant (403 if none). */
export async function requireMember(userId: string, tenantId: string): Promise<Membership> {
  if (!tenantId) throw new HttpError(400, "tenant_id is required");
  const db = adminClient();
  const { data: member } = await db
    .from("tenant_members")
    .select("role_id, roles!inner(is_owner), tenants!inner(plan, plan_status, trial_ends_at)")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .eq("active", true)
    .maybeSingle();
  if (!member) throw new HttpError(403, "Not a member of this business");

  const row = member as unknown as {
    role_id: string;
    roles: { is_owner: boolean };
    tenants: { plan: string; plan_status: string; trial_ends_at: string | null };
  };
  const role = row.roles;
  let permissions: Permission[];
  if (role.is_owner) {
    permissions = PERMISSION_CODES;
  } else {
    const { data } = await db.from("role_permissions").select("permission").eq("role_id", member.role_id);
    permissions = (data ?? []).map((r) => r.permission as Permission);
  }
  // Trial over / suspended: read-only, exactly like the database enforces.
  if (tenantAccess(row.tenants) === "read_only") permissions = permissions.filter(allowedReadOnly);
  return { tenant_id: tenantId, permissions: new Set(permissions) };
}

export function requirePermission(m: Membership, ...anyOf: Permission[]) {
  if (!anyOf.some((p) => m.permissions.has(p))) {
    throw new HttpError(403, `Missing permission ${anyOf.join(" or ")}`);
  }
}
