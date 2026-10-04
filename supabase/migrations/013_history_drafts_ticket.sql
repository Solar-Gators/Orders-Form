-- =============================================================================
-- 013 — Request history, deleting drafts, withdrawing, required ticket number
--
--   * request_events: a request's History now records when it was submitted,
--     resubmitted (with what changed since the reviewer last saw it),
--     withdrawn, ordered and received, and by whom.
--   * delete_request: the person who made a request can delete it while it's
--     a Draft or has Changes Requested.
--   * withdraw_request: ...and pull a Submitted request back to Draft.
--   * mark_ordered requires the ticket / Dept. order number unless Admin →
--     Settings turns that off (form.requireOrderNumber, on by default).
--   * Budgets are set by the Treasurer (set_budgets), and an approval that
--     would go over a budget is allowed with a written reason, which is kept
--     in the request's History ("Approved over budget: …").
--
-- Run once, after 012: Supabase → SQL Editor → New query → paste → Run.
-- =============================================================================

create table public.request_events (
  id          bigserial primary key,
  request_id  uuid not null references public.requests(id) on delete cascade,
  kind        text not null check (kind in ('submitted', 'resubmitted', 'withdrawn', 'ordered', 'received')),
  actor_id    uuid references public.profiles(id) on delete set null,
  actor_name  text not null default '',   -- name at the time
  changes     text[] not null default '{}',
  note        text not null default '',
  snapshot    jsonb,                       -- the request as submitted (to compare a resubmission with)
  created_at  timestamptz not null default now()
);
create index request_events_request_idx on public.request_events (request_id, id);
alter table public.request_events enable row level security;
create policy "signed-in read" on public.request_events for select to authenticated using (true);
revoke all on public.request_events from anon, authenticated;
grant select on public.request_events to authenticated;

update public.app_settings set value = value || '{"requireOrderNumber": true}'
where key = 'form' and not value ? 'requireOrderNumber';


-- The request and its items as one value, for comparing versions.
create or replace function public.request_snapshot(p_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'request', jsonb_build_object('title', r.title, 'requester', r.requester, 'subsystem', r.subsystem, 'priority', r.priority,
                                  'needed_by', r.needed_by, 'justification', r.justification, 'data', r.data),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
                'item_name', i.item_name, 'vendor', i.vendor, 'product_link', i.product_link, 'part_number', i.part_number,
                'quantity', i.quantity, 'unit_price', i.unit_price, 'shipping_cost', i.shipping_cost, 'notes', i.notes, 'data', i.data)
              order by i.position) from request_items i where i.request_id = r.id), '[]'))
  from requests r where r.id = p_id;
$$;

-- What changed between two snapshots, in words: "Needed by: 2026-10-30 → 2026-11-05",
-- "Item 2 Unit price: 5 → 7.5", "Items: 3 → 4". At most 15 lines.
create or replace function public.describe_request_changes(p_old jsonb, p_new jsonb, p_form jsonb)
returns text[]
language plpgsql stable set search_path = public, pg_temp
as $$
declare
  v_out   text[] := '{}';
  v_field jsonb;
  v_key   text;
  v_a     text;
  v_b     text;
  v_i     int;
  v_na    int := jsonb_array_length(coalesce(p_old -> 'items', '[]'));
  v_nb    int := jsonb_array_length(coalesce(p_new -> 'items', '[]'));
  v_show  constant text := '(blank)';
begin
  for v_field in select * from jsonb_array_elements(coalesce(p_form -> 'requestFields', '[]')) loop
    continue when v_field ->> 'type' = 'section';
    v_key := v_field ->> 'key';
    v_a := form_value(p_old -> 'request', v_key);
    v_b := form_value(p_new -> 'request', v_key);
    if v_a is distinct from v_b then
      v_out := array_append(v_out, format('%s: %s → %s', coalesce(v_field ->> 'label', v_key),
        left(coalesce(nullif(v_a, ''), v_show), 60), left(coalesce(nullif(v_b, ''), v_show), 60)));
    end if;
  end loop;

  if v_na <> v_nb then
    v_out := array_append(v_out, format('Items: %s → %s', v_na, v_nb));
  end if;
  for v_i in 0 .. least(v_na, v_nb) - 1 loop
    for v_field in select * from jsonb_array_elements(coalesce(p_form -> 'itemFields', '[]')) loop
      v_key := v_field ->> 'key';
      v_a := form_value(p_old -> 'items' -> v_i, v_key);
      v_b := form_value(p_new -> 'items' -> v_i, v_key);
      -- Numbers compare by value (5 = 5.00) and show without trailing zeros.
      if v_a ~ '^-?\d*\.?\d+$' and v_b ~ '^-?\d*\.?\d+$' and v_a::numeric = v_b::numeric then continue; end if;
      if v_a ~ '^-?\d*\.?\d+$' then v_a := trim_scale(v_a::numeric)::text; end if;
      if v_b ~ '^-?\d*\.?\d+$' then v_b := trim_scale(v_b::numeric)::text; end if;
      if v_a is distinct from v_b then
        v_out := array_append(v_out, format('Item %s %s: %s → %s', v_i + 1, coalesce(v_field ->> 'label', v_key),
          left(coalesce(nullif(v_a, ''), v_show), 60), left(coalesce(nullif(v_b, ''), v_show), 60)));
      end if;
    end loop;
  end loop;

  if cardinality(v_out) > 15 then
    v_out := v_out[1:14] || format('…and %s more changes', cardinality(v_out) - 14);
  end if;
  return v_out;
end;
$$;


-- The requester: delete a Draft or a request with Changes Requested.
create or replace function public.delete_request(p_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_req requests;
begin
  select * into v_req from requests where id = p_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if v_req.created_by is distinct from auth.uid() then
    raise exception 'Only the person who made % can delete it.', v_req.request_number;
  end if;
  if v_req.status not in ('Draft', 'Changes Requested') then
    raise exception '% is "%". Only drafts and requests sent back for changes can be deleted.', v_req.request_number, v_req.status;
  end if;
  delete from requests where id = p_id;
end;
$$;

-- The requester: pull a Submitted request back to Draft (e.g. no longer needed,
-- or to change it before anyone reviews it). Approvals so far won't count.
create or replace function public.withdraw_request(p_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_req requests;
begin
  select * into v_req from requests where id = p_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if v_req.created_by is distinct from auth.uid() then
    raise exception 'Only the person who made % can withdraw it.', v_req.request_number;
  end if;
  if v_req.status <> 'Submitted' then
    raise exception '% is "%", not Submitted, so it can''t be withdrawn.', v_req.request_number, v_req.status;
  end if;
  update requests set status = 'Draft', updated_at = now() where id = p_id;
  insert into request_events (request_id, kind, actor_id, actor_name) values (p_id, 'withdrawn', auth.uid(), my_display_name());
end;
$$;


-- Budgets (per Cost center, Subsystem, …) are set by the Treasurer: anyone with
-- "Order & receive" (or "Workflow, budgets & notifications") can change them.
-- p_budgets: { field, amounts: { option: dollars }, block }
create or replace function public.set_budgets(p_budgets jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_clean jsonb;
  v_bad   text;
begin
  if not (has_permission('request.order') or has_permission('workflow.edit')) then
    raise exception 'Only the Treasurer can change budgets.';
  end if;
  if jsonb_typeof(coalesce(p_budgets, '{}')) <> 'object' then raise exception 'Budgets must be a JSON object.'; end if;
  select key into v_bad from jsonb_each_text(coalesce(p_budgets -> 'amounts', '{}'))
  where value !~ '^\d*\.?\d+$' limit 1;
  if v_bad is not null then raise exception 'The budget for "%" must be a dollar amount of 0 or more.', v_bad; end if;
  v_clean := jsonb_build_object(
    'field', coalesce(p_budgets ->> 'field', ''),
    'amounts', coalesce(p_budgets -> 'amounts', '{}'),
    'block', coalesce((p_budgets -> 'block') = 'true'::jsonb, false));
  insert into app_settings (key, value, updated_at, updated_by)
  values ('workflow', jsonb_build_object('rules', '[]'::jsonb, 'budgets', v_clean), now(), auth.uid())
  on conflict (key) do update set value = app_settings.value || jsonb_build_object('budgets', v_clean), updated_at = now(), updated_by = auth.uid();
end;
$$;


-- ---------------------------------------------------------------------------
-- "Needs your approval" messages wait a while (Admin → Notifications,
-- notifications.approvalDelayMinutes, 30 by default; 0 = right away). If the
-- request is approved, sent back, rejected or withdrawn in the meantime — e.g.
-- a CE approving their own order — the message is cancelled instead of sent.
-- ---------------------------------------------------------------------------
alter table public.notification_outbox add column send_after timestamptz not null default now();
alter table public.notification_outbox drop constraint notification_outbox_status_check;
alter table public.notification_outbox add constraint notification_outbox_status_check
  check (status in ('pending', 'sending', 'sent', 'failed', 'cancelled'));

create or replace function public.delay_approval_messages()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_minutes text := (select value ->> 'approvalDelayMinutes' from app_settings where key = 'notifications');
begin
  if new.event = 'submitted' then
    new.send_after := now() + make_interval(mins => case when v_minutes ~ '^\d+$' then least(v_minutes::int, 1440) else 30 end);
  end if;
  return new;
end;
$$;
create trigger notification_outbox_delay
  before insert on public.notification_outbox
  for each row execute function public.delay_approval_messages();

-- Same as 010, plus: only messages whose time has come, and "needs your approval"
-- messages for requests that aren't waiting any more are cancelled first.
create or replace function public.claim_notifications(p_limit int)
returns setof public.notification_outbox
language plpgsql security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  update notification_outbox o set status = 'cancelled', error = 'No longer waiting for approval when it was due.'
  from requests r
  where o.status = 'pending' and o.event = 'submitted' and o.request_id = r.id
    and (r.status <> 'Submitted' or coalesce((r.approval_plan ->> 'submitted_at')::timestamptz, o.created_at) > o.created_at);

  return query
  update notification_outbox set status = 'sending', attempts = attempts + 1, claimed_at = now()
  where id in (
    select id from notification_outbox
    where (status = 'pending' and send_after <= now())
       or (status = 'sending' and claimed_at < now() - interval '10 minutes' and attempts < 5)
    order by id limit p_limit
    for update skip locked)
  returning *;
end;
$$;

update public.app_settings set value = value || '{"approvalDelayMinutes": 30}'
where key = 'notifications' and not value ? 'approvalDelayMinutes';


-- Treasurer: Approved -> Ordered. Same as 001, plus the required ticket number
-- (setting) and a History entry with who did it.
create or replace function public.mark_ordered(p_id uuid, p_order_date date, p_order_number text, p_notes text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_req requests;
begin
  perform require_permission('request.order');
  select * into v_req from requests where id = p_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if v_req.status <> 'Approved' then
    raise exception '% is "%", not Approved.', v_req.request_number, v_req.status;
  end if;
  if trim(coalesce(p_order_number, '')) = ''
     and ((select value -> 'requireOrderNumber' from app_settings where key = 'form') is distinct from 'false'::jsonb) then
    raise exception 'Enter the ticket / Dept. order number for %.', v_req.request_number;
  end if;

  insert into order_information (request_id, order_date, department_order_number, treasurer_notes, ordered_by)
  values (p_id, coalesce(p_order_date, current_date), trim(coalesce(p_order_number, '')), trim(coalesce(p_notes, '')), auth.uid())
  on conflict (request_id) do update set
    order_date = excluded.order_date,
    department_order_number = excluded.department_order_number,
    treasurer_notes = excluded.treasurer_notes,
    ordered_by = excluded.ordered_by;

  update requests set status = 'Ordered', updated_at = now() where id = p_id;
  insert into request_events (request_id, kind, actor_id, actor_name, note)
  values (p_id, 'ordered', auth.uid(), my_display_name(), trim(coalesce(p_order_number, '')));
end;
$$;

-- Treasurer: Ordered -> Received. Same as 001, plus a History entry with who did it.
create or replace function public.mark_received(p_id uuid, p_received_date date, p_notes text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_req requests;
begin
  perform require_permission('request.order');
  select * into v_req from requests where id = p_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if v_req.status <> 'Ordered' then
    raise exception '% is "%", not Ordered.', v_req.request_number, v_req.status;
  end if;

  update order_information set
    received_date = coalesce(p_received_date, current_date),
    received_notes = trim(coalesce(p_notes, '')),
    received_by = auth.uid()
  where request_id = p_id;

  update requests set status = 'Received', updated_at = now() where id = p_id;
  insert into request_events (request_id, kind, actor_id, actor_name) values (p_id, 'received', auth.uid(), my_display_name());
end;
$$;


-- save_request: same as 010, plus History entries for submitting / resubmitting.
create or replace function public.save_request(p_id uuid, p_request jsonb, p_items jsonb, p_action text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_submit    boolean := p_action = 'submit';
  v_form      jsonb;
  v_rf        jsonb;
  v_if        jsonb;
  v_errors    text[] := '{}';
  v_existing  requests;
  v_prev_snap jsonb;
  v_changes   text[] := '{}';
  v_id        uuid;
  v_number    text;
  v_title     text := trim(coalesce(p_request ->> 'title', ''));
  v_requester text := trim(coalesce(p_request ->> 'requester', ''));
  v_subsystem text := trim(coalesce(p_request ->> 'subsystem', ''));
  v_priority  text := trim(coalesce(p_request ->> 'priority', ''));
  v_needed    text := trim(coalesce(p_request ->> 'needed_by', ''));
  v_just      text := trim(coalesce(p_request ->> 'justification', ''));
  v_needed_by date;
  v_values    jsonb;
  v_custom    record;
  v_rdata     jsonb;
  v_field     jsonb;
  v_key       text;
  v_val       text;
  v_items     jsonb := '[]';
  v_item      jsonb;
  v_n         int := 0;
  v_qty_txt   text;
  v_price_txt text;
  v_label     text;
  v_qty_bad   boolean;
  v_price_bad boolean;
  v_ship_txt  text;
  v_ship_bad  boolean;
  v_vendors   text[];
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if p_action not in ('draft', 'submit') then raise exception 'action must be draft or submit'; end if;

  select value into v_form from app_settings where key = 'form';
  v_rf := coalesce(v_form -> 'requestFields', '[]');
  v_if := coalesce(v_form -> 'itemFields', '[]');
  if v_priority = '' then v_priority := coalesce(v_form ->> 'defaultPriority', ''); end if;

  -- Built-in request fields
  if v_title = '' then
    v_errors := array_append(v_errors, form_field_label(v_rf, 'title', 'Request title') || ' is required.');
  end if;
  if v_subsystem <> '' and not (v_form -> 'subsystems') ? v_subsystem then
    v_errors := array_append(v_errors, format('Unknown subsystem "%s".', v_subsystem));
  end if;
  if v_priority <> '' and not (v_form -> 'priorities') ? v_priority then
    v_errors := array_append(v_errors, format('Unknown priority "%s".', v_priority));
  end if;
  if v_needed <> '' then
    if is_valid_date(v_needed) then
      v_needed_by := v_needed::date;
    else
      v_errors := array_append(v_errors, form_field_label(v_rf, 'needed_by', 'Needed-by date') || ' must be a valid date.');
    end if;
  end if;

  if v_submit then
    v_values := jsonb_build_object('requester', v_requester, 'subsystem', v_subsystem, 'priority', v_priority,
                                   'needed_by', v_needed, 'justification', v_just);
    for v_field in select * from jsonb_array_elements(v_rf) loop
      continue when (v_field -> 'builtin') is distinct from 'true'::jsonb or v_field ->> 'key' = 'title'
                 or (v_field -> 'hidden') = 'true'::jsonb or (v_field -> 'required') is distinct from 'true'::jsonb
                 or not field_visible(v_field, p_request, null);
      if coalesce(v_values ->> (v_field ->> 'key'), '') = '' then
        v_errors := array_append(v_errors, (v_field ->> 'label') || ' is required.');
      end if;
    end loop;
  end if;

  -- Custom request fields
  select * into v_custom from clean_custom_fields(v_rf, p_request -> 'data', '', v_submit, p_request, null);
  v_rdata := v_custom.o_data;
  v_errors := v_errors || v_custom.o_errors;

  -- Items: drop fully blank rows, validate the rest.
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
    v_qty_txt   := regexp_replace(trim(coalesce(v_item ->> 'quantity', '')), '[$,]', '', 'g');
    v_price_txt := regexp_replace(trim(coalesce(v_item ->> 'unit_price', '')), '[$,]', '', 'g');
    v_ship_txt  := regexp_replace(trim(coalesce(v_item ->> 'shipping_cost', '')), '[$,]', '', 'g');
    continue when trim(coalesce(v_item ->> 'item_name', '')) = '' and trim(coalesce(v_item ->> 'vendor', '')) = ''
              and trim(coalesce(v_item ->> 'product_link', '')) = '' and trim(coalesce(v_item ->> 'part_number', '')) = ''
              and trim(coalesce(v_item ->> 'notes', '')) = '' and v_qty_txt = '' and v_price_txt = '' and v_ship_txt = ''
              and not exists (select 1 from jsonb_each_text(case when jsonb_typeof(v_item -> 'data') = 'object'
                                                                 then v_item -> 'data' else '{}' end) d
                              where trim(d.value) <> '');
    v_n := v_n + 1;
    v_label := 'Item ' || v_n || ': ';
    v_qty_bad := false;
    v_price_bad := false;
    v_ship_bad := false;

    if v_qty_txt <> '' and (v_qty_txt !~ '^\d*\.?\d+$' or v_qty_txt::numeric <= 0) then
      v_errors := array_append(v_errors, v_label || form_field_label(v_if, 'quantity', 'Quantity') || ' must be a positive number.');
      v_qty_txt := '';
      v_qty_bad := true;
    end if;
    if v_price_txt <> '' and v_price_txt !~ '^\d*\.?\d+$' then
      v_errors := array_append(v_errors, v_label || form_field_label(v_if, 'unit_price', 'Unit price') || ' must be a number of 0 or more.');
      v_price_txt := '';
      v_price_bad := true;
    end if;
    if v_ship_txt <> '' and v_ship_txt !~ '^\d*\.?\d+$' then
      v_errors := array_append(v_errors, v_label || form_field_label(v_if, 'shipping_cost', 'Shipping') || ' must be a number of 0 or more.');
      v_ship_txt := '';
      v_ship_bad := true;
    end if;

    if v_submit then
      -- Item name, quantity and unit price are always required; others per settings.
      foreach v_key in array array['item_name', 'vendor', 'product_link', 'part_number', 'quantity', 'unit_price', 'shipping_cost', 'notes'] loop
        select f into v_field from jsonb_array_elements(v_if) f where f ->> 'key' = v_key;
        continue when v_key not in ('item_name', 'quantity', 'unit_price')
                   and (v_field is null or (v_field -> 'required') is distinct from 'true'::jsonb or (v_field -> 'hidden') = 'true'::jsonb
                        or not field_visible(v_field, p_request, v_item));
        -- Already reported as invalid; don't also say it's missing.
        continue when (v_key = 'quantity' and v_qty_bad) or (v_key = 'unit_price' and v_price_bad)
                   or (v_key = 'shipping_cost' and v_ship_bad);
        v_val := case v_key when 'quantity' then v_qty_txt when 'unit_price' then v_price_txt
                            when 'shipping_cost' then v_ship_txt
                            else trim(coalesce(v_item ->> v_key, '')) end;
        if v_val = '' then
          v_errors := array_append(v_errors, v_label || form_field_label(v_if, v_key, initcap(replace(v_key, '_', ' '))) || ' is required.');
        end if;
      end loop;
    end if;

    select * into v_custom from clean_custom_fields(v_if, v_item -> 'data', v_label, v_submit, p_request, v_item);
    v_errors := v_errors || v_custom.o_errors;

    v_items := v_items || jsonb_build_object(
      'item_name',    trim(coalesce(v_item ->> 'item_name', '')),
      'vendor',       trim(coalesce(v_item ->> 'vendor', '')),
      'product_link', trim(coalesce(v_item ->> 'product_link', '')),
      'part_number',  trim(coalesce(v_item ->> 'part_number', '')),
      'quantity',     nullif(v_qty_txt, ''),
      'unit_price',   nullif(v_price_txt, ''),
      'shipping_cost', nullif(v_ship_txt, ''),
      'notes',        trim(coalesce(v_item ->> 'notes', '')),
      'data',         v_custom.o_data
    );
  end loop;
  if v_submit and v_n = 0 then v_errors := array_append(v_errors, 'Add at least one item.'); end if;

  -- One vendor per request (setting form.oneVendorPerRequest, on unless set to false;
  -- skipped when the Vendor field is hidden). Compared ignoring case and spacing.
  if (v_form -> 'oneVendorPerRequest') is distinct from 'false'::jsonb
     and not exists (select 1 from jsonb_array_elements(v_if) f where f ->> 'key' = 'vendor' and (f -> 'hidden') = 'true'::jsonb) then
    select array_agg(v order by v) into v_vendors from (
      select min(i ->> 'vendor') as v
      from jsonb_array_elements(v_items) i
      where trim(i ->> 'vendor') <> ''
      group by lower(regexp_replace(trim(i ->> 'vendor'), '\s+', ' ', 'g'))
    ) d;
    if cardinality(v_vendors) > 1 then
      v_errors := array_append(v_errors, format(
        'All items in a request must come from the same %s. This one has: %s. Split them into separate requests.',
        lower(form_field_label(v_if, 'vendor', 'Vendor')), array_to_string(v_vendors, ', ')));
    end if;
  end if;

  if cardinality(v_errors) > 0 then
    raise exception using message = 'Please fix the following:', detail = array_to_string(v_errors, E'\n');
  end if;

  if p_id is null then
    insert into requests (created_by, title, requester, subsystem, priority, needed_by, justification, data, status)
    values (v_uid, v_title, v_requester, v_subsystem, v_priority, v_needed_by, v_just, v_rdata,
            case when v_submit then 'Submitted' else 'Draft' end)
    returning id, request_number into v_id, v_number;
  else
    select * into v_existing from requests where id = p_id for update;
    if not found then raise exception 'Request not found.'; end if;
    if v_existing.created_by is distinct from v_uid then
      raise exception 'Only the person who created % can edit it.', v_existing.request_number;
    end if;
    if v_existing.status not in ('Draft', 'Changes Requested') then
      raise exception '% is "%" and can no longer be edited.', v_existing.request_number, v_existing.status;
    end if;
    update requests set
      title = v_title, requester = v_requester, subsystem = v_subsystem, priority = v_priority,
      needed_by = v_needed_by, justification = v_just, data = v_rdata,
      status = case when v_submit then 'Submitted' else 'Draft' end,
      updated_at = now()
    where id = p_id;
    delete from request_items where request_id = p_id;
    v_id := p_id;
    v_number := v_existing.request_number;
  end if;

  insert into request_items (request_id, position, item_name, vendor, product_link, part_number, quantity, unit_price, shipping_cost, notes, data)
  select v_id, (e.ord - 1)::int, e.item ->> 'item_name', e.item ->> 'vendor', e.item ->> 'product_link',
         e.item ->> 'part_number', (e.item ->> 'quantity')::numeric, (e.item ->> 'unit_price')::numeric,
         (e.item ->> 'shipping_cost')::numeric, e.item ->> 'notes', e.item -> 'data'
  from jsonb_array_elements(v_items) with ordinality as e(item, ord);

  if v_submit then
    -- History: first submission, or a resubmission with what changed since the
    -- reviewer last saw it (compared with the snapshot taken at that submission).
    select snapshot into v_prev_snap from request_events
    where request_id = v_id and kind in ('submitted', 'resubmitted') order by id desc limit 1;
    if v_prev_snap is not null then
      v_changes := describe_request_changes(v_prev_snap, request_snapshot(v_id), v_form);
    end if;
    insert into request_events (request_id, kind, actor_id, actor_name, changes, snapshot)
    values (v_id, case when v_prev_snap is null then 'submitted' else 'resubmitted' end,
            v_uid, my_display_name(), v_changes, request_snapshot(v_id));
    perform on_request_submitted(v_id);
  end if;

  return v_number;
end;
$$;

-- review_request: same as 010, except going over a blocking budget needs a note instead of being refused.
create or replace function public.review_request(p_id uuid, p_decision text, p_comment text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_req      requests;
  v_plan     jsonb;
  v_comment  text := trim(coalesce(p_comment, ''));
  v_people   uuid[];
  v_missing  uuid[];
  v_problem  text;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if p_decision not in ('approve', 'request_changes', 'reject') then
    raise exception 'Decision must be approve, request_changes or reject.';
  end if;
  if p_decision <> 'approve' and v_comment = '' then
    raise exception 'A comment is required when requesting changes or rejecting.';
  end if;

  select * into v_req from requests where id = p_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if v_req.status <> 'Submitted' then
    raise exception '% is "%", not Submitted.', v_req.request_number, v_req.status;
  end if;

  v_plan := coalesce(v_req.approval_plan, jsonb_build_object('type', 'any', 'submitted_at', v_req.updated_at));
  if v_plan ->> 'type' = 'people' then
    v_people := plan_approvers(v_plan);
    if not (auth.uid() = any(v_people) or has_permission('workflow.edit')) then
      raise exception 'Only % can review %.',
        (select string_agg(coalesce(nullif(full_name, ''), email), ', ') from profiles where id = any(v_people)), v_req.request_number;
    end if;
  else
    perform require_permission('request.review');
  end if;

  insert into approvals (request_id, approver_id, approver, decision, comment)
  values (p_id, auth.uid(), my_display_name(), p_decision, v_comment);

  if p_decision = 'approve' then
    if (v_plan -> 'needAll') = 'true'::jsonb then
      select coalesce(array_agg(p), '{}') into v_missing
      from unnest(v_people) p
      where not exists (
        select 1 from approvals a
        where a.request_id = p_id and a.approver_id = p and a.decision = 'approve'
          and a.created_at >= coalesce((v_plan ->> 'submitted_at')::timestamptz, '-infinity'));
      if cardinality(v_missing) > 0 then
        update requests set updated_at = now() where id = p_id; -- still waiting on others
        return;
      end if;
    end if;
    v_problem := budget_problem(p_id);
    if v_problem is not null then
      -- Over budget: allowed with a written reason, kept with the approval.
      if v_comment = '' then
        raise exception '% To approve it anyway, add a note saying why.', v_problem;
      end if;
      update approvals set comment = 'Approved over budget: ' || v_comment
      where id = (select id from approvals where request_id = p_id and approver_id = auth.uid() order by created_at desc limit 1);
    end if;
  end if;

  update requests set
    status = case p_decision when 'approve' then 'Approved' when 'reject' then 'Rejected' else 'Changes Requested' end,
    updated_at = now()
  where id = p_id;
end;
$$;


revoke execute on function
  public.request_snapshot(uuid),
  public.describe_request_changes(jsonb, jsonb, jsonb),
  public.delay_approval_messages()
from public, anon, authenticated;
revoke execute on function public.delete_request(uuid), public.withdraw_request(uuid), public.set_budgets(jsonb) from public, anon;
grant execute on function public.delete_request(uuid), public.withdraw_request(uuid), public.set_budgets(jsonb) to authenticated;

update public.app_settings set value = value || '{"schemaVersion": 13}' where key = 'general';
