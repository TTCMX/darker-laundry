import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import type { Permission } from "../domain/permissions";
import { useAuth, useTenant } from "../lib/session";
import { Button, Empty, Loading } from "../ui/components";
import { ForgotPage, InvitePage, LoginPage, OnboardingPage, ResetPage, SignupPage } from "../features/auth/AuthPages";
import { NAV, Shell } from "./Shell";

const AnalyticsPage = lazy(() => import("../features/analytics/Analytics").then((m) => ({ default: m.AnalyticsPage })));
const AuditPage = lazy(() => import("../features/audit/Audit").then((m) => ({ default: m.AuditPage })));
const CatalogPage = lazy(() => import("../features/catalog/Catalog").then((m) => ({ default: m.CatalogPage })));
const CourierApp = lazy(() => import("../features/courier/CourierApp").then((m) => ({ default: m.CourierApp })));
const CustomerDetail = lazy(() => import("../features/customers/Customers").then((m) => ({ default: m.CustomerDetail })));
const CustomersList = lazy(() => import("../features/customers/Customers").then((m) => ({ default: m.CustomersList })));
const Dashboard = lazy(() => import("../features/dashboard/Dashboard").then((m) => ({ default: m.Dashboard })));
const DeliveryPlanner = lazy(() => import("../features/delivery/DeliveryPlanner").then((m) => ({ default: m.DeliveryPlanner })));
const OrderDetail = lazy(() => import("../features/orders/OrderDetail").then((m) => ({ default: m.OrderDetail })));
const OrderEditor = lazy(() => import("../features/orders/OrderEditor").then((m) => ({ default: m.OrderEditor })));
const OrdersList = lazy(() => import("../features/orders/OrdersList").then((m) => ({ default: m.OrdersList })));
const PaymentsPage = lazy(() => import("../features/payments/Payments").then((m) => ({ default: m.PaymentsPage })));
const ProductionBoard = lazy(() => import("../features/production/ProductionBoard").then((m) => ({ default: m.ProductionBoard })));
const SettingsPage = lazy(() => import("../features/settings/Settings").then((m) => ({ default: m.SettingsPage })));
const TeamPage = lazy(() => import("../features/team/Team").then((m) => ({ default: m.TeamPage })));
const TrackingPage = lazy(() => import("../features/tracking/Tracking").then((m) => ({ default: m.TrackingPage })));

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
      <Suspense fallback={<Loading />}>
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
          <Route path="analytics/:tab?" element={<Guard perms={["reports.view"]}><AnalyticsPage /></Guard>} />
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
      </Suspense>
    </BrowserRouter>
  );
}
