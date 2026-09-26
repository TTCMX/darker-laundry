-- ============================================================================
-- 0008 · Security: grants and Row Level Security
--
-- Model:
--  * Every table has RLS enabled. anon has no table access at all.
--  * authenticated reads rows of tenants it belongs to, filtered by permission.
--  * Simple configuration data (catalog, customers, settings...) is written
--    directly under RLS + column grants. Everything with business rules
--    (orders, production, deliveries, payments, team) is written only through
--    the SECURITY DEFINER functions in 0006/0007.
--  * service_role (server code) bypasses RLS.
-- ============================================================================

do $$
declare
  t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema app from public, anon, authenticated;
revoke all on app.order_transitions from public, anon, authenticated;
grant all on all functions in schema public to service_role;
grant all on all functions in schema app to service_role;
grant select on app.order_transitions to service_role;

-- Helpers evaluated inside policies run with the caller's privileges.
grant execute on function
  app.current_actor(), app.is_member(uuid), app.has_permission(uuid, text), app.courier_has_order(uuid),
  app.customer_status(int, timestamptz, jsonb), app.try_uuid(text)
to authenticated;

-- ── Read grants ─────────────────────────────────────────────────────────────

grant select on
  public.tenants, public.permissions, public.roles, public.role_permissions, public.tenant_members,
  public.tenant_invitations, public.product_categories, public.products, public.pricing_rules,
  public.discounts, public.delivery_zones, public.customers, public.customer_addresses,
  public.workflows, public.workflow_steps, public.orders, public.order_items, public.order_discounts,
  public.order_production_steps, public.quality_issues, public.routes, public.deliveries,
  public.payments, public.payment_links, public.tenant_integrations, public.notification_templates,
  public.notifications, public.audit_log, public.customer_overview
to authenticated;

-- ── Direct write grants (column-scoped: never tenant_id on update) ─────────

grant update (name, legal_name, tax_id, phone, email, address, logo_url, country, currency, timezone, settings)
  on public.tenants to authenticated;

grant insert, delete on public.product_categories, public.products, public.pricing_rules, public.discounts,
  public.delivery_zones, public.customers, public.customer_addresses, public.workflows, public.workflow_steps,
  public.notification_templates
to authenticated;

grant update (name, sort_order, active) on public.product_categories to authenticated;
grant update (category_id, sku, name, description, unit, base_price_cents, taxable, variable_price, active,
              estimated_minutes, production_notes, sort_order) on public.products to authenticated;
grant update (name, product_id, category_id, priority, active, starts_at, ends_at, config) on public.pricing_rules to authenticated;
grant update (name, code, kind, value, product_ids, category_ids, min_order_cents, max_discount_cents,
              starts_at, ends_at, usage_limit, active) on public.discounts to authenticated;
grant update (name, fee_cents, free_over_cents, min_order_cents, postal_codes, active, sort_order) on public.delivery_zones to authenticated;
grant update (name, phone, email, notes, tags, archived_at) on public.customers to authenticated;
grant update (label, line1, line2, neighborhood, city, state, postal_code, instructions, lat, lng, zone_id, is_default)
  on public.customer_addresses to authenticated;
grant update (name, is_default, active) on public.workflows to authenticated;
grant update (name, position, active, requires_assignment, allowed_role_ids, estimated_minutes, priority, color)
  on public.workflow_steps to authenticated;
grant update (subject, body, enabled, mode) on public.notification_templates to authenticated;
grant insert, update (enabled, config) on public.tenant_integrations to authenticated;

grant insert on public.quality_issues to authenticated;
grant update (status, resolution, responsible_user_id, severity, type, description, photo_paths) on public.quality_issues to authenticated;

-- ── Policies ────────────────────────────────────────────────────────────────

-- tenants
create policy tenants_select on public.tenants for select to authenticated using (app.is_member(id));
create policy tenants_update on public.tenants for update to authenticated
  using (app.has_permission(id, 'settings.manage')) with check (app.has_permission(id, 'settings.manage'));

-- permissions catalog
create policy permissions_select on public.permissions for select to authenticated using (true);

-- team
create policy roles_select on public.roles for select to authenticated using (app.is_member(tenant_id));
create policy role_permissions_select on public.role_permissions for select to authenticated using (app.is_member(tenant_id));
create policy members_select on public.tenant_members for select to authenticated using (app.is_member(tenant_id));
create policy invitations_select on public.tenant_invitations for select to authenticated
  using (app.has_permission(tenant_id, 'team.manage'));

-- catalog & pricing: everyone in the tenant reads; managers write
create policy categories_select on public.product_categories for select to authenticated using (app.is_member(tenant_id));
create policy categories_write on public.product_categories for all to authenticated
  using (app.has_permission(tenant_id, 'catalog.manage')) with check (app.has_permission(tenant_id, 'catalog.manage'));
create policy products_select on public.products for select to authenticated using (app.is_member(tenant_id));
create policy products_write on public.products for all to authenticated
  using (app.has_permission(tenant_id, 'catalog.manage')) with check (app.has_permission(tenant_id, 'catalog.manage'));
create policy pricing_rules_select on public.pricing_rules for select to authenticated using (app.is_member(tenant_id));
create policy pricing_rules_write on public.pricing_rules for all to authenticated
  using (app.has_permission(tenant_id, 'pricing.manage')) with check (app.has_permission(tenant_id, 'pricing.manage'));
create policy discounts_select on public.discounts for select to authenticated using (app.is_member(tenant_id));
create policy discounts_write on public.discounts for all to authenticated
  using (app.has_permission(tenant_id, 'pricing.manage')) with check (app.has_permission(tenant_id, 'pricing.manage'));
create policy zones_select on public.delivery_zones for select to authenticated using (app.is_member(tenant_id));
create policy zones_write on public.delivery_zones for all to authenticated
  using (app.has_permission(tenant_id, 'pricing.manage')) with check (app.has_permission(tenant_id, 'pricing.manage'));

-- workflow configuration
create policy workflows_select on public.workflows for select to authenticated using (app.is_member(tenant_id));
create policy workflows_write on public.workflows for all to authenticated
  using (app.has_permission(tenant_id, 'settings.manage')) with check (app.has_permission(tenant_id, 'settings.manage'));
create policy workflow_steps_select on public.workflow_steps for select to authenticated using (app.is_member(tenant_id));
create policy workflow_steps_write on public.workflow_steps for all to authenticated
  using (app.has_permission(tenant_id, 'settings.manage')) with check (app.has_permission(tenant_id, 'settings.manage'));

-- customers: staff that handles orders; couriers only their stops' customers
create or replace function app.can_view_customer(p_tenant uuid, p_customer uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select app.has_permission(p_tenant, 'customers.view')
      or app.has_permission(p_tenant, 'orders.view')
      or app.has_permission(p_tenant, 'production.view')
      or app.has_permission(p_tenant, 'delivery.view')
      or exists (
        select 1 from public.deliveries d join public.orders o on o.id = d.order_id
        where o.customer_id = p_customer and d.courier_id = app.current_actor()
          and d.status not in ('cancelled') and app.has_permission(p_tenant, 'delivery.execute'));
$$;
grant execute on function app.can_view_customer(uuid, uuid) to authenticated;

create policy customers_select on public.customers for select to authenticated using (app.can_view_customer(tenant_id, id));
create policy customers_insert on public.customers for insert to authenticated
  with check (app.has_permission(tenant_id, 'customers.edit'));
create policy customers_update on public.customers for update to authenticated
  using (app.has_permission(tenant_id, 'customers.edit')) with check (app.has_permission(tenant_id, 'customers.edit'));
create policy customers_delete on public.customers for delete to authenticated
  using (app.has_permission(tenant_id, 'customers.edit'));

create policy addresses_select on public.customer_addresses for select to authenticated
  using (app.can_view_customer(tenant_id, customer_id));
create policy addresses_insert on public.customer_addresses for insert to authenticated
  with check (app.has_permission(tenant_id, 'customers.edit'));
create policy addresses_update on public.customer_addresses for update to authenticated
  using (app.has_permission(tenant_id, 'customers.edit')) with check (app.has_permission(tenant_id, 'customers.edit'));
create policy addresses_delete on public.customer_addresses for delete to authenticated
  using (app.has_permission(tenant_id, 'customers.edit'));

-- orders (read-only for clients; written through functions)
create or replace function app.can_view_order(p_tenant uuid, p_order uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select app.has_permission(p_tenant, 'orders.view')
      or app.has_permission(p_tenant, 'production.view')
      or app.has_permission(p_tenant, 'delivery.view')
      or app.has_permission(p_tenant, 'payments.view')
      or app.courier_has_order(p_order);
$$;
grant execute on function app.can_view_order(uuid, uuid) to authenticated;

create policy orders_select on public.orders for select to authenticated using (app.can_view_order(tenant_id, id));
create policy order_items_select on public.order_items for select to authenticated using (app.can_view_order(tenant_id, order_id));
create policy order_discounts_select on public.order_discounts for select to authenticated using (app.can_view_order(tenant_id, order_id));
create policy production_steps_select on public.order_production_steps for select to authenticated
  using (app.can_view_order(tenant_id, order_id));

-- quality issues
create policy quality_select on public.quality_issues for select to authenticated
  using (app.has_permission(tenant_id, 'quality.manage') or app.has_permission(tenant_id, 'quality.report')
         or app.has_permission(tenant_id, 'orders.view'));
create policy quality_insert on public.quality_issues for insert to authenticated
  with check (app.has_permission(tenant_id, 'quality.report') and app.can_view_order(tenant_id, order_id));
create policy quality_update on public.quality_issues for update to authenticated
  using (app.has_permission(tenant_id, 'quality.manage')) with check (app.has_permission(tenant_id, 'quality.manage'));

-- delivery
create policy routes_select on public.routes for select to authenticated
  using (app.has_permission(tenant_id, 'delivery.view') or app.has_permission(tenant_id, 'delivery.manage')
         or (courier_id = app.current_actor() and app.has_permission(tenant_id, 'delivery.execute')));
create policy deliveries_select on public.deliveries for select to authenticated
  using (app.has_permission(tenant_id, 'delivery.view') or app.has_permission(tenant_id, 'delivery.manage')
         or app.has_permission(tenant_id, 'orders.view')
         or (courier_id = app.current_actor() and app.has_permission(tenant_id, 'delivery.execute')));

-- payments
create policy payments_select on public.payments for select to authenticated
  using (app.has_permission(tenant_id, 'payments.view') or app.has_permission(tenant_id, 'orders.view')
         or (recorded_by = app.current_actor()));
create policy payment_links_select on public.payment_links for select to authenticated
  using (app.has_permission(tenant_id, 'payments.view') or app.has_permission(tenant_id, 'orders.view'));

-- integrations (secrets live in tenant_secrets, which has no client access at all)
create policy integrations_select on public.tenant_integrations for select to authenticated
  using (app.has_permission(tenant_id, 'settings.manage'));
create policy integrations_write on public.tenant_integrations for all to authenticated
  using (app.has_permission(tenant_id, 'settings.manage')) with check (app.has_permission(tenant_id, 'settings.manage'));

-- notifications
create policy templates_select on public.notification_templates for select to authenticated
  using (app.has_permission(tenant_id, 'settings.manage') or app.has_permission(tenant_id, 'notifications.send'));
create policy templates_write on public.notification_templates for all to authenticated
  using (app.has_permission(tenant_id, 'settings.manage')) with check (app.has_permission(tenant_id, 'settings.manage'));
create policy notifications_select on public.notifications for select to authenticated
  using (app.has_permission(tenant_id, 'notifications.send') or app.has_permission(tenant_id, 'orders.view'));

-- audit log: full log for auditors; order history for whoever sees orders
create policy audit_select on public.audit_log for select to authenticated
  using (app.has_permission(tenant_id, 'audit.view')
         or (order_id is not null and app.has_permission(tenant_id, 'orders.view')));

-- ── Function grants ─────────────────────────────────────────────────────────

grant execute on function
  public.create_tenant(text, text, text, text, text, text),
  public.my_memberships(),
  public.create_invitation(uuid, uuid, text, text),
  public.accept_invitation(text, text),
  public.revoke_invitation(uuid),
  public.update_member(uuid, uuid, text, text, boolean),
  public.save_role(uuid, uuid, text, text, text, text[]),
  public.delete_role(uuid),
  public.team_members(uuid),
  public.set_order_status(uuid, text, text),
  public.start_production(uuid),
  public.update_order_details(uuid, text, timestamptz, text, text),
  public.assign_production_step(uuid, uuid),
  public.start_production_step(uuid),
  public.complete_production_step(uuid, text),
  public.revert_production_step(uuid, text),
  public.schedule_delivery(uuid, text, date, text, time, time, uuid, text, uuid),
  public.update_delivery(uuid, date, text, time, time, uuid, text, boolean),
  public.save_route(uuid, uuid, date, text, uuid, uuid[]),
  public.start_route(uuid),
  public.update_delivery_status(uuid, text, text, text, text[]),
  public.record_payment(uuid, bigint, text, text, text, uuid),
  public.record_refund(uuid, bigint, text, text),
  public.mark_notification(uuid, text),
  public.queue_payment_reminder(uuid),
  public.dashboard_summary(uuid),
  public.get_invitation(text),
  public.get_public_order(text)
to authenticated;

grant execute on function public.get_invitation(text), public.get_public_order(text) to anon;

-- svc_* functions stay service_role only (granted above via "all functions").
