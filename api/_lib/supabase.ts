import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.js";

let admin: SupabaseClient | null = null;

/** Service-role client. Bypasses RLS: only use it after checking access. */
export function adminClient(): SupabaseClient {
  admin ??= createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return admin;
}
