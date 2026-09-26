// Server configuration. Read lazily so a missing optional variable only
// fails the feature that needs it, with a clear message.

const read = (name: string): string | undefined => {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
};

export class ConfigError extends Error {}

export const env = {
  get supabaseUrl() {
    const v = read("SUPABASE_URL") ?? read("VITE_SUPABASE_URL");
    if (!v) throw new ConfigError("SUPABASE_URL is not set");
    return v;
  },
  get serviceRoleKey() {
    const v = read("SUPABASE_SERVICE_ROLE_KEY");
    if (!v) throw new ConfigError("SUPABASE_SERVICE_ROLE_KEY is not set");
    return v;
  },
  /** Public base URL of the app, used in tracking links and webhooks. */
  get appUrl() {
    const v = read("APP_URL") ?? (read("VERCEL_PROJECT_PRODUCTION_URL") ? `https://${read("VERCEL_PROJECT_PRODUCTION_URL")}` : undefined);
    if (!v) throw new ConfigError("APP_URL is not set");
    return v.replace(/\/$/, "");
  },
  get resendApiKey() {
    return read("RESEND_API_KEY");
  },
  get emailFrom() {
    return read("EMAIL_FROM");
  },
  get cronSecret() {
    return read("CRON_SECRET");
  },
};
