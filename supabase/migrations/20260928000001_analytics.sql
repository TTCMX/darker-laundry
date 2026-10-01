-- ============================================================================
-- Analytics back office
--   * New permission reports.view (owners and managers).
--   * Read-only report functions, one per section. All take an inclusive date
--     range in the tenant's local time zone and compare it with the previous
--     period of the same length.
--   * Sales are recognised when the order is created (cancelled orders are
--     excluded); cash is recognised when the payment succeeds.
-- ============================================================================

insert into public.permissions (code, description) values
  ('reports.view', 'Ver análisis y reportes');

-- Managers of existing tenants get it (new tenants get it from the seed).
insert into public.role_permissions (tenant_id, role_id, permission)
select tenant_id, id, 'reports.view' from public.roles where key = 'manager'
on conflict do nothing;

-- ── Helpers ─────────────────────────────────────────────────────────────────

-- Local date range → timestamps, plus the previous period of the same length.
create or replace function app.report_window(
  p_tenant uuid, p_from date, p_to date,
  out tz text, out t0 timestamptz, out t1 timestamptz, out p0 timestamptz, out p1 timestamptz, out days int)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception using errcode = '22023', message = 'invalid date range';
  end if;
  if p_to - p_from > 1100 then
    raise exception using errcode = '22023', message = 'date range too long (max 3 years)';
  end if;
  select coalesce(timezone, 'UTC') into tz from public.tenants where id = p_tenant;
  days := p_to - p_from + 1;
  t0 := p_from::timestamp at time zone tz;
  t1 := (p_to + 1)::timestamp at time zone tz;
  p0 := (p_from - days)::timestamp at time zone tz;
  p1 := t0;
end $$;

-- Chart granularity for a range.
create or replace function app.report_bucket(p_from date, p_to date) returns text
language sql immutable as $$
  select case when p_to - p_from <= 62 then 'day' when p_to - p_from <= 366 then 'week' else 'month' end;
$$;

-- Headline numbers for a window. Used for the period and its comparison.
create or replace function app.sales_kpis(p_tenant uuid, p_t0 timestamptz, p_t1 timestamptz) returns jsonb
language sql stable security definer set search_path = public as $$
  with o as (
    select * from public.orders
    where tenant_id = p_tenant and created_at >= p_t0 and created_at < p_t1
  ), live as (
    select * from o where status <> 'cancelled'
  ), pay as (
    select
      coalesce(sum(amount_cents) filter (where kind = 'payment'), 0) as payments_cents,
      coalesce(sum(amount_cents) filter (where kind = 'refund'), 0) as refunds_cents,
      count(*) filter (where kind = 'payment') as payments_count
    from public.payments
    where tenant_id = p_tenant and status = 'succeeded' and created_at >= p_t0 and created_at < p_t1
  ), items as (
    select
      count(*) as lines,
      coalesce(sum(i.quantity) filter (where i.unit = 'kg'), 0) as kg,
      coalesce(sum(i.quantity) filter (where i.unit <> 'kg'), 0) as units
    from public.order_items i join live on live.id = i.order_id
  )
  select jsonb_build_object(
    'orders', (select count(*) from live),
    'sales_cents', (select coalesce(sum(total_cents), 0) from live),
    'avg_ticket_cents', (select coalesce(round(avg(total_cents) filter (where total_cents > 0)), 0) from live),
    'subtotal_cents', (select coalesce(sum(subtotal_cents), 0) from live),
    'discount_cents', (select coalesce(sum(discount_cents), 0) from live),
    'credit_cents', (select coalesce(sum(loyalty_credit_cents), 0) from live),
    'delivery_fee_cents', (select coalesce(sum(delivery_fee_cents), 0) from live),
    'tax_cents', (select coalesce(sum(tax_cents), 0) from live),
    'outstanding_cents', (select coalesce(sum(balance_cents), 0) from live),
    'delivery_orders', (select count(*) from live where fulfillment = 'delivery'),
    'cancelled_orders', (select count(*) from o where status = 'cancelled'),
    'cancelled_cents', (select coalesce(sum(total_cents), 0) from o where status = 'cancelled'),
    'customers', (select count(distinct customer_id) from live),
    'new_customers', (
      select count(*) from (
        select customer_id from public.orders
        where tenant_id = p_tenant and status <> 'cancelled'
        group by customer_id
        having min(created_at) >= p_t0 and min(created_at) < p_t1) x),
    'payments_count', (select payments_count from pay),
    'payments_cents', (select payments_cents from pay),
    'refunds_cents', (select refunds_cents from pay),
    'collected_cents', (select payments_cents - refunds_cents from pay),
    'item_lines', (select lines from items),
    'kg', (select kg from items),
    'units', (select units from items)
  );
$$;

-- Orders and money per chart bucket for a window.
create or replace function app.sales_series(p_tenant uuid, p_t0 timestamptz, p_t1 timestamptz, p_tz text, p_bucket text) returns jsonb
language sql stable security definer set search_path = public as $$
  with b as (
    select g::date as bucket
    from generate_series(
      date_trunc(p_bucket, (p_t0 at time zone p_tz)),
      (p_t1 at time zone p_tz) - interval '1 second',
      ('1 ' || p_bucket)::interval) g
  ), o as (
    select date_trunc(p_bucket, created_at at time zone p_tz)::date as bucket, count(*) as orders, sum(total_cents) as sales
    from public.orders
    where tenant_id = p_tenant and status <> 'cancelled' and created_at >= p_t0 and created_at < p_t1
    group by 1
  ), p as (
    select date_trunc(p_bucket, created_at at time zone p_tz)::date as bucket,
           sum(case when kind = 'payment' then amount_cents else -amount_cents end) as collected
    from public.payments
    where tenant_id = p_tenant and status = 'succeeded' and created_at >= p_t0 and created_at < p_t1
    group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'bucket', b.bucket, 'orders', coalesce(o.orders, 0), 'sales_cents', coalesce(o.sales, 0), 'collected_cents', coalesce(p.collected, 0))
    order by b.bucket), '[]'::jsonb)
  from b left join o using (bucket) left join p using (bucket);
$$;

-- Display name of a member (by user id) for reports.
create or replace function app.member_name(p_tenant uuid, p_user uuid) returns text
language sql stable security definer set search_path = public as $$
  select display_name from public.tenant_members where tenant_id = p_tenant and user_id = p_user;
$$;

-- ── Sales overview ──────────────────────────────────────────────────────────

create or replace function public.analytics_sales(p_tenant uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  w record;
  v_bucket text := app.report_bucket(p_from, p_to);
begin
  perform app.require_permission(p_tenant, 'reports.view');
  select * into w from app.report_window(p_tenant, p_from, p_to);
  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'bucket', v_bucket, 'timezone', w.tz,
    'current', app.sales_kpis(p_tenant, w.t0, w.t1),
    'previous', app.sales_kpis(p_tenant, w.p0, w.p1),
    'series', app.sales_series(p_tenant, w.t0, w.t1, w.tz, v_bucket),
    'previous_series', app.sales_series(p_tenant, w.p0, w.p1, w.tz, v_bucket),
    'by_fulfillment', coalesce((
      select jsonb_agg(jsonb_build_object('key', fulfillment, 'orders', n, 'sales_cents', s) order by s desc)
      from (select fulfillment, count(*) as n, sum(total_cents) as s from public.orders
            where tenant_id = p_tenant and status <> 'cancelled' and created_at >= w.t0 and created_at < w.t1
            group by fulfillment) x), '[]'::jsonb),
    'by_method', coalesce((
      select jsonb_agg(jsonb_build_object('key', method, 'count', n, 'payments_cents', pay, 'refunds_cents', ref) order by pay desc)
      from (select method, count(*) filter (where kind = 'payment') as n,
                   coalesce(sum(amount_cents) filter (where kind = 'payment'), 0) as pay,
                   coalesce(sum(amount_cents) filter (where kind = 'refund'), 0) as ref
            from public.payments
            where tenant_id = p_tenant and status = 'succeeded' and created_at >= w.t0 and created_at < w.t1
            group by method) x), '[]'::jsonb),
    'by_status', coalesce((
      select jsonb_agg(jsonb_build_object('key', status, 'orders', n, 'sales_cents', s))
      from (select status, count(*) as n, sum(total_cents) as s from public.orders
            where tenant_id = p_tenant and created_at >= w.t0 and created_at < w.t1
            group by status) x), '[]'::jsonb),
    -- Orders by weekday (1 = Monday) and local hour.
    'heatmap', coalesce((
      select jsonb_agg(jsonb_build_object('dow', dow, 'hour', hour, 'orders', n))
      from (select extract(isodow from created_at at time zone w.tz)::int as dow,
                   extract(hour from created_at at time zone w.tz)::int as hour, count(*) as n
            from public.orders
            where tenant_id = p_tenant and status <> 'cancelled' and created_at >= w.t0 and created_at < w.t1
            group by 1, 2) x), '[]'::jsonb)
  );
end $$;

-- ── Services, categories, discounts, loyalty ───────────────────────────────

create or replace function public.analytics_services(p_tenant uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  w record;
begin
  perform app.require_permission(p_tenant, 'reports.view');
  select * into w from app.report_window(p_tenant, p_from, p_to);
  return (
    with live as (
      select * from public.orders
      where tenant_id = p_tenant and status <> 'cancelled' and created_at >= w.t0 and created_at < w.t1
    ), prev as (
      select id from public.orders
      where tenant_id = p_tenant and status <> 'cancelled' and created_at >= w.p0 and created_at < w.p1
    ), it as (
      select i.*, coalesce(p.name, i.name) as product_name, coalesce(c.name, 'Sin categoría') as category_name,
             coalesce(i.product_id::text, 'name:' || i.name) as product_key
      from public.order_items i
      join live on live.id = i.order_id
      left join public.products p on p.id = i.product_id
      left join public.product_categories c on c.id = p.category_id
    ), prev_it as (
      select coalesce(i.product_id::text, 'name:' || i.name) as product_key, sum(i.net_cents) as revenue
      from public.order_items i join prev on prev.id = i.order_id
      group by 1
    ), disc as (
      select d ->> 'id' as id, d ->> 'name' as name, count(*) as orders, sum((d ->> 'amount_cents')::bigint) as amount
      from live, jsonb_array_elements(coalesce(live.pricing -> 'applied_discounts', '[]'::jsonb)) d
      group by 1, 2
    )
    select jsonb_build_object(
      'from', p_from, 'to', p_to,
      'revenue_cents', (select coalesce(sum(net_cents), 0) from it),
      'products', coalesce((
        select jsonb_agg(x order by x.revenue_cents desc) from (
          select it.product_key as key, min(it.product_name) as name, min(it.category_name) as category, min(it.unit) as unit,
                 count(distinct it.order_id) as orders, sum(it.quantity) as quantity,
                 sum(it.list_total_cents) as list_cents, sum(it.net_cents) as revenue_cents,
                 coalesce(min(pi.revenue), 0) as previous_revenue_cents,
                 bool_or(it.custom_price) as custom_price
          from it left join prev_it pi on pi.product_key = it.product_key
          group by it.product_key) x), '[]'::jsonb),
      'categories', coalesce((
        select jsonb_agg(x order by x.revenue_cents desc) from (
          select category_name as name, count(distinct order_id) as orders, sum(net_cents) as revenue_cents
          from it group by category_name) x), '[]'::jsonb),
      'discounts', coalesce((
        select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'orders', orders, 'amount_cents', amount) order by amount desc)
        from disc), '[]'::jsonb),
      'loyalty', jsonb_build_object(
        'points_earned', (select coalesce(sum(points), 0) from public.loyalty_transactions
                          where tenant_id = p_tenant and kind = 'earn' and created_at >= w.t0 and created_at < w.t1),
        'points_redeemed', (select coalesce(sum(points_redeemed), 0) from live),
        'credit_cents', (select coalesce(sum(loyalty_credit_cents), 0) from live),
        'orders_redeeming', (select count(*) from live where points_redeemed > 0))
    )
  );
end $$;

-- ── Customers ───────────────────────────────────────────────────────────────

create or replace function public.analytics_customers(p_tenant uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  w record;
  v_bucket text := app.report_bucket(p_from, p_to);
  v_settings jsonb;
begin
  perform app.require_permission(p_tenant, 'reports.view');
  select * into w from app.report_window(p_tenant, p_from, p_to);
  select settings into v_settings from public.tenants where id = p_tenant;
  return (
    with live as (
      select * from public.orders where tenant_id = p_tenant and status <> 'cancelled'
    ), stats as (
      select customer_id, count(*) as total_orders, sum(total_cents) as lifetime_cents,
             min(created_at) as first_at, max(created_at) as last_at, sum(balance_cents) as balance_cents
      from live group by customer_id
    ), period as (
      select customer_id, count(*) as orders, sum(total_cents) as spend_cents, max(created_at) as last_at
      from live where created_at >= w.t0 and created_at < w.t1
      group by customer_id
    ), c as (
      select cu.id, cu.name, cu.phone, cu.created_at, s.total_orders, s.lifetime_cents, s.first_at, s.last_at, s.balance_cents,
             app.customer_status(coalesce(s.total_orders, 0)::int, s.last_at, v_settings) as status
      from public.customers cu left join stats s on s.customer_id = cu.id
      where cu.tenant_id = p_tenant and cu.archived_at is null
    )
    select jsonb_build_object(
      'from', p_from, 'to', p_to, 'bucket', v_bucket,
      'total_customers', (select count(*) from c),
      'buyers', (select count(*) from period),
      'new_buyers', (select count(*) from period p join stats s using (customer_id) where s.first_at >= w.t0),
      'returning_buyers', (select count(*) from period p join stats s using (customer_id) where s.first_at < w.t0),
      'repeat_buyers', (select count(*) from period where orders > 1),
      'registered', (select count(*) from c where created_at >= w.t0 and created_at < w.t1),
      'avg_orders_per_buyer', (select coalesce(round(avg(orders)::numeric, 2), 0) from period),
      'avg_spend_cents', (select coalesce(round(avg(spend_cents)), 0) from period),
      'balance_due_cents', (select coalesce(sum(balance_cents), 0) from c),
      'previous_buyers', (select count(distinct customer_id) from live where created_at >= w.p0 and created_at < w.p1),
      -- Buyers of the previous period who came back in this one.
      'retained_buyers', (select count(*) from period where customer_id in
                          (select customer_id from live where created_at >= w.p0 and created_at < w.p1)),
      'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) as n from c group by status) x), '{}'::jsonb),
      'top', coalesce((
        select jsonb_agg(x order by x.spend_cents desc) from (
          select c.id, c.name, c.phone, p.orders, p.spend_cents, c.total_orders, c.lifetime_cents, c.last_at, c.status
          from period p join c on c.id = p.customer_id
          order by p.spend_cents desc limit 25) x), '[]'::jsonb),
      -- Valuable customers who stopped coming: worth a call or a promo.
      'at_risk', coalesce((
        select jsonb_agg(x order by x.lifetime_cents desc) from (
          select c.id, c.name, c.phone, c.total_orders, c.lifetime_cents, c.last_at, c.status
          from c where c.status in ('at_risk', 'inactive') and c.total_orders > 0
          order by c.lifetime_cents desc limit 25) x), '[]'::jsonb),
      'new_series', coalesce((
        select jsonb_agg(jsonb_build_object('bucket', b.bucket, 'customers', coalesce(n.n, 0)) order by b.bucket)
        from (select g::date as bucket from generate_series(date_trunc(v_bucket, (w.t0 at time zone w.tz)),
                (w.t1 at time zone w.tz) - interval '1 second', ('1 ' || v_bucket)::interval) g) b
        left join (select date_trunc(v_bucket, first_at at time zone w.tz)::date as bucket, count(*) as n
                   from stats where first_at >= w.t0 and first_at < w.t1 group by 1) n using (bucket)), '[]'::jsonb)
    )
  );
end $$;

-- ── Employees ───────────────────────────────────────────────────────────────

create or replace function public.analytics_employees(p_tenant uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  w record;
begin
  perform app.require_permission(p_tenant, 'reports.view');
  select * into w from app.report_window(p_tenant, p_from, p_to);
  return (
    with m as (
      select tm.user_id, tm.display_name, tm.active, r.name as role_name
      from public.tenant_members tm join public.roles r on r.id = tm.role_id
      where tm.tenant_id = p_tenant
    ), ord as (
      select created_by as user_id, count(*) as orders, sum(total_cents) as sales_cents
      from public.orders
      where tenant_id = p_tenant and status <> 'cancelled' and created_at >= w.t0 and created_at < w.t1
      group by created_by
    ), pay as (
      select recorded_by as user_id, count(*) filter (where kind = 'payment') as payments,
             coalesce(sum(amount_cents) filter (where kind = 'payment'), 0) as collected_cents,
             coalesce(sum(amount_cents) filter (where kind = 'refund'), 0) as refunded_cents
      from public.payments
      where tenant_id = p_tenant and status = 'succeeded' and created_at >= w.t0 and created_at < w.t1
      group by recorded_by
    ), steps as (
      select completed_by as user_id, count(*) as steps,
             round(avg(extract(epoch from (completed_at - started_at)) / 60) filter (where started_at is not null))::int as avg_minutes,
             count(*) filter (where started_at is not null and estimated_minutes is not null
                              and completed_at - started_at <= make_interval(mins => estimated_minutes)) as on_time_steps,
             count(*) filter (where started_at is not null and estimated_minutes is not null) as timed_steps
      from public.order_production_steps
      where tenant_id = p_tenant and status = 'done' and completed_at >= w.t0 and completed_at < w.t1
      group by completed_by
    ), rep as (
      select reported_by as user_id, count(*) as reported
      from public.quality_issues where tenant_id = p_tenant and created_at >= w.t0 and created_at < w.t1
      group by reported_by
    ), resp as (
      select responsible_user_id as user_id, count(*) as responsible
      from public.quality_issues where tenant_id = p_tenant and created_at >= w.t0 and created_at < w.t1
      group by responsible_user_id
    ), dl as (
      select courier_id as user_id,
             count(*) filter (where status = 'completed') as stops_completed,
             count(*) filter (where status = 'failed') as stops_failed
      from public.deliveries
      where tenant_id = p_tenant and completed_at >= w.t0 and completed_at < w.t1
      group by courier_id
    )
    select jsonb_build_object(
      'from', p_from, 'to', p_to,
      'members', coalesce((
        select jsonb_agg(x order by x.sales_cents desc, x.steps desc, x.name) from (
          select m.user_id, m.display_name as name, m.role_name as role, m.active,
                 coalesce(ord.orders, 0) as orders, coalesce(ord.sales_cents, 0) as sales_cents,
                 coalesce(pay.payments, 0) as payments, coalesce(pay.collected_cents, 0) as collected_cents,
                 coalesce(pay.refunded_cents, 0) as refunded_cents,
                 coalesce(steps.steps, 0) as steps, steps.avg_minutes,
                 coalesce(steps.on_time_steps, 0) as on_time_steps, coalesce(steps.timed_steps, 0) as timed_steps,
                 coalesce(rep.reported, 0) as issues_reported, coalesce(resp.responsible, 0) as issues_responsible,
                 coalesce(dl.stops_completed, 0) as stops_completed, coalesce(dl.stops_failed, 0) as stops_failed
          from m
          left join ord on ord.user_id = m.user_id
          left join pay on pay.user_id = m.user_id
          left join steps on steps.user_id = m.user_id
          left join rep on rep.user_id = m.user_id
          left join resp on resp.user_id = m.user_id
          left join dl on dl.user_id = m.user_id
          where m.active or ord.orders > 0 or pay.payments > 0 or steps.steps > 0 or dl.stops_completed > 0) x), '[]'::jsonb),
      -- Throughput and speed per production phase.
      'phases', coalesce((
        select jsonb_agg(x order by x.position) from (
          select name, min(position) as position, count(*) as steps,
                 round(avg(extract(epoch from (completed_at - started_at)) / 60) filter (where started_at is not null))::int as avg_minutes,
                 round(avg(estimated_minutes))::int as estimated_minutes
          from public.order_production_steps
          where tenant_id = p_tenant and status = 'done' and completed_at >= w.t0 and completed_at < w.t1
          group by name) x), '[]'::jsonb)
    )
  );
end $$;

-- ── Operations: turnaround, promises, pickups and deliveries ───────────────

create or replace function public.analytics_operations(p_tenant uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  w record;
begin
  perform app.require_permission(p_tenant, 'reports.view');
  select * into w from app.report_window(p_tenant, p_from, p_to);
  return (
    with done as (
      select * from public.orders
      where tenant_id = p_tenant and status = 'delivered' and delivered_at >= w.t0 and delivered_at < w.t1
    ), dl as (
      select * from public.deliveries
      where tenant_id = p_tenant and scheduled_date between p_from and p_to and status <> 'cancelled'
    )
    select jsonb_build_object(
      'from', p_from, 'to', p_to,
      'delivered_orders', (select count(*) from done),
      'avg_hours_to_ready', (select round((avg(extract(epoch from (ready_at - created_at))) / 3600)::numeric, 1) from done where ready_at is not null),
      'avg_hours_to_deliver', (select round((avg(extract(epoch from (delivered_at - created_at))) / 3600)::numeric, 1) from done),
      'with_promise', (select count(*) from done where promised_at is not null),
      'on_time', (select count(*) from done where promised_at is not null and delivered_at <= promised_at),
      'late_open', (select count(*) from public.orders where tenant_id = p_tenant and status not in ('delivered', 'cancelled') and promised_at < now()),
      'cancelled', (select count(*) from public.orders where tenant_id = p_tenant and cancelled_at >= w.t0 and cancelled_at < w.t1),
      'cancel_reasons', coalesce((
        select jsonb_agg(jsonb_build_object('reason', reason, 'count', n) order by n desc) from (
          select coalesce(nullif(btrim(cancel_reason), ''), 'Sin motivo') as reason, count(*) as n
          from public.orders where tenant_id = p_tenant and cancelled_at >= w.t0 and cancelled_at < w.t1
          group by 1 order by 2 desc limit 10) x), '[]'::jsonb),
      'stops', coalesce((
        select jsonb_agg(jsonb_build_object('type', type, 'scheduled', n, 'completed', c, 'failed', f, 'pending', n - c - f)) from (
          select type, count(*) as n, count(*) filter (where status = 'completed') as c, count(*) filter (where status = 'failed') as f
          from dl group by type) x), '[]'::jsonb),
      'failure_reasons', coalesce((
        select jsonb_agg(jsonb_build_object('reason', reason, 'count', n) order by n desc) from (
          select coalesce(nullif(btrim(failure_reason), ''), 'Sin motivo') as reason, count(*) as n
          from dl where status = 'failed' group by 1 order by 2 desc limit 10) x), '[]'::jsonb),
      'by_window', coalesce((
        select jsonb_agg(jsonb_build_object('window', label, 'stops', n) order by n desc) from (
          select coalesce(window_label, to_char(window_start, 'HH24:MI'), 'Sin horario') as label, count(*) as n
          from dl group by 1) x), '[]'::jsonb)
    )
  );
end $$;

-- ── Quality issues ──────────────────────────────────────────────────────────

create or replace function public.analytics_quality(p_tenant uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  w record;
  v_bucket text := app.report_bucket(p_from, p_to);
begin
  perform app.require_permission(p_tenant, 'reports.view');
  select * into w from app.report_window(p_tenant, p_from, p_to);
  return (
    with q as (
      select * from public.quality_issues where tenant_id = p_tenant and created_at >= w.t0 and created_at < w.t1
    )
    select jsonb_build_object(
      'from', p_from, 'to', p_to, 'bucket', v_bucket,
      'total', (select count(*) from q),
      'previous_total', (select count(*) from public.quality_issues where tenant_id = p_tenant and created_at >= w.p0 and created_at < w.p1),
      'orders', (select count(*) from public.orders where tenant_id = p_tenant and status <> 'cancelled' and created_at >= w.t0 and created_at < w.t1),
      'orders_with_issues', (select count(distinct order_id) from q),
      'open', (select count(*) from q where status in ('open', 'in_progress')),
      'open_now', (select count(*) from public.quality_issues where tenant_id = p_tenant and status in ('open', 'in_progress')),
      'resolved', (select count(*) from q where status = 'resolved'),
      'avg_hours_to_resolve', (select round((avg(extract(epoch from (resolved_at - created_at))) / 3600)::numeric, 1) from q where resolved_at is not null),
      'by_type', coalesce((select jsonb_agg(jsonb_build_object('key', type, 'count', n) order by n desc) from (select type, count(*) as n from q group by type) x), '[]'::jsonb),
      'by_severity', coalesce((select jsonb_agg(jsonb_build_object('key', severity, 'count', n) order by n desc) from (select severity, count(*) as n from q group by severity) x), '[]'::jsonb),
      'by_status', coalesce((select jsonb_agg(jsonb_build_object('key', status, 'count', n) order by n desc) from (select status, count(*) as n from q group by status) x), '[]'::jsonb),
      'by_phase', coalesce((select jsonb_agg(jsonb_build_object('key', phase, 'count', n) order by n desc) from (
                   select coalesce(phase_name, 'Sin fase') as phase, count(*) as n from q group by 1) x), '[]'::jsonb),
      'by_responsible', coalesce((select jsonb_agg(jsonb_build_object('user_id', responsible_user_id, 'name', app.member_name(p_tenant, responsible_user_id), 'count', n) order by n desc)
                   from (select responsible_user_id, count(*) as n from q where responsible_user_id is not null group by 1) x), '[]'::jsonb),
      'series', coalesce((
        select jsonb_agg(jsonb_build_object('bucket', b.bucket, 'issues', coalesce(n.n, 0)) order by b.bucket)
        from (select g::date as bucket from generate_series(date_trunc(v_bucket, (w.t0 at time zone w.tz)),
                (w.t1 at time zone w.tz) - interval '1 second', ('1 ' || v_bucket)::interval) g) b
        left join (select date_trunc(v_bucket, created_at at time zone w.tz)::date as bucket, count(*) as n from q group by 1) n using (bucket)), '[]'::jsonb),
      'items', coalesce((
        select jsonb_agg(x order by x.created_at desc) from (
          select q.id, q.created_at, q.type, q.severity, q.status, q.description, q.phase_name, q.resolution, q.resolved_at,
                 o.id as order_id, o.number, c.name as customer_name,
                 app.member_name(p_tenant, q.reported_by) as reported_by_name,
                 app.member_name(p_tenant, q.responsible_user_id) as responsible_name
          from q join public.orders o on o.id = q.order_id join public.customers c on c.id = o.customer_id
          order by q.created_at desc limit 200) x), '[]'::jsonb)
    )
  );
end $$;

-- Only the public report functions are callable by the app; helpers stay private.
revoke all on function app.report_window(uuid, date, date), app.report_bucket(date, date),
  app.sales_kpis(uuid, timestamptz, timestamptz), app.sales_series(uuid, timestamptz, timestamptz, text, text),
  app.member_name(uuid, uuid) from public, anon, authenticated;
revoke all on function public.analytics_sales(uuid, date, date), public.analytics_services(uuid, date, date),
  public.analytics_customers(uuid, date, date), public.analytics_employees(uuid, date, date),
  public.analytics_operations(uuid, date, date), public.analytics_quality(uuid, date, date) from public, anon;
grant execute on function public.analytics_sales(uuid, date, date), public.analytics_services(uuid, date, date),
  public.analytics_customers(uuid, date, date), public.analytics_employees(uuid, date, date),
  public.analytics_operations(uuid, date, date), public.analytics_quality(uuid, date, date) to authenticated;

-- Reports scan whole periods: index the timestamps they filter on.
create index if not exists orders_tenant_created_idx on public.orders (tenant_id, created_at);
create index if not exists payments_tenant_created_idx on public.payments (tenant_id, created_at);
create index if not exists quality_issues_tenant_created_idx on public.quality_issues (tenant_id, created_at);
create index if not exists steps_tenant_completed_idx on public.order_production_steps (tenant_id, completed_at) where status = 'done';
