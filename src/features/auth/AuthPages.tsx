import { OperationPicker } from "../plan/Plan";
import type { OperationModel } from "../../domain/operation";
import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { errorMessage } from "../../lib/errors";
import { rpc } from "../../lib/queries";
import { useAuth, useTenant } from "../../lib/session";
import { supabase, supabaseConfigured } from "../../lib/supabase";
import { Banner, Button, Loading, Select, TextField } from "../../ui/components";

function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="center-page">
      <div className="auth-card">
        <img src="/favicon.svg" width={48} height={48} alt="" />
        <h1 className="headline-s" style={{ marginTop: 16 }}>
          {title}
        </h1>
        {subtitle && <p className="body-l muted" style={{ margin: "8px 0 0" }}>{subtitle}</p>}
        <div style={{ marginTop: 32 }}>{children}</div>
      </div>
    </div>
  );
}

function ConfigWarning() {
  return supabaseConfigured ? null : (
    <Banner tone="warning">
      Falta configurar <code>VITE_SUPABASE_URL</code> y <code>VITE_SUPABASE_ANON_KEY</code>. Revisa docs/SETUP.md.
    </Banner>
  );
}

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = params.get("next") || "/";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setLoading(false);
    if (error) setError(errorMessage(error));
    else navigate(next, { replace: true });
  };

  return (
    <AuthLayout title="Inicia sesión" subtitle="Dark Laundry OS">
      <form className="col gap-16" onSubmit={submit}>
        <ConfigWarning />
        <TextField label="Correo" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <TextField label="Contraseña" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <Banner tone="error">{error}</Banner>}
        <div className="row between mt-8">
          <Link to="/forgot">¿Olvidaste tu contraseña?</Link>
          <Button type="submit" loading={loading}>
            Entrar
          </Button>
        </div>
        <p className="body-m muted" style={{ margin: "16px 0 0" }}>
          ¿Nuevo? <Link to={`/signup${params.get("next") ? `?next=${encodeURIComponent(next)}` : ""}`}>Crea una cuenta</Link>
        </p>
      </form>
    </AuthLayout>
  );
}

export function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = params.get("next") || "/onboarding";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: { emailRedirectTo: `${window.location.origin}${next}` },
    });
    setLoading(false);
    if (error) return setError(errorMessage(error));
    if (data.session) navigate(next, { replace: true });
    else setSent(true);
  };

  if (sent) {
    return (
      <AuthLayout title="Revisa tu correo" subtitle={`Te enviamos un enlace a ${email} para confirmar tu cuenta.`}>
        <Link to="/login">Volver a iniciar sesión</Link>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="Crea tu cuenta" subtitle="Para dueños y equipo de la lavandería">
      <form className="col gap-16" onSubmit={submit}>
        <ConfigWarning />
        <TextField label="Correo" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <TextField
          label="Contraseña"
          type="password"
          autoComplete="new-password"
          minLength={8}
          hint="Mínimo 8 caracteres"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <Banner tone="error">{error}</Banner>}
        <div className="row between mt-8">
          <Link to={`/login${params.get("next") ? `?next=${encodeURIComponent(next)}` : ""}`}>Ya tengo cuenta</Link>
          <Button type="submit" loading={loading}>
            Crear cuenta
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}

export function ForgotPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/reset` });
    if (error) setError(errorMessage(error));
    else setSent(true);
  };
  return (
    <AuthLayout title="Recupera tu acceso" subtitle={sent ? "Si el correo existe, te enviamos un enlace." : "Te enviaremos un enlace para crear una nueva contraseña."}>
      {!sent && (
        <form className="col gap-16" onSubmit={submit}>
          <TextField label="Correo" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          {error && <Banner tone="error">{error}</Banner>}
          <div className="row between">
            <Link to="/login">Regresar</Link>
            <Button type="submit">Enviar enlace</Button>
          </div>
        </form>
      )}
      {sent && <Link to="/login">Volver a iniciar sesión</Link>}
    </AuthLayout>
  );
}

export function ResetPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) setError(errorMessage(error));
    else navigate("/", { replace: true });
  };
  return (
    <AuthLayout title="Nueva contraseña">
      <form className="col gap-16" onSubmit={submit}>
        <TextField label="Contraseña nueva" type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
        {error && <Banner tone="error">{error}</Banner>}
        <div className="row end">
          <Button type="submit">Guardar</Button>
        </div>
      </form>
    </AuthLayout>
  );
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

const TIMEZONES = [
  "America/Mexico_City",
  "America/Monterrey",
  "America/Tijuana",
  "America/Cancun",
  "America/Bogota",
  "America/Lima",
  "America/Santiago",
  "America/Argentina/Buenos_Aires",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/Madrid",
];

export function OnboardingPage() {
  const { user } = useAuth();
  const { memberships, loading, refresh, switchTenant } = useTenant();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [display, setDisplay] = useState("");
  const [country, setCountry] = useState("MX");
  const [currency, setCurrency] = useState("MXN");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Mexico_City");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState(false);
  const [model, setModel] = useState<OperationModel>("hybrid");

  if (!user) return <Navigate to="/login?next=/onboarding" replace />;
  if (loading) return <Loading />;
  if (memberships.length > 0 && !params.get("new") && !created) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const id = await rpc<string>("create_tenant", {
        p_name: name,
        p_slug: slug || slugify(name),
        p_display_name: display,
        p_country: country,
        p_currency: currency,
        p_timezone: timezone,
      });
      if (model !== "hybrid") await rpc("set_operation_model", { p_tenant: id, p_model: model });
      setCreated(true);
      await refresh();
      switchTenant(id);
      navigate("/settings?welcome=1", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AuthLayout title="Configura tu lavandería" subtitle="Podrás cambiar todo esto después en Ajustes.">
      <form className="col gap-16" onSubmit={submit}>
        <TextField
          label="Nombre del negocio"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(slugify(e.target.value));
          }}
          required
          autoFocus
        />
        <TextField
          label="Identificador"
          hint="Solo minúsculas, números y guiones"
          value={slug}
          pattern="[a-z0-9][a-z0-9\-]{1,48}[a-z0-9]"
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(slugify(e.target.value));
          }}
          required
        />
        <TextField label="Tu nombre" value={display} onChange={(e) => setDisplay(e.target.value)} required />
        <div className="col gap-8">
          <span className="title-s">¿Cómo trabaja tu lavandería?</span>
          <OperationPicker value={model} onChange={setModel} />
        </div>
        <div className="grid cols-2">
          <Select
            label="País"
            value={country}
            onChange={(e) => {
              setCountry(e.target.value);
              const cur: Record<string, string> = { MX: "MXN", US: "USD", CO: "COP", ES: "EUR", AR: "ARS", CL: "CLP", PE: "PEN", CA: "CAD" };
              setCurrency(cur[e.target.value] ?? "USD");
            }}
            options={[
              { value: "MX", label: "México" },
              { value: "US", label: "Estados Unidos" },
              { value: "CO", label: "Colombia" },
              { value: "ES", label: "España" },
              { value: "AR", label: "Argentina" },
              { value: "CL", label: "Chile" },
              { value: "PE", label: "Perú" },
              { value: "CA", label: "Canadá" },
            ]}
          />
          <TextField label="Moneda" value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} required />
        </div>
        <Select
          label="Zona horaria"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          options={[...new Set([timezone, ...TIMEZONES])].map((t) => ({ value: t, label: t.replace(/_/g, " ") }))}
        />
        {error && <Banner tone="error">{error}</Banner>}
        <div className="row end mt-8">
          {memberships.length > 0 && (
            <Button variant="text" onClick={() => navigate(-1)}>
              Cancelar
            </Button>
          )}
          <Button type="submit" loading={saving}>
            Crear negocio
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}

export function InvitePage() {
  const { token = "" } = useParams();
  const { user } = useAuth();
  const { refresh, switchTenant } = useTenant();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const info = useQuery({
    queryKey: ["invitation", token],
    queryFn: () => rpc<{ tenant_name: string; role_name: string; email: string | null; display_name: string | null; valid: boolean } | null>("get_invitation", { p_token: token }),
  });

  if (info.isLoading) return <Loading />;
  const inv = info.data;
  if (!inv || !inv.valid) {
    return (
      <AuthLayout title="Invitación no válida" subtitle="Pide a tu administrador un nuevo enlace.">
        <Link to="/">Ir al inicio</Link>
      </AuthLayout>
    );
  }
  const next = `/invite/${token}`;
  if (!user) {
    return (
      <AuthLayout title={`Únete a ${inv.tenant_name}`} subtitle={`Te invitaron como ${inv.role_name}. Crea tu cuenta o inicia sesión para aceptar.`}>
        <div className="row end gap-12">
          <Link className="btn outlined" to={`/login?next=${encodeURIComponent(next)}`}>
            Iniciar sesión
          </Link>
          <Link className="btn filled" to={`/signup?next=${encodeURIComponent(next)}`}>
            Crear cuenta
          </Link>
        </div>
      </AuthLayout>
    );
  }
  const accept = async () => {
    setSaving(true);
    setError(null);
    try {
      const tenantId = await rpc<string>("accept_invitation", { p_token: token, p_display_name: name || inv.display_name });
      await refresh();
      switchTenant(tenantId);
      navigate("/", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <AuthLayout title={`Únete a ${inv.tenant_name}`} subtitle={`Rol: ${inv.role_name}`}>
      <div className="col gap-16">
        <TextField label="Tu nombre" value={name || inv.display_name || ""} onChange={(e) => setName(e.target.value)} />
        {error && <Banner tone="error">{error}</Banner>}
        <div className="row end">
          <Button onClick={accept} loading={saving}>
            Aceptar invitación
          </Button>
        </div>
      </div>
    </AuthLayout>
  );
}
