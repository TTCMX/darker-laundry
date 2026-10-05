import { useQuery } from "@tanstack/react-query";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { ErrorBoundary } from "./resilience";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import type { Permission } from "../domain/permissions";
import { todayISO } from "../lib/format";
import { useAuth, useTenant } from "../lib/session";
import { supabase } from "../lib/supabase";
import { Icon, IconButton, Loading, Menu, initials } from "../ui/components";
import { PlanNotice } from "../features/plan/Plan";
import { useSheet, useSheetLinks, useSheetNavigate } from "./sheet";

export interface NavItem {
  to: string;
  label: string;
  icon: string;
  perms: Permission[];
  /** Only for businesses that do pickups and deliveries. */
  delivery?: boolean;
  /** Back office: admin sections, below the day-to-day ones. */
  admin?: boolean;
  badge?: "orders" | "stops";
}

// Day to day first (what the original app had), administration after.
export const NAV: NavItem[] = [
  { to: "/dashboard", label: "Inicio", icon: "home", perms: ["dashboard.view"] },
  { to: "/orders", label: "Pedidos", icon: "view_kanban", perms: ["orders.view", "production.view"], badge: "orders" },
  { to: "/customers", label: "Clientes", icon: "group", perms: ["customers.view"] },
  { to: "/delivery", label: "Ruta", icon: "local_shipping", perms: ["delivery.view", "delivery.manage"], delivery: true, badge: "stops" },
  { to: "/analytics", label: "Ventas", icon: "monitoring", perms: ["reports.view"] },
  { to: "/payments", label: "Pagos", icon: "payments", perms: ["payments.view"], admin: true },
  { to: "/orders/archive", label: "Archivo", icon: "inventory_2", perms: ["orders.view"], admin: true },
  { to: "/catalog", label: "Catálogo", icon: "sell", perms: ["catalog.manage", "pricing.manage"], admin: true },
  { to: "/team", label: "Equipo", icon: "badge", perms: ["team.manage"], admin: true },
  { to: "/settings", label: "Ajustes", icon: "settings", perms: ["settings.manage"], admin: true },
  { to: "/audit", label: "Bitácora", icon: "history", perms: ["audit.view"], admin: true },
];

export function useNav() {
  const { can, ops } = useTenant();
  return NAV.filter((n) => can(...n.perms) && (!n.delivery || ops.delivery));
}

/** Open orders and today's stops, for the counters next to the sections. */
function useNavCounts() {
  const { tenantId, can, ops } = useTenant();
  return useQuery({
    queryKey: ["orders", tenantId, "nav-counts"],
    enabled: !!tenantId,
    refetchInterval: 60_000,
    queryFn: async () => {
      const [orders, stops] = await Promise.all([
        can("orders.view", "production.view")
          ? supabase.from("orders").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).not("status", "in", "(delivered,cancelled)")
          : null,
        ops.delivery && can("delivery.view", "delivery.manage")
          ? supabase
              .from("deliveries")
              .select("id", { count: "exact", head: true })
              .eq("tenant_id", tenantId)
              .eq("scheduled_date", todayISO())
              .not("status", "in", "(completed,failed,cancelled)")
          : null,
      ]);
      return { orders: orders?.count ?? 0, stops: stops?.count ?? 0 };
    },
  });
}

function NavItemLink({ item, count, compact }: { item: NavItem; count?: number; compact?: boolean }) {
  return (
    <NavLink to={item.to} end={item.to === "/orders"} className={({ isActive }) => `${compact ? "tab-item" : "side-item"}${isActive ? " on" : ""}`}>
      <span className="pill">
        <Icon name={item.icon} />
      </span>
      <span className="label">{item.label}</span>
      {!!count && <span className="count">{count > 99 ? "99+" : count}</span>}
    </NavLink>
  );
}

/** Bottom bar overflow: the sections that don't fit in five slots. */
function MoreItem({ items }: { items: NavItem[] }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const on = items.some((i) => pathname === i.to || pathname.startsWith(`${i.to}/`));
  return (
    <Menu
      up
      className="more-item"
      trigger={(toggle) => (
        <button type="button" className={`tab-item${on ? " on" : ""}`} onClick={toggle} aria-label="Más secciones">
          <span className="pill">
            <Icon name="menu" />
          </span>
          <span className="label">Más</span>
        </button>
      )}
    >
      {(close) =>
        items.map((i) => (
          <button
            key={i.to}
            onClick={() => {
              close();
              navigate(i.to);
            }}
          >
            <Icon name={i.icon} /> {i.label}
          </button>
        ))
      }
    </Menu>
  );
}

export function AccountMenu({ dark }: { dark?: boolean }) {
  const { user, signOut } = useAuth();
  const { tenant, memberships, switchTenant, can, ops } = useTenant();
  const navigate = useNavigate();
  const name = tenant?.display_name ?? user?.email ?? "";
  return (
    <Menu
      trigger={(toggle) => (
        <button className={`avatar${dark ? " coral" : ""}`} onClick={toggle} aria-label="Cuenta" title={name}>
          {initials(name)}
        </button>
      )}
    >
      {(close) => (
        <>
          <div style={{ padding: "8px 16px 12px" }}>
            <div className="title-s">{name}</div>
            <div className="body-s muted">{user?.email}</div>
            <div className="body-s muted">
              {tenant?.tenant_name} · {tenant?.role_name}
            </div>
          </div>
          <hr className="divider" />
          {memberships.length > 1 &&
            memberships
              .filter((m) => m.tenant_id !== tenant?.tenant_id)
              .map((m) => (
                <button
                  key={m.tenant_id}
                  onClick={() => {
                    switchTenant(m.tenant_id);
                    close();
                    navigate("/");
                  }}
                >
                  <Icon name="store" /> {m.tenant_name}
                </button>
              ))}
          {can("delivery.execute") && ops.delivery && (
            <button
              onClick={() => {
                close();
                navigate("/courier");
              }}
            >
              <Icon name="two_wheeler" /> Vista courier
            </button>
          )}
          <button
            onClick={() => {
              close();
              navigate("/onboarding?new=1");
            }}
          >
            <Icon name="add_business" /> Nuevo negocio
          </button>
          <button
            onClick={async () => {
              close();
              await signOut();
              navigate("/login");
            }}
          >
            <Icon name="logout" /> Cerrar sesión
          </button>
        </>
      )}
    </Menu>
  );
}

function Brand() {
  const { tenant } = useTenant();
  return (
    <div className="brand">
      {tenant?.logo_url ? <img src={tenant.logo_url} alt="" className="brand-logo" /> : <img src="/favicon.svg" width={32} height={32} alt="" />}
      <div className="grow">
        <div className="brand-name truncate">{tenant?.tenant_name ?? "Dark Laundry OS"}</div>
        <div className="brand-sub">Dark Laundry OS</div>
      </div>
    </div>
  );
}

function Sidebar({ nav, counts }: { nav: NavItem[]; counts?: Record<string, number> }) {
  const { user, signOut } = useAuth();
  const { tenant } = useTenant();
  const navigate = useNavigate();
  const daily = nav.filter((n) => !n.admin);
  const admin = nav.filter((n) => n.admin);
  const name = tenant?.display_name ?? user?.email ?? "";
  return (
    <aside className="sidebar" aria-label="Principal">
      <Brand />
      <nav className="side-nav">
        {daily.map((n) => (
          <NavItemLink key={n.to} item={n} count={n.badge && counts?.[n.badge]} />
        ))}
        {admin.length > 0 && <div className="side-section">Back office</div>}
        {admin.map((n) => (
          <NavItemLink key={n.to} item={n} />
        ))}
      </nav>
      <div className="side-user">
        <div className="row gap-12">
          <AccountMenu dark />
          <div className="grow">
            <div className="side-user-name truncate">{name}</div>
            <div className="side-user-role truncate">{tenant?.role_name}</div>
          </div>
        </div>
        <button
          className="side-logout"
          onClick={async () => {
            await signOut();
            navigate("/login");
          }}
        >
          Cerrar sesión
        </button>
      </div>
    </aside>
  );
}

/** The orange "+" of the original app: new order from anywhere. */
export function NewOrderButton({ fab }: { fab?: boolean }) {
  const { can } = useTenant();
  const open = useSheetNavigate();
  if (!can("orders.create")) return null;
  return fab ? (
    <button className="fab-new" aria-label="Nueva orden" onClick={() => open("/orders/new")}>
      <Icon name="add" />
    </button>
  ) : (
    <button className="btn cta-new" onClick={() => open("/orders/new")}>
      <Icon name="add" /> Nueva orden
    </button>
  );
}

export function Shell() {
  const nav = useNav();
  const counts = useNavCounts();
  const { pathname } = useLocation();
  const [scrolled, setScrolled] = useState(false);
  useSheetLinks();
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const tabs = nav.length > 5 ? nav.slice(0, 4) : nav;
  const more = nav.length > 5 ? nav.slice(4) : [];
  return (
    <div className="shell">
      <Sidebar nav={nav} counts={counts.data} />
      <div className="main" data-scrolled={scrolled}>
        <header className="appbar">
          <NavLink to="/" className="appbar-brand">
            <Brand />
          </NavLink>
          <AccountMenu dark />
        </header>
        {/* Keyed by route: an error on one screen doesn't stick when navigating away. */}
        <ErrorBoundary key={pathname}>
          <Suspense fallback={<Loading />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </div>
      <nav className="bottom-nav" aria-label="Principal">
        {tabs.map((n) => (
          <NavItemLink key={n.to} item={n} compact count={n.badge && counts.data?.[n.badge]} />
        ))}
        {more.length > 0 && <MoreItem items={more} />}
      </nav>
    </div>
  );
}

/**
 * Screen title + content. Inside an order sheet the same screen gets the
 * sheet's header (close button) instead of the app's top bar.
 */
export function Page({
  title,
  actions,
  back,
  children,
  narrow,
  fab,
}: {
  title: ReactNode;
  actions?: ReactNode;
  back?: string | (() => void);
  children: ReactNode;
  narrow?: boolean;
  /** Show the "+" new order button on the phone. */
  fab?: boolean;
}) {
  const navigate = useNavigate();
  const sheetNavigate = useSheetNavigate();
  const sheet = useSheet();
  const { tenant } = useTenant();
  useEffect(() => {
    if (sheet) return;
    document.title = `${typeof title === "string" ? title : "Dark Laundry OS"} · ${tenant?.tenant_name ?? "Dark Laundry OS"}`;
  }, [title, tenant?.tenant_name, sheet]);

  if (sheet) {
    // Going "back" to the board closes the sheet; back to the order stays in it.
    const inner = typeof back === "string" && /^\/orders\/[^/]+$/.test(back) && back !== "/orders/archive";
    return (
      <>
        <header className="sheet-head">
          {inner && <IconButton icon="arrow_back" label="Regresar" onClick={() => sheetNavigate(back as string, { replace: true })} style={{ marginLeft: -8 }} />}
          <h1 className="title grow truncate">{title}</h1>
          <div className="row gap-4">{actions}</div>
          <IconButton icon="close" label="Cerrar" onClick={sheet.close} />
        </header>
        <div className={`sheet-body${narrow ? " narrow" : ""}`}>{children}</div>
      </>
    );
  }

  return (
    <>
      <header className="topbar">
        {back && (
          <IconButton
            icon="arrow_back"
            label="Regresar"
            onClick={() => (typeof back === "string" ? navigate(back) : back())}
            style={{ marginLeft: -8 }}
          />
        )}
        <h1 className="title grow truncate">{title}</h1>
        <div className="row">{actions}</div>
        <span className="desktop-only">
          <NewOrderButton />
        </span>
      </header>
      <main className={`content${narrow ? " narrow" : ""}`}>
        <PlanNotice />
        {children}
      </main>
      {fab && (
        <span className="mobile-only">
          <NewOrderButton fab />
        </span>
      )}
    </>
  );
}
