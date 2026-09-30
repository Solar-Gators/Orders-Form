-- =============================================================================
-- 004 — Shipping per item + Treasurer cost adjustments
--
--   * request_items.shipping_cost: a built-in Shipping field (members can fill
--     it in; the request total = items + shipping).
--   * update_item_costs(): the Treasurer can change unit price / shipping on
--     Approved, Ordered and Received requests. Every change is logged in
--     cost_changes (who, when, old → new, reason) and shown in the history.
--   * A custom "Shipping…" item field (e.g. from importing an old sheet) is
--     folded into the new built-in field.
--
-- Run once, after 003: Supabase → SQL Editor → New query → paste → Run.
-- =============================================================================

alter table public.request_items add column shipping_cost numeric;

create table public.cost_changes (
  id              uuid primary key default gen_random_uuid(),
  request_id      uuid not null references public.requests(id) on delete cascade,
  item_id         uuid,           -- request_items.id (no FK on purpose: keeps the API's embeds unambiguous)
  item_name       text not null default '',
  field           text not null check (field in ('unit_price', 'shipping_cost')),
  old_value       numeric,
  new_value       numeric,
  reason          text not null default '',
  changed_by      uuid references public.profiles(id) on delete set null,
  changed_by_name text not null,
  created_at      timestamptz not null default now()
);
create index cost_changes_request_idx on public.cost_changes (request_id);

alter table public.cost_changes enable row level security;
create policy "signed-in read" on public.cost_changes for select to authenticated using (true);
revoke all on public.cost_changes from anon, authenticated;
grant select on public.cost_changes to authenticated;


-- Shipping is now a built-in item field.
create or replace function public.validate_form_fields(p_fields jsonb, p_kind text)
returns void
language plpgsql immutable set search_path = public, pg_temp
as $$
declare
  v_builtin text[] := case p_kind
    when 'request' then array['title', 'requester', 'subsystem', 'priority', 'needed_by', 'justification']
    else array['item_name', 'vendor', 'product_link', 'part_number', 'quantity', 'unit_price', 'shipping_cost', 'notes'] end;
  v_locked text[] := array['title', 'item_name', 'quantity', 'unit_price'];
  v_what   text := case p_kind when 'request' then 'request' else 'item' end;
  v_field  jsonb;
  v_key    text;
  v_label  text;
  v_keys   text[] := '{}';
  v_b      text;
begin
  if coalesce(jsonb_typeof(p_fields), '') <> 'array' then
    raise exception 'The % field list is missing.', v_what;
  end if;
  if jsonb_array_length(p_fields) > 60 then
    raise exception 'Too many % fields (60 max).', v_what;
  end if;

  for v_field in select * from jsonb_array_elements(p_fields) loop
    v_key := v_field ->> 'key';
    v_label := trim(coalesce(v_field ->> 'label', ''));
    if v_key is null or v_key !~ '^[a-z][a-z0-9_]{0,39}$' then
      raise exception 'Invalid field key "%".', v_key;
    end if;
    if v_key = any(v_keys) then raise exception 'The field "%" appears twice.', v_key; end if;
    v_keys := array_append(v_keys, v_key);
    if v_label = '' then raise exception 'Every field needs a label.'; end if;

    if v_key = any(v_builtin) then
      if (v_field -> 'builtin') is distinct from 'true'::jsonb then
        raise exception '"%" is a built-in field.', v_label;
      end if;
    else
      if (v_field -> 'builtin') = 'true'::jsonb then
        raise exception '"%" is not a built-in field.', v_label;
      end if;
      if coalesce(v_field ->> 'type', '') not in ('text', 'textarea', 'number', 'date', 'select', 'yesno', 'url') then
        raise exception 'The field "%" has an unknown type.', v_label;
      end if;
      if v_field ->> 'type' = 'select'
         and (coalesce(jsonb_typeof(v_field -> 'options'), '') <> 'array' or jsonb_array_length(v_field -> 'options') = 0) then
        raise exception 'The dropdown "%" needs at least one option.', v_label;
      end if;
    end if;

    if v_key = any(v_locked)
       and ((v_field -> 'required') is distinct from 'true'::jsonb or (v_field -> 'hidden') = 'true'::jsonb) then
      raise exception '"%" must stay required and shown.', v_label;
    end if;
  end loop;

  foreach v_b in array v_builtin loop
    if not v_b = any(v_keys) then
      raise exception 'The built-in field "%" can''t be removed — hide it instead.', v_b;
    end if;
  end loop;
end;
$$;


-- save_request: same as 002, plus a shipping cost per item.
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
                 or (v_field -> 'hidden') = 'true'::jsonb or (v_field -> 'required') is distinct from 'true'::jsonb;
      if coalesce(v_values ->> (v_field ->> 'key'), '') = '' then
        v_errors := array_append(v_errors, (v_field ->> 'label') || ' is required.');
      end if;
    end loop;
  end if;

  -- Custom request fields
  select * into v_custom from clean_custom_fields(v_rf, p_request -> 'data', '', v_submit);
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
                   and (v_field is null or (v_field -> 'required') is distinct from 'true'::jsonb or (v_field -> 'hidden') = 'true'::jsonb);
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

    select * into v_custom from clean_custom_fields(v_if, v_item -> 'data', v_label, v_submit);
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

  return v_number;
end;
$$;



-- import_requests: same as 003, plus shipping from the old sheets.
create or replace function public.import_requests(p_requests jsonb)
returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_req    jsonb;
  v_id     uuid;
  v_status text;
  v_date   date;
  v_at     timestamptz;
  v_n      int := 0;
begin
  perform require_permission('settings.edit');
  if coalesce(jsonb_typeof(p_requests), '') <> 'array' then raise exception 'Nothing to import.'; end if;

  for v_req in select * from jsonb_array_elements(p_requests) loop
    v_status := coalesce(v_req ->> 'status', 'Submitted');
    if v_status not in ('Submitted', 'Approved', 'Rejected', 'Ordered', 'Received') then
      raise exception 'Unsupported status "%".', v_status;
    end if;
    v_date := case when is_valid_date(v_req ->> 'date') then (v_req ->> 'date')::date else current_date end;
    v_at := v_date + time '12:00';  -- midday so the date doesn't shift across time zones

    insert into requests (created_by, title, requester, subsystem, priority, justification, status, data, created_at, updated_at)
    values (null,
            left(coalesce(nullif(trim(v_req ->> 'title'), ''), 'Imported request'), 200),
            left(trim(coalesce(v_req ->> 'requester', '')), 200),
            left(trim(coalesce(v_req ->> 'subsystem', '')), 200),
            left(trim(coalesce(v_req ->> 'priority', '')), 100),
            trim(coalesce(v_req ->> 'justification', '')),
            v_status,
            case when jsonb_typeof(v_req -> 'data') = 'object' then v_req -> 'data' else '{}' end,
            v_at, v_at)
    returning id into v_id;

    insert into request_items (request_id, position, item_name, vendor, product_link, part_number, quantity, unit_price, shipping_cost, notes, data)
    select v_id, (e.ord - 1)::int,
           left(coalesce(e.item ->> 'item_name', ''), 500), left(coalesce(e.item ->> 'vendor', ''), 200),
           coalesce(e.item ->> 'product_link', ''), left(coalesce(e.item ->> 'part_number', ''), 200),
           case when coalesce(e.item ->> 'quantity', '') ~ '^\d*\.?\d+$' then (e.item ->> 'quantity')::numeric end,
           case when coalesce(e.item ->> 'unit_price', '') ~ '^\d*\.?\d+$' then (e.item ->> 'unit_price')::numeric end,
           case when coalesce(e.item ->> 'shipping_cost', '') ~ '^\d*\.?\d+$' then (e.item ->> 'shipping_cost')::numeric end,
           coalesce(e.item ->> 'notes', ''),
           case when jsonb_typeof(e.item -> 'data') = 'object' then e.item -> 'data' else '{}' end
    from jsonb_array_elements(coalesce(v_req -> 'items', '[]')) with ordinality as e(item, ord);

    if trim(coalesce(v_req ->> 'approver', '')) <> '' then
      insert into approvals (request_id, approver_id, approver, decision, comment, created_at)
      values (v_id, null, trim(v_req ->> 'approver'),
              case when v_status = 'Rejected' then 'reject' else 'approve' end,
              'Imported from spreadsheet', v_at);
    end if;

    if v_status in ('Ordered', 'Received') then
      insert into order_information (request_id, order_date, department_order_number, treasurer_notes, received_notes)
      values (v_id, v_date, trim(coalesce(v_req ->> 'ticket', '')), 'Imported from spreadsheet',
              case when v_status = 'Received' then trim(coalesce(v_req ->> 'received_notes', '')) else '' end);
    end if;

    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;



-- ---------------------------------------------------------------------------
-- Treasurer: change unit price / shipping after approval (logged).
-- p_items: [{ id, unit_price?, shipping_cost? }] — only the keys present are changed;
-- an empty shipping_cost clears it. Returns how many values changed.
-- ---------------------------------------------------------------------------
create or replace function public.update_item_costs(p_request_id uuid, p_items jsonb, p_reason text)
returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_req   requests;
  v_item  jsonb;
  v_row   request_items;
  v_txt   text;
  v_new   numeric;
  v_n     int := 0;
  v_who   text := my_display_name();
  v_why   text := trim(coalesce(p_reason, ''));
begin
  perform require_permission('request.order');
  select * into v_req from requests where id = p_request_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if v_req.status not in ('Approved', 'Ordered', 'Received') then
    raise exception '% is "%". Costs can be adjusted once a request is approved.', v_req.request_number, v_req.status;
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
    select * into v_row from request_items where id = (v_item ->> 'id')::uuid and request_id = p_request_id for update;
    if not found then raise exception 'That item is not on %.', v_req.request_number; end if;

    if v_item ? 'unit_price' then
      v_txt := regexp_replace(trim(coalesce(v_item ->> 'unit_price', '')), '[$,]', '', 'g');
      if v_txt !~ '^\d*\.?\d+$' then
        raise exception '%: unit price must be a number of 0 or more.', v_row.item_name;
      end if;
      v_new := v_txt::numeric;
      if v_new is distinct from v_row.unit_price then
        insert into cost_changes (request_id, item_id, item_name, field, old_value, new_value, reason, changed_by, changed_by_name)
        values (p_request_id, v_row.id, v_row.item_name, 'unit_price', v_row.unit_price, v_new, v_why, auth.uid(), v_who);
        update request_items set unit_price = v_new where id = v_row.id;
        v_n := v_n + 1;
      end if;
    end if;

    if v_item ? 'shipping_cost' then
      v_txt := regexp_replace(trim(coalesce(v_item ->> 'shipping_cost', '')), '[$,]', '', 'g');
      if v_txt <> '' and v_txt !~ '^\d*\.?\d+$' then
        raise exception '%: shipping must be a number of 0 or more.', v_row.item_name;
      end if;
      v_new := nullif(v_txt, '')::numeric;
      if v_new is distinct from v_row.shipping_cost then
        insert into cost_changes (request_id, item_id, item_name, field, old_value, new_value, reason, changed_by, changed_by_name)
        values (p_request_id, v_row.id, v_row.item_name, 'shipping_cost', v_row.shipping_cost, v_new, v_why, auth.uid(), v_who);
        update request_items set shipping_cost = v_new where id = v_row.id;
        v_n := v_n + 1;
      end if;
    end if;
  end loop;

  if v_n > 0 then update requests set updated_at = now() where id = p_request_id; end if;
  return v_n;
end;
$$;


-- ---------------------------------------------------------------------------
-- Settings: add the built-in Shipping field (after Unit price). If an old
-- custom "Shipping…" item field exists, move its numbers into shipping_cost,
-- keep any other text (e.g. "Free with Prime") in Notes, and drop that field.
-- ---------------------------------------------------------------------------
do $$
declare
  v_form   jsonb;
  v_fields jsonb;
  v_old    jsonb;
  v_key    text;
  v_pos    numeric;
begin
  select value into v_form from public.app_settings where key = 'form';
  if v_form is null then return; end if;
  v_fields := coalesce(v_form -> 'itemFields', '[]');

  select f into v_old from jsonb_array_elements(v_fields) f
  where (f -> 'builtin') is distinct from 'true'::jsonb and f ->> 'label' ilike '%shipping%'
  limit 1;

  if v_old is not null then
    v_key := v_old ->> 'key';
    update public.request_items
       set shipping_cost = regexp_replace(data ->> v_key, '[$,\s]', '', 'g')::numeric
     where shipping_cost is null
       and regexp_replace(coalesce(data ->> v_key, ''), '[$,\s]', '', 'g') ~ '^\d*\.?\d+$';
    update public.request_items
       set notes = trim(both ' ·' from notes || ' · Shipping: ' || trim(data ->> v_key))
     where shipping_cost is null
       and trim(coalesce(data ->> v_key, '')) <> ''
       and lower(trim(data ->> v_key)) not in ('n/a', 'na', 'none', '-', '0');
    v_fields := (select coalesce(jsonb_agg(f order by o), '[]')
                 from jsonb_array_elements(v_fields) with ordinality x(f, o)
                 where f ->> 'key' <> v_key);
  end if;

  if not exists (select 1 from jsonb_array_elements(v_fields) f where f ->> 'key' = 'shipping_cost') then
    v_pos := coalesce((select o from jsonb_array_elements(v_fields) with ordinality x(f, o) where f ->> 'key' = 'unit_price'), 999) + 0.5;
    v_fields := (select jsonb_agg(f order by o) from (
      select f, o::numeric as o from jsonb_array_elements(v_fields) with ordinality x(f, o)
      union all
      select '{"key": "shipping_cost", "label": "Shipping", "type": "number", "builtin": true, "required": false}'::jsonb, v_pos
    ) s);
  end if;

  update public.app_settings set value = jsonb_set(v_form, '{itemFields}', v_fields) where key = 'form';
end;
$$;


revoke execute on function public.update_item_costs(uuid, jsonb, text) from public, anon;
grant execute on function public.update_item_costs(uuid, jsonb, text) to authenticated;

update public.app_settings set value = value || '{"schemaVersion": 4}' where key = 'general';
