-- =============================================================================
-- 014: Finances — spreadsheet-like sheets the Treasurer shapes himself.
--
--   * finance_sheets: one per tab (e.g. "Ledger", "Reimbursements"), with its
--     columns as data: [{ key, label, type, options, sum, fill, of }].
--   * finance_rows: the rows; `data` holds one text value per column key.
--     `request_id` links a row to a request ("Add ordered requests").
--   * Permissions: finances.view (open the tab) and finances.edit (change it).
--     Whoever can order (the Treasurer) gets both; Chief Engineers can look.
--   * All writes go through the functions below, so two people editing
--     different cells of the same row don't overwrite each other.
--
-- Run once, after 013: Supabase → SQL Editor → New query → paste → Run.
-- =============================================================================

insert into public.permissions (key, label, description, sort) values
  ('finances.view', 'See finances', 'Open the Finances tab (read only).', 7),
  ('finances.edit', 'Edit finances', 'Add and change sheets, columns and rows on the Finances tab.', 8)
on conflict (key) do nothing;
update public.permissions set sort = 9 where key = 'users.manage';

insert into public.role_permissions (role, permission)
select distinct role, p.key
from public.role_permissions, (values ('finances.view'), ('finances.edit')) as p(key)
where permission = 'request.order'
on conflict do nothing;
insert into public.role_permissions (role, permission)
select distinct role, 'finances.view' from public.role_permissions where permission = 'request.review'
on conflict do nothing;
insert into public.role_permissions (role, permission) values ('admin', 'finances.view'), ('admin', 'finances.edit')
on conflict do nothing;


-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.finance_sheets (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 60),
  position    integer not null default 0,
  columns     jsonb not null default '[]' check (jsonb_typeof(columns) = 'array'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id) on delete set null
);

create table public.finance_rows (
  id          uuid primary key default gen_random_uuid(),
  sheet_id    uuid not null references public.finance_sheets(id) on delete cascade,
  position    double precision not null default 0,
  data        jsonb not null default '{}' check (jsonb_typeof(data) = 'object'),
  request_id  uuid references public.requests(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id) on delete set null
);
create index finance_rows_sheet_idx on public.finance_rows (sheet_id, position);

alter table public.finance_sheets enable row level security;
alter table public.finance_rows enable row level security;
create policy "finances readers" on public.finance_sheets for select to authenticated
  using (has_permission('finances.view') or has_permission('finances.edit'));
create policy "finances readers" on public.finance_rows for select to authenticated
  using (has_permission('finances.view') or has_permission('finances.edit'));
revoke all on public.finance_sheets, public.finance_rows from anon, authenticated;
grant select on public.finance_sheets, public.finance_rows to authenticated;


-- ---------------------------------------------------------------------------
-- Writes (Edit finances)
-- ---------------------------------------------------------------------------

/** Create (p_id null) or update a sheet's name, columns and place. Returns its id. */
create or replace function public.save_finance_sheet(p_id uuid, p_name text, p_columns jsonb, p_position integer default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
begin
  perform require_permission('finances.edit');
  if jsonb_typeof(coalesce(p_columns, '[]')) <> 'array' then
    raise exception 'Columns must be a list.';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_columns, '[]')) c where coalesce(c ->> 'key', '') = '' or coalesce(trim(c ->> 'label'), '') = '') then
    raise exception 'Every column needs a name.';
  end if;
  if v_id is null then
    insert into finance_sheets (name, columns, position, updated_by)
    values (trim(p_name), coalesce(p_columns, '[]'), coalesce(p_position, (select coalesce(max(position), -1) + 1 from finance_sheets)), auth.uid())
    returning id into v_id;
  else
    update finance_sheets set
      name = trim(p_name), columns = coalesce(p_columns, columns), position = coalesce(p_position, position),
      updated_at = now(), updated_by = auth.uid()
    where id = v_id;
    if not found then raise exception 'That sheet no longer exists.'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_finance_sheet(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform require_permission('finances.edit');
  delete from finance_sheets where id = p_id;
end;
$$;

/**
 * Add rows to the end of a sheet: p_rows = [{ data: {...}, request_id? }].
 * Returns the new rows (as a JSON list) in order.
 */
create or replace function public.add_finance_rows(p_sheet uuid, p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_start double precision;
  v_out jsonb;
begin
  perform require_permission('finances.edit');
  if not exists (select 1 from finance_sheets where id = p_sheet) then
    raise exception 'That sheet no longer exists.';
  end if;
  if jsonb_typeof(coalesce(p_rows, '[]')) <> 'array' or jsonb_array_length(coalesce(p_rows, '[]')) > 5000 then
    raise exception 'Add up to 5,000 rows at a time.';
  end if;
  select coalesce(max(position), 0) into v_start from finance_rows where sheet_id = p_sheet;
  with added as (
    insert into finance_rows (sheet_id, position, data, request_id, updated_by)
    select p_sheet, v_start + r.n, coalesce(r.value -> 'data', '{}'), nullif(r.value ->> 'request_id', '')::uuid, auth.uid()
    from jsonb_array_elements(coalesce(p_rows, '[]')) with ordinality as r(value, n)
    where jsonb_typeof(coalesce(r.value -> 'data', '{}')) = 'object'
    returning *
  )
  select coalesce(jsonb_agg(to_jsonb(added) order by position), '[]') into v_out from added;
  return v_out;
end;
$$;

/** Set one cell. An empty value clears it. */
create or replace function public.set_finance_cell(p_row uuid, p_key text, p_value text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform require_permission('finances.edit');
  if coalesce(p_key, '') = '' then raise exception 'Which column?'; end if;
  update finance_rows set
    data = case when coalesce(p_value, '') = '' then data - p_key else data || jsonb_build_object(p_key, left(p_value, 5000)) end,
    updated_at = now(), updated_by = auth.uid()
  where id = p_row;
  if not found then raise exception 'That row was deleted by someone else. Reload the page.'; end if;
end;
$$;

/** Put a row between two others (rows are ordered by position). */
create or replace function public.move_finance_row(p_row uuid, p_position double precision)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform require_permission('finances.edit');
  update finance_rows set position = p_position, updated_at = now(), updated_by = auth.uid() where id = p_row;
end;
$$;

create or replace function public.delete_finance_rows(p_ids uuid[])
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform require_permission('finances.edit');
  delete from finance_rows where id = any(p_ids);
end;
$$;

revoke execute on function
  public.save_finance_sheet(uuid, text, jsonb, integer), public.delete_finance_sheet(uuid),
  public.add_finance_rows(uuid, jsonb), public.set_finance_cell(uuid, text, text),
  public.move_finance_row(uuid, double precision), public.delete_finance_rows(uuid[])
from public, anon;
grant execute on function
  public.save_finance_sheet(uuid, text, jsonb, integer), public.delete_finance_sheet(uuid),
  public.add_finance_rows(uuid, jsonb), public.set_finance_cell(uuid, text, text),
  public.move_finance_row(uuid, double precision), public.delete_finance_rows(uuid[])
to authenticated;


-- ---------------------------------------------------------------------------
-- A starting sheet the Treasurer can rename, reshape or delete.
-- ---------------------------------------------------------------------------
insert into public.finance_sheets (name, position, columns) values ('Ledger', 0, '[
  {"key": "f_date", "label": "Date", "type": "date", "fill": "order_date"},
  {"key": "f_request", "label": "Request", "type": "request", "fill": "request"},
  {"key": "f_description", "label": "Description", "type": "text", "fill": "title"},
  {"key": "f_vendor", "label": "Vendor", "type": "text", "fill": "vendor"},
  {"key": "f_ticket", "label": "Ticket #", "type": "text", "fill": "ticket"},
  {"key": "f_paid_with", "label": "Paid with", "type": "select", "options": ["Department PO", "P-card", "Reimbursement", "Other"]},
  {"key": "f_amount", "label": "Amount", "type": "money", "sum": true, "fill": "total"},
  {"key": "f_balance", "label": "Running total", "type": "running", "of": "f_amount"},
  {"key": "f_reconciled", "label": "Reconciled", "type": "checkbox"},
  {"key": "f_notes", "label": "Notes", "type": "text"}
]');

update public.app_settings set value = value || '{"schemaVersion": 14}' where key = 'general';
