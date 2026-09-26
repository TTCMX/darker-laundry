// POST /api/integrations/save — stores provider credentials. Secrets are
// written to tenant_secrets (never readable from the browser) and only a
// masked hint is kept in the tenant-visible config.
import { requireMember, requirePermission, requireUser } from "../_lib/auth.js";
import { handle, HttpError, json, readJson } from "../_lib/http.js";
import { paymentProvider } from "../_lib/providers/payments.js";
import { adminClient } from "../_lib/supabase.js";

interface Body {
  tenant_id: string;
  provider: "mercadopago" | "resend";
  enabled: boolean;
  secrets?: Record<string, string | null | undefined>;
  config?: Record<string, unknown>;
}

const mask = (v: string) => (v.length <= 8 ? "••••" : `${v.slice(0, 4)}…${v.slice(-4)}`);

export const POST = handle(async (request) => {
  const user = await requireUser(request);
  const body = await readJson<Body>(request);
  const member = await requireMember(user.id, body.tenant_id);
  requirePermission(member, "settings.manage");
  if (!["mercadopago", "resend"].includes(body.provider)) throw new HttpError(400, "Unknown provider");

  const db = adminClient();
  const { data: current } = await db
    .from("tenant_secrets")
    .select("secrets")
    .eq("tenant_id", body.tenant_id)
    .eq("provider", body.provider)
    .maybeSingle();
  const secrets: Record<string, string> = { ...((current?.secrets as Record<string, string>) ?? {}) };
  for (const [k, v] of Object.entries(body.secrets ?? {})) {
    if (v === null) delete secrets[k];
    else if (typeof v === "string" && v.trim()) secrets[k] = v.trim();
  }

  const config: Record<string, unknown> = { ...(body.config ?? {}) };
  if (body.provider === "mercadopago") {
    if (body.enabled && !secrets.access_token) throw new HttpError(422, "An access token is required");
    if (secrets.access_token) {
      const check = await paymentProvider("mercadopago").verifyCredentials({ access_token: secrets.access_token });
      if (!check.ok) throw new HttpError(422, "MercadoPago rejected the access token");
      config.account = check.account;
      config.access_token_hint = mask(secrets.access_token);
      config.test_mode = secrets.access_token.startsWith("TEST-");
    }
    config.webhook_secret_set = Boolean(secrets.webhook_secret);
  } else {
    if (body.enabled && (!secrets.api_key || !secrets.from)) throw new HttpError(422, "API key and sender are required");
    if (secrets.api_key) config.api_key_hint = mask(secrets.api_key);
    if (secrets.from) config.from = secrets.from;
  }

  const { error: e1 } = await db
    .from("tenant_secrets")
    .upsert({ tenant_id: body.tenant_id, provider: body.provider, secrets }, { onConflict: "tenant_id,provider" });
  if (e1) throw e1;
  const { error: e2 } = await db
    .from("tenant_integrations")
    .upsert({ tenant_id: body.tenant_id, provider: body.provider, enabled: body.enabled, config }, { onConflict: "tenant_id,provider" });
  if (e2) throw e2;
  return json({ ok: true, config });
});
