// GET /api/health — deployment check: which server settings are present.
import { handle, json } from "./_lib/http.js";

export const GET = handle(async () =>
  json({
    ok: true,
    supabase: Boolean((process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL) && process.env.SUPABASE_SERVICE_ROLE_KEY),
    app_url: Boolean(process.env.APP_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL),
    email: Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM),
    cron: Boolean(process.env.CRON_SECRET),
  }),
);
