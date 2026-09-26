// POST /api/notifications/dispatch — sends the tenant's pending automatic
// notifications now. The app calls it right after actions that queue them;
// the daily cron is only a safety net.
import { requireMember, requireUser } from "../_lib/auth.js";
import { dispatchTenant } from "../_lib/dispatch.js";
import { handle, json, readJson } from "../_lib/http.js";
import { adminClient } from "../_lib/supabase.js";

export const POST = handle(async (request) => {
  const user = await requireUser(request);
  const { tenant_id } = await readJson<{ tenant_id: string }>(request);
  await requireMember(user.id, tenant_id);
  return json(await dispatchTenant(adminClient(), tenant_id));
});
