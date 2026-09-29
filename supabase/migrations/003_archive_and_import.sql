-- =============================================================================
-- 003 — Archive of past seasons + importing this season's spreadsheet
--
--   * archive_imports / archive_orders: past order sheets, stored as-is. Every
--     column is kept (in `fields`, by original header); a few common columns
--     are copied out for searching and filtering.
--   * import_archive(): upload one sheet into the archive (leads only).
--   * import_requests(): turn rows from this season's sheet into real
--     requests with approval / order history (leads only).
--
-- Run once, after 002: Supabase → SQL Editor → New query → paste → Run.
-- =============================================================================

create table public.archive_imports (
  id           uuid primary key default gen_random_uuid(),
  season       text not null,
  source_file  text not null default '',
  sheet        text not null default '',
  columns      jsonb not null default '[]',   -- original headers, in order
  row_count    int not null default 0,
  imported_by  uuid references public.profiles(id) on delete set null,
  imported_at  timestamptz not null default now()
);

create table public.archive_orders (
  id          uuid primary key default gen_random_uuid(),
  import_id   uuid not null references public.archive_imports(id) on delete cascade,
  season      text not null,
  row_number  int not null,                   -- row in the original sheet
  fields      jsonb not null,                 -- { "Original header": "value", ... }
  order_date  date,
  requester   text not null default '',
  subteam     text not null default '',
  item        text not null default '',
  status      text not null default '',
  approver    text not null default '',
  ticket      text not null default '',
  cost        numeric
);
create index archive_orders_import_idx on public.archive_orders (import_id);
create index archive_orders_season_idx on public.archive_orders (season);

alter table public.archive_imports enable row level security;
alter table public.archive_orders  enable row level security;
create policy "signed-in read" on public.archive_imports for select to authenticated using (true);
create policy "signed-in read" on public.archive_orders  for select to authenticated using (true);
revoke all on public.archive_imports, public.archive_orders from anon, authenticated;
grant select on public.archive_imports, public.archive_orders to authenticated;


-- Import one sheet into the archive. p_rows: [{ row_number, fields, order_date,
-- requester, subteam, item, status, approver, ticket, cost }]
create or replace function public.import_archive(
  p_season text, p_source_file text, p_sheet text, p_columns jsonb, p_rows jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  perform require_permission('settings.edit');
  if trim(coalesce(p_season, '')) = '' then raise exception 'Season is required.'; end if;
  if coalesce(jsonb_typeof(p_rows), '') <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'There are no rows to import.';
  end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'Too many rows (5000 max per import).'; end if;

  insert into archive_imports (season, source_file, sheet, columns, row_count, imported_by)
  values (trim(p_season), coalesce(p_source_file, ''), coalesce(p_sheet, ''), coalesce(p_columns, '[]'),
          jsonb_array_length(p_rows), auth.uid())
  returning id into v_id;

  insert into archive_orders (import_id, season, row_number, fields, order_date, requester, subteam, item, status, approver, ticket, cost)
  select v_id, trim(p_season),
         coalesce((r ->> 'row_number')::int, 0),
         case when jsonb_typeof(r -> 'fields') = 'object' then r -> 'fields' else '{}' end,
         case when is_valid_date(r ->> 'order_date') then (r ->> 'order_date')::date end,
         left(coalesce(r ->> 'requester', ''), 200), left(coalesce(r ->> 'subteam', ''), 200),
         left(coalesce(r ->> 'item', ''), 500), left(coalesce(r ->> 'status', ''), 200),
         left(coalesce(r ->> 'approver', ''), 200), left(coalesce(r ->> 'ticket', ''), 200),
         case when coalesce(r ->> 'cost', '') ~ '^-?\d*\.?\d+$' then (r ->> 'cost')::numeric end
  from jsonb_array_elements(p_rows) r;

  return v_id;
end;
$$;

create or replace function public.delete_archive_import(p_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('settings.edit');
  delete from archive_imports where id = p_id;
  if not found then raise exception 'Import not found.'; end if;
end;
$$;


-- Create requests from this season's spreadsheet, including their history.
-- p_requests: [{ title, requester, subsystem, priority, justification, date,
--   status, approver, ticket, received_notes, data, items: [{ item_name, vendor,
--   product_link, part_number, quantity, unit_price, notes, data }] }]
-- Returns the number of requests created.
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

    insert into request_items (request_id, position, item_name, vendor, product_link, part_number, quantity, unit_price, notes, data)
    select v_id, (e.ord - 1)::int,
           left(coalesce(e.item ->> 'item_name', ''), 500), left(coalesce(e.item ->> 'vendor', ''), 200),
           coalesce(e.item ->> 'product_link', ''), left(coalesce(e.item ->> 'part_number', ''), 200),
           case when coalesce(e.item ->> 'quantity', '') ~ '^\d*\.?\d+$' then (e.item ->> 'quantity')::numeric end,
           case when coalesce(e.item ->> 'unit_price', '') ~ '^\d*\.?\d+$' then (e.item ->> 'unit_price')::numeric end,
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


revoke execute on function
  public.import_archive(text, text, text, jsonb, jsonb),
  public.delete_archive_import(uuid),
  public.import_requests(jsonb)
from public, anon;
grant execute on function
  public.import_archive(text, text, text, jsonb, jsonb),
  public.delete_archive_import(uuid),
  public.import_requests(jsonb)
to authenticated;

update public.app_settings set value = value || '{"schemaVersion": 3}' where key = 'general';
