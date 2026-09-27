import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { errorMessage } from "../lib/errors";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export function Icon({ name, filled, size, className }: { name: string; filled?: boolean; size?: "sm" | "lg"; className?: string }) {
  return (
    <span className={cx("icon", filled && "filled", size, className)} aria-hidden="true">
      {name}
    </span>
  );
}

type ButtonVariant = "filled" | "tonal" | "outlined" | "text" | "danger" | "danger-text" | "success";

export function Button({
  variant = "filled",
  icon,
  size,
  block,
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  icon?: string;
  size?: "sm" | "lg";
  block?: boolean;
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx("btn", variant, size, block && "block", className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <span className="spinner sm" /> : icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  tonal,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string; tonal?: boolean }) {
  return (
    <button type="button" className={cx("icon-btn", tonal && "tonal", className)} aria-label={label} title={label} {...rest}>
      <Icon name={icon} />
    </button>
  );
}

export function Field({ label, hint, error, children }: { label?: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <div className="field">
      {label && <label>{label}</label>}
      {children}
      {error ? <span className="err">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function TextField({
  label,
  hint,
  error,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: ReactNode; error?: string | null }) {
  const id = useId();
  return (
    <div className="field">
      {label && <label htmlFor={id}>{label}</label>}
      <input id={id} className={cx("input", error && "invalid", className)} {...rest} />
      {error ? <span className="err">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function TextArea({
  label,
  hint,
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      {label && <label htmlFor={id}>{label}</label>}
      <textarea id={id} className={cx("input", className)} {...rest} />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Select({
  label,
  hint,
  options,
  placeholder,
  className,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string;
  hint?: ReactNode;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      {label && <label htmlFor={id}>{label}</label>}
      <select id={id} className={cx("input", className)} {...rest}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Checkbox({ label, checked, onChange, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={cx(o.value === value && "on")} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Chip({ on, icon, children, onClick }: { on?: boolean; icon?: string; children: ReactNode; onClick?: () => void }) {
  return (
    <button type="button" className={cx("chip", on && "on")} onClick={onClick} aria-pressed={on}>
      {on ? <Icon name="check" /> : icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

export type Tone = "neutral" | "primary" | "secondary" | "success" | "warning" | "error" | "outline";

export function Badge({ tone = "neutral", icon, children }: { tone?: Tone; icon?: string; children: ReactNode }) {
  return (
    <span className={cx("badge", tone !== "neutral" && tone)}>
      {icon && <Icon name={icon} />}
      {children}
    </span>
  );
}

export function Card({ title, action, children, className, variant }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; variant?: "filled" | "elevated" | "flush" }) {
  return (
    <section className={cx("card", variant, className)}>
      {(title || action) && (
        <div className="card-title">
          {typeof title === "string" ? <h3>{title}</h3> : title}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, icon, tone }: { label: string; value: ReactNode; hint?: ReactNode; icon?: string; tone?: "accent" | "alert" }) {
  return (
    <div className={cx("stat", tone)}>
      <span className="label">
        {icon && <Icon name={icon} />}
        {label}
      </span>
      <span className="value">{value}</span>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Empty({ icon = "inbox", title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} />
      <div className="title-m" style={{ color: "var(--on-surface)" }}>
        {title}
      </div>
      {children}
    </div>
  );
}

export function Spinner({ small }: { small?: boolean }) {
  return <span className={cx("spinner", small && "sm")} role="status" aria-label="Cargando" />;
}

export function Loading() {
  return (
    <div className="empty">
      <Spinner />
    </div>
  );
}

export function Banner({ tone, icon, children, action }: { tone?: "warning" | "error" | "success"; icon?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={cx("banner", tone)} role={tone === "error" ? "alert" : undefined}>
      <Icon name={icon ?? (tone === "error" ? "error" : tone === "warning" ? "warning" : tone === "success" ? "check_circle" : "info")} />
      <div className="grow">{children}</div>
      {action}
    </div>
  );
}

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { value: T; label: string; icon?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={t.value === value} className={cx("tab", t.value === value && "on")} onClick={() => onChange(t.value)}>
          {t.icon && <Icon name={t.icon} size="sm" />}
          {t.label}
        </button>
      ))}
    </div>
  );
}

// Page scroll is locked while at least one dialog is open. A counter (not
// "remember the previous value") so stacked dialogs, re-renders and closing in
// any order always give the scroll back when the last one closes.
let scrollLocks = 0;
export function lockScroll(): () => void {
  scrollLocks += 1;
  document.documentElement.classList.add("scroll-locked");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    scrollLocks = Math.max(0, scrollLocks - 1);
    if (scrollLocks === 0) document.documentElement.classList.remove("scroll-locked");
  };
}

export function Dialog({
  open,
  title,
  onClose,
  children,
  actions,
  wide,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
}) {
  // Latest onClose without re-running the effect on every render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    document.addEventListener("keydown", onKey);
    const unlock = lockScroll();
    return () => {
      document.removeEventListener("keydown", onKey);
      unlock();
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx("dialog", wide && "wide")} role="dialog" aria-modal="true">
        <h2>{title}</h2>
        {children}
        {actions && <div className="actions">{actions}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Menu({
  trigger,
  children,
  up,
  className,
}: {
  trigger: (open: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  /** Open above the trigger (e.g. from a bottom bar). */
  up?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div ref={ref} className={className} style={{ position: "relative" }}>
      {trigger(() => setOpen((v) => !v))}
      {open && (
        <div className="menu" style={up ? { right: 0, bottom: "100%" } : { right: 0, top: "100%" }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

// ── Snackbar ────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  message: string;
  error?: boolean;
  action?: { label: string; run: () => void };
}

const ToastContext = createContext<{
  show: (message: string, opts?: { error?: boolean; action?: Toast["action"] }) => void;
}>({ show: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((message: string, opts?: { error?: boolean; action?: Toast["action"] }) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.filter((x) => x.message !== message).slice(-2), { id, message, ...opts }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts?.error ? 7000 : 4000);
  }, []);
  useEffect(() => {
    const onError = (e: Event) => show(errorMessage((e as CustomEvent).detail), { error: true });
    window.addEventListener("dlos:error", onError);
    return () => window.removeEventListener("dlos:error", onError);
  }, [show]);
  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="snackbar-host" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx("snackbar", t.error && "error")}>
            <span className="grow">{t.message}</span>
            {t.action && (
              <button className="btn text" style={{ color: "var(--primary-container)" }} onClick={t.action.run}>
                {t.action.label}
              </button>
            )}
            <IconButton icon="close" label="Cerrar" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} style={{ color: "inherit" }} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirmar",
  danger,
  onConfirm,
  onClose,
  loading,
  children,
}: {
  open: boolean;
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  loading?: boolean;
  children?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant={danger ? "danger" : "filled"} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message && <p className="body-m muted" style={{ margin: 0 }}>{message}</p>}
      {children}
    </Dialog>
  );
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("") || "?";
