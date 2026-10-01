import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import type { Permission } from "../domain/permissions";
import { useAuth, useTenant } from "../lib/session";
import { Icon, IconButton, Menu, initials } from "../ui/components";
import { PlanNotice } from "../features/plan/Plan";

export interface NavItem {
  to: string;
  label: string;
  icon: string;
  perms: Permission[];
}

export const NAV: NavItem[] = [
  { to: "/dashboard", label: "Inicio", icon: "space_dashboard", perms: ["dashboard.view"] },
  { to: "/analytics", label: "Análisis", icon: "monitoring", perms: ["reports.view"] },
  { to: "/orders", label: "Órdenes", icon: "receipt_long", perms: ["orders.view"] },
  { to: "/production", label: "Producción", icon: "local_laundry_service", perms: ["production.view"] },
  { to: "/delivery", label: "Entregas", icon: "local_shipping", perms: ["delivery.view", "delivery.manage"] },
  { to: "/customers", label: "Clientes", icon: "group", perms: ["customers.view"] },
  { to: "/payments", label: "Pagos", icon: "payments", perms: ["payments.view"] },
  { to: "/catalog", label: "Catálogo", icon: "sell", perms: ["catalog.manage", "pricing.manage"] },
  { to: "/team", label: "Equipo", icon: "badge", perms: ["team.manage"] },
  { to: "/settings", label: "Ajustes", icon: "settings", perms: ["settings.manage"] },
  { to: "/audit", label: "Bitácora", icon: "history", perms: ["audit.view"] },
];

export function useNav() {
  const { can } = useTenant();
  return NAV.filter((n) => can(...n.perms));
}

function RailItem({ item }: { item: NavItem }) {
  return (
    <NavLink to={item.to} className={({ isActive }) => `rail-item${isActive ? " on" : ""}`}>
      <span className="pill">
        <Icon name={item.icon} />
      </span>
      <span>{item.label}</span>
    </NavLink>
  );
}

/** Bottom bar overflow: the sections that don't fit in five slots. */
function MoreItem({ items }: { items: NavItem[] }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const on = items.some((i) => pathname.startsWith(i.to));
  return (
    <Menu
      up
      className="more-item"
      trigger={(toggle) => (
        <button type="button" className={`rail-item${on ? " on" : ""}`} onClick={toggle} aria-label="Más secciones">
          <span className="pill">
            <Icon name="menu" />
          </span>
          <span>Más</span>
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

export function AccountMenu() {
  const { user, signOut } = useAuth();
  const { tenant, memberships, switchTenant, can } = useTenant();
  const navigate = useNavigate();
  const name = tenant?.display_name ?? user?.email ?? "";
  return (
    <Menu
      trigger={(toggle) => (
        <button className="avatar" onClick={toggle} aria-label="Cuenta" title={name}>
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
          {can("delivery.execute") && (
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

export function Shell() {
  const nav = useNav();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <div className="shell">
      <nav className="rail" aria-label="Principal">
        <div className="brand">
          <img src="/favicon.svg" width={36} height={36} alt="" />
        </div>
        {nav.map((n) => (
          <RailItem key={n.to} item={n} />
        ))}
      </nav>
      <div className="main" data-scrolled={scrolled}>
        <Outlet />
      </div>
      <nav className="bottom-nav" aria-label="Principal">
        {(nav.length > 5 ? nav.slice(0, 4) : nav).map((n) => (
          <RailItem key={n.to} item={n} />
        ))}
        {nav.length > 5 && <MoreItem items={nav.slice(4)} />}
      </nav>
    </div>
  );
}

/** Top app bar + page content. */
export function Page({
  title,
  actions,
  back,
  children,
  narrow,
}: {
  title: ReactNode;
  actions?: ReactNode;
  back?: string | (() => void);
  children: ReactNode;
  narrow?: boolean;
}) {
  const navigate = useNavigate();
  const { tenant } = useTenant();
  useEffect(() => {
    document.title = `${typeof title === "string" ? title : "Dark Laundry OS"} · ${tenant?.tenant_name ?? "Dark Laundry OS"}`;
  }, [title, tenant?.tenant_name]);
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
        <AccountMenu />
      </header>
      <main className={`content${narrow ? " narrow" : ""}`}>
        <PlanNotice />
        {children}
      </main>
    </>
  );
}
