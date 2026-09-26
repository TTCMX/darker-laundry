import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import type { Permission } from "../domain/permissions";
import { useAuth, useTenant } from "../lib/session";
import { Button, Empty, Loading } from "../ui/components";
import { AuditPage } from "../features/audit/Audit";
import { ForgotPage, InvitePage, LoginPage, OnboardingPage, ResetPage, SignupPage } from "../features/auth/AuthPages";
import { CatalogPage } from "../features/catalog/Catalog";
import { CourierApp } from "../features/courier/CourierApp";
import { CustomerDetail, CustomersList } from "../features/customers/Customers";
import { Dashboard } from "../features/dashboard/Dashboard";
import { DeliveryPlanner } from "../features/delivery/DeliveryPlanner";
import { OrderDetail } from "../features/orders/OrderDetail";
import { OrderEditor } from "../features/orders/OrderEditor";
import { OrdersList } from "../features/orders/OrdersList";
import { PaymentsPage } from "../features/payments/Payments";
import { ProductionBoard } from "../features/production/ProductionBoard";
import { SettingsPage } from "../features/settings/Settings";
import { TeamPage } from "../features/team/Team";
import { TrackingPage } from "../features/tracking/Tracking";
import { NAV, Shell } from "./Shell";

/** Signed in and member of a tenant; otherwise send to login / onboarding. */
function RequireTenant({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const { memberships, loading: tLoading } = useTenant();
  const location = useLocation();
  if (loading || (user && tLoading)) return <Loading />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (!memberships.length) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

function Guard({ perms, children }: { perms: Permission[]; children: ReactNode }) {
  const { can } = useTenant();
  if (!can(...perms)) {
    return (
      <div className="center-page">
        <Empty icon="lock" title="No tienes acceso a esta sección">
          <Button onClick={() => (window.location.href = "/")}>Ir al inicio</Button>
        </Empty>
      </div>
    );
  }
  return <>{children}</>;
}

/** Landing: couriers go to their route, everyone else to their first section. */
function Home() {
  const { tenant, can } = useTenant();
  if (tenant?.role_home === "courier") return <Navigate to="/courier" replace />;
  const first = NAV.find((n) => can(...n.perms));
  if (first) return <Navigate to={first.to} replace />;
  if (can("delivery.execute")) return <Navigate to="/courier" replace />;
  return (
    <div className="center-page">
      <Empty icon="lock" title="Tu rol aún no tiene permisos">
        Pide a un administrador que te asigne un rol.
      </Empty>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/forgot" element={<ForgotPage />} />
        <Route path="/reset" element={<ResetPage />} />
        <Route path="/invite/:token" element={<InvitePage />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/t/:token" element={<TrackingPage />} />
        <Route
          path="/courier"
          element={
            <RequireTenant>
              <CourierApp />
            </RequireTenant>
          }
        />
        <Route
          element={
            <RequireTenant>
              <Shell />
            </RequireTenant>
          }
        >
          <Route index element={<Home />} />
          <Route path="dashboard" element={<Guard perms={["dashboard.view"]}><Dashboard /></Guard>} />
          <Route path="orders" element={<Guard perms={["orders.view"]}><OrdersList /></Guard>} />
          <Route path="orders/new" element={<Guard perms={["orders.create"]}><OrderEditor /></Guard>} />
          <Route path="orders/:id" element={<Guard perms={["orders.view", "production.view", "delivery.view", "payments.view"]}><OrderDetail /></Guard>} />
          <Route path="orders/:id/edit" element={<Guard perms={["orders.edit"]}><OrderEditor /></Guard>} />
          <Route path="production" element={<Guard perms={["production.view"]}><ProductionBoard /></Guard>} />
          <Route path="delivery" element={<Guard perms={["delivery.view", "delivery.manage"]}><DeliveryPlanner /></Guard>} />
          <Route path="customers" element={<Guard perms={["customers.view"]}><CustomersList /></Guard>} />
          <Route path="customers/:id" element={<Guard perms={["customers.view"]}><CustomerDetail /></Guard>} />
          <Route path="payments" element={<Guard perms={["payments.view"]}><PaymentsPage /></Guard>} />
          <Route path="catalog" element={<Guard perms={["catalog.manage", "pricing.manage"]}><CatalogPage /></Guard>} />
          <Route path="team" element={<Guard perms={["team.manage"]}><TeamPage /></Guard>} />
          <Route path="settings" element={<Guard perms={["settings.manage"]}><SettingsPage /></Guard>} />
          <Route path="audit" element={<Guard perms={["audit.view"]}><AuditPage /></Guard>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
