import { Suspense, type ReactNode } from "react";
import { ErrorBoundary, lazyPage } from "./resilience";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import type { Permission } from "../domain/permissions";
import { useAuth, useTenant } from "../lib/session";
import { Button, Empty, Loading } from "../ui/components";
import { ForgotPage, InvitePage, LoginPage, OnboardingPage, ResetPage, SignupPage } from "../features/auth/AuthPages";
import { NAV, Shell } from "./Shell";
import { ReadOnlyPage, useBlockedByPlan } from "../features/plan/Plan";

const AnalyticsPage = lazyPage(() => import("../features/analytics/Analytics").then((m) => ({ default: m.AnalyticsPage })));
const AuditPage = lazyPage(() => import("../features/audit/Audit").then((m) => ({ default: m.AuditPage })));
const CatalogPage = lazyPage(() => import("../features/catalog/Catalog").then((m) => ({ default: m.CatalogPage })));
const CourierApp = lazyPage(() => import("../features/courier/CourierApp").then((m) => ({ default: m.CourierApp })));
const CustomerDetail = lazyPage(() => import("../features/customers/Customers").then((m) => ({ default: m.CustomerDetail })));
const CustomersList = lazyPage(() => import("../features/customers/Customers").then((m) => ({ default: m.CustomersList })));
const Dashboard = lazyPage(() => import("../features/dashboard/Dashboard").then((m) => ({ default: m.Dashboard })));
const DeliveryPlanner = lazyPage(() => import("../features/delivery/DeliveryPlanner").then((m) => ({ default: m.DeliveryPlanner })));
const OrderDetail = lazyPage(() => import("../features/orders/OrderDetail").then((m) => ({ default: m.OrderDetail })));
const OrderEditor = lazyPage(() => import("../features/orders/OrderEditor").then((m) => ({ default: m.OrderEditor })));
const OrdersList = lazyPage(() => import("../features/orders/OrdersList").then((m) => ({ default: m.OrdersList })));
const PaymentsPage = lazyPage(() => import("../features/payments/Payments").then((m) => ({ default: m.PaymentsPage })));
const ProductionBoard = lazyPage(() => import("../features/production/ProductionBoard").then((m) => ({ default: m.ProductionBoard })));
const SettingsPage = lazyPage(() => import("../features/settings/Settings").then((m) => ({ default: m.SettingsPage })));
const TeamPage = lazyPage(() => import("../features/team/Team").then((m) => ({ default: m.TeamPage })));
const TrackingPage = lazyPage(() => import("../features/tracking/Tracking").then((m) => ({ default: m.TrackingPage })));

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
  const blocked = useBlockedByPlan(...perms);
  if (!can(...perms) && blocked) return <ReadOnlyPage onHome={() => (window.location.href = "/")} />;
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
  const { tenant, can, ops } = useTenant();
  if (tenant?.role_home === "courier" && ops.delivery) return <Navigate to="/courier" replace />;
  const first = NAV.find((n) => can(...n.perms) && (!n.delivery || ops.delivery));
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
      <ErrorBoundary>
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
      </ErrorBoundary>
    </BrowserRouter>
  );
}
