// GET /api/cron/daily — Vercel Cron. Sends anything left in the queue and
// expires old payment links. Vercel sends "Authorization: Bearer $CRON_SECRET".
import { dispatchAll } from "../_lib/dispatch.js";
import { env } from "../_lib/env.js";
import { handle, HttpError, json } from "../_lib/http.js";
import { adminClient } from "../_lib/supabase.js";

export const GET = handle(async (request) => {
  const secret = env.cronSecret;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) throw new HttpError(401, "Unauthorized");
  const db = adminClient();
  const notifications = await dispatchAll(db);
  await db.from("payment_links").update({ status: "expired" }).eq("status", "active").lt("expires_at", new Date().toISOString());
  return json({ ok: true, notifications });
});
