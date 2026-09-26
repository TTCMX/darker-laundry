// Row shapes as returned by the Data API (bigint money comes back as number).
import type { OrderPriority, OrderStatus } from "../domain/orders";
import type { OrderPaymentStatus, PaymentMethod } from "../domain/payments";
import type { PricingResult, VolumeRuleConfig } from "../domain/pricing";
import type { StepStatus } from "../domain/production";

export interface Category {
  id: string;
  tenant_id: string;
  name: string;
  sort_order: number;
  active: boolean;
}

export interface Product {
  id: string;
  tenant_id: string;
  category_id: string | null;
  sku: string | null;
  name: string;
  description: string | null;
  unit: string;
  base_price_cents: number;
  taxable: boolean;
  variable_price: boolean;
  active: boolean;
  estimated_minutes: number | null;
  production_notes: string | null;
  sort_order: number;
}

export interface PricingRuleRow {
  id: string;
  tenant_id: string;
  name: string;
  kind: "volume";
  product_id: string | null;
  category_id: string | null;
  priority: number;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  config: VolumeRuleConfig;
}

export interface DiscountRow {
  id: string;
  tenant_id: string;
  name: string;
  code: string | null;
  kind: "percentage" | "fixed";
  value: number;
  product_ids: string[];
  category_ids: string[];
  min_order_cents: number | null;
  max_discount_cents: number | null;
  starts_at: string | null;
  ends_at: string | null;
  usage_limit: number | null;
  active: boolean;
}

export interface Zone {
  id: string;
  tenant_id: string;
  name: string;
  fee_cents: number;
  free_over_cents: number | null;
  min_order_cents: number | null;
  postal_codes: string[];
  active: boolean;
  sort_order: number;
}

export interface Customer {
  id: string;
  tenant_id: string;
  name: string;
  phone: string | null;
  phone_normalized: string | null;
  email: string | null;
  notes: string | null;
  tags: string[];
  archived_at: string | null;
  created_at: string;
}

export interface CustomerOverview extends Customer {
  total_orders: number;
  lifetime_spend_cents: number;
  avg_order_cents: number;
  last_order_at: string | null;
  first_order_at: string | null;
  balance_due_cents: number;
  status: "new" | "active" | "at_risk" | "inactive" | "churned";
}

export interface Address {
  id: string;
  tenant_id: string;
  customer_id: string;
  label: string | null;
  line1: string;
  line2: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  instructions: string | null;
  lat: number | null;
  lng: number | null;
  zone_id: string | null;
  is_default: boolean;
}

export interface Order {
  id: string;
  tenant_id: string;
  number: number;
  public_token: string;
  customer_id: string;
  fulfillment: "delivery" | "walk_in";
  status: OrderStatus;
  priority: OrderPriority;
  workflow_id: string | null;
  current_step_id: string | null;
  pickup_address_id: string | null;
  delivery_address_id: string | null;
  delivery_zone_id: string | null;
  promised_at: string | null;
  notes: string | null;
  internal_notes: string | null;
  subtotal_cents: number;
  discount_cents: number;
  delivery_fee_cents: number;
  tax_cents: number;
  total_cents: number;
  amount_paid_cents: number;
  balance_cents: number;
  payment_status: OrderPaymentStatus;
  pricing: PricingResult | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  ready_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
}

export interface OrderItem {
  id: string;
  order_id: string;
  position: number;
  product_id: string | null;
  sku: string | null;
  name: string;
  unit: string;
  quantity: number;
  unit_price_cents: number;
  list_total_cents: number;
  volume_savings_cents: number;
  gross_cents: number;
  discount_cents: number;
  net_cents: number;
  custom_price: boolean;
  notes: string | null;
}

export interface ProductionStep {
  id: string;
  tenant_id: string;
  order_id: string;
  workflow_step_id: string | null;
  name: string;
  position: number;
  requires_assignment: boolean;
  allowed_role_ids: string[];
  estimated_minutes: number | null;
  status: StepStatus;
  assigned_to: string | null;
  assigned_at: string | null;
  assigned_by: string | null;
  started_at: string | null;
  completed_at: string | null;
  completed_by: string | null;
  notes: string | null;
}

export interface Workflow {
  id: string;
  tenant_id: string;
  name: string;
  is_default: boolean;
  active: boolean;
}

export interface WorkflowStep {
  id: string;
  tenant_id: string;
  workflow_id: string;
  name: string;
  position: number;
  active: boolean;
  requires_assignment: boolean;
  allowed_role_ids: string[];
  estimated_minutes: number | null;
  priority: number;
  color: string | null;
}

export type DeliveryStatus = "scheduled" | "assigned" | "en_route" | "arrived" | "completed" | "failed" | "cancelled";

export interface Delivery {
  id: string;
  tenant_id: string;
  order_id: string;
  type: "pickup" | "delivery";
  status: DeliveryStatus;
  address_id: string | null;
  address: {
    label?: string | null;
    line1?: string;
    line2?: string | null;
    neighborhood?: string | null;
    city?: string | null;
    postal_code?: string | null;
    instructions?: string | null;
    lat?: number | null;
    lng?: number | null;
  };
  scheduled_date: string;
  window_start: string | null;
  window_end: string | null;
  window_label: string | null;
  courier_id: string | null;
  route_id: string | null;
  stop_position: number | null;
  notes: string | null;
  failure_reason: string | null;
  proof_paths: string[];
  started_at: string | null;
  arrived_at: string | null;
  completed_at: string | null;
  completed_by: string | null;
}

export interface Route {
  id: string;
  tenant_id: string;
  route_date: string;
  name: string | null;
  courier_id: string | null;
  status: "planned" | "in_progress" | "completed" | "cancelled";
  started_at: string | null;
  completed_at: string | null;
}

export interface Payment {
  id: string;
  tenant_id: string;
  order_id: string;
  kind: "payment" | "refund";
  method: PaymentMethod;
  provider: string;
  provider_payment_id: string | null;
  status: "pending" | "succeeded" | "failed";
  amount_cents: number;
  refund_of: string | null;
  notes: string | null;
  recorded_by: string | null;
  created_at: string;
}

export interface QualityIssue {
  id: string;
  tenant_id: string;
  order_id: string;
  production_step_id: string | null;
  phase_name: string | null;
  type: string;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  reported_by: string | null;
  responsible_user_id: string | null;
  status: "open" | "in_progress" | "resolved" | "dismissed";
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  photo_paths: string[];
  created_at: string;
}

export interface NotificationRow {
  id: string;
  tenant_id: string;
  order_id: string | null;
  customer_id: string | null;
  event: string;
  channel: "email" | "whatsapp" | "sms";
  mode: "auto" | "manual";
  recipient: string;
  subject_template: string | null;
  body_template: string;
  variables: Record<string, unknown>;
  status: "pending" | "sending" | "sent" | "failed" | "cancelled";
  last_error: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface TemplateRow {
  id: string;
  tenant_id: string;
  event: string;
  channel: "email" | "whatsapp" | "sms";
  subject: string | null;
  body: string;
  enabled: boolean;
  mode: "auto" | "manual";
}

export interface AuditRow {
  id: number;
  tenant_id: string;
  occurred_at: string;
  actor_id: string | null;
  actor_type: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  order_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  context: { event?: string; note?: string } | null;
}

export interface TeamMember {
  id: string;
  user_id: string;
  display_name: string;
  phone: string | null;
  active: boolean;
  role_id: string;
  role_name: string;
  role_home: "backoffice" | "courier";
  is_owner: boolean;
  email: string | null;
}

export interface Role {
  id: string;
  tenant_id: string;
  key: string;
  name: string;
  description: string | null;
  is_owner: boolean;
  is_system: boolean;
  home: "backoffice" | "courier";
}

export interface Invitation {
  id: string;
  tenant_id: string;
  token: string;
  email: string | null;
  role_id: string;
  display_name: string | null;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  legal_name: string | null;
  tax_id: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  logo_url: string | null;
  country: string;
  currency: string;
  timezone: string;
  settings: Record<string, unknown>;
}
