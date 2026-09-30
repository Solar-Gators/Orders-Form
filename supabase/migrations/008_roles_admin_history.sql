-- =============================================================================
-- 008 — Multiple roles, Admin, finer permissions, settings history
--
--   * A person can have several roles (e.g. Treasurer + Admin); their
--     permissions combine. New built-in role: Admin (everything).
--   * Roles can be created, renamed and deleted from the website.
--   * Finer permissions: "Customize lists & appearance" and "Seasons &
--     imports" split out of "Edit form & settings".
--   * Settings history: every change to settings or permissions is kept as a
--     version that can be restored from Admin → History.
--   * New settings documents: `lists` (columns, filters, default sort) and
--     `appearance` (status/priority labels and colors).
--
-- Run once, after 007: Supabase → SQL Editor → New query → paste → Run.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
update public.permissions set label = 'Edit form & settings', sort = 3,
  description = 'Form fields, dropdown lists, team settings and request rules.' where key = 'settings.edit';
update public.permissions set label = 'Manage people & roles', sort = 6,
  description = 'Give people roles, create roles, and choose what each role can do.' where key = 'users.manage';
insert into public.permissions (key, label, description, sort) values
  ('site.customize', 'Customize lists & appearance', 'Choose list columns, filters and sorting; status and priority labels and colors.', 4),
  ('seasons.manage', 'Seasons & imports', 'Start a new season and import old spreadsheets.', 5);

-- Nobody loses anything: whoever could edit settings keeps seasons & imports.
insert into public.role_permissions (role, permission)
select role, 'seasons.manage' from public.role_permissions where permission = 'settings.edit'
on conflict do nothing;


-- ---------------------------------------------------------------------------
-- Roles: Admin + several roles per person
-- ---------------------------------------------------------------------------
insert into public.roles (key, label, sort) values ('admin', 'Admin', 4) on conflict (key) do nothing;
insert into public.role_permissions (role, permission)
select 'admin', key from public.permissions on conflict do nothing;

create table public.profile_roles (
  user_id  uuid not null references public.profiles(id) on delete cascade,
  role     text not null references public.roles(key) on delete cascade,
  primary key (user_id, role)
);
insert into public.profile_roles (user_id, role) select id, role from public.profiles;

alter table public.profile_roles enable row level security;
create policy "signed-in read" on public.profile_roles for select to authenticated using (true);
revoke all on public.profile_roles from anon, authenticated;
grant select on public.profile_roles to authenticated;

create or replace function public.has_permission(p_permission text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from profile_roles pr
    join role_permissions rp on rp.role = pr.role
    where pr.user_id = auth.uid() and rp.permission = p_permission
  );
$$;

create or replace function public.assert_someone_can_manage_users()
returns void
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from profile_roles pr join role_permissions rp on rp.role = pr.role
    where rp.permission = 'users.manage'
  ) then
    raise exception 'At least one person must keep the "Manage people & roles" permission, or nobody could change roles again.';
  end if;
end;
$$;

-- New accounts start as Member.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_domains jsonb;
  v_domain  text := lower(split_part(new.email, '@', 2));
begin
  select value -> 'allowedEmailDomains' into v_domains from app_settings where key = 'general';

  if v_domains is not null and jsonb_array_length(v_domains) > 0 and not exists (
    select 1 from jsonb_array_elements_text(v_domains) d
    where v_domain = lower(d) or v_domain like '%.' || lower(d)
  ) then
    raise exception 'Sign-ups are limited to % email addresses.',
      (select string_agg('@' || d, ', ') from jsonb_array_elements_text(v_domains) d);
  end if;

  insert into profiles (id, email, full_name)
  values (new.id, new.email, coalesce(trim(new.raw_user_meta_data ->> 'full_name'), ''));
  insert into profile_roles (user_id, role) values (new.id, 'member');
  return new;
end;
$$;

-- Give someone exactly these roles (empty = Member). You can change your own.
create or replace function public.set_user_roles(p_user_id uuid, p_roles text[])
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_roles   text[] := coalesce(p_roles, '{}');
  v_unknown text;
begin
  perform require_permission('users.manage');
  if not exists (select 1 from profiles where id = p_user_id) then raise exception 'User not found.'; end if;
  select r into v_unknown from unnest(v_roles) r where r not in (select key from roles) limit 1;
  if v_unknown is not null then raise exception 'Unknown role "%".', v_unknown; end if;
  if cardinality(v_roles) = 0 then v_roles := array['member']; end if;

  delete from profile_roles where user_id = p_user_id;
  insert into profile_roles (user_id, role) select distinct p_user_id, r from unnest(v_roles) r;
  perform assert_someone_can_manage_users();
end;
$$;

-- Older single-role call, kept for compatibility: sets exactly one role.
create or replace function public.set_user_role(p_user_id uuid, p_role text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform set_user_roles(p_user_id, array[p_role]);
end;
$$;

-- Custom roles (e.g. "Subsystem Lead", "Faculty Advisor"). Returns the new key.
create or replace function public.create_role(p_label text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_label text := trim(coalesce(p_label, ''));
  v_base  text;
  v_key   text;
  v_n     int := 1;
begin
  perform require_permission('users.manage');
  if v_label = '' then raise exception 'Give the role a name.'; end if;
  if exists (select 1 from roles where lower(label) = lower(v_label)) then
    raise exception 'There is already a role called "%".', v_label;
  end if;
  v_base := left(coalesce(nullif(trim(both '_' from regexp_replace(lower(v_label), '[^a-z0-9]+', '_', 'g')), ''), 'role'), 30);
  v_key := v_base;
  while exists (select 1 from roles where key = v_key) loop
    v_n := v_n + 1;
    v_key := v_base || '_' || v_n;
  end loop;
  insert into roles (key, label, sort) values (v_key, v_label, (select coalesce(max(sort), 0) + 1 from roles));
  perform record_permissions_snapshot();
  return v_key;
end;
$$;

create or replace function public.rename_role(p_key text, p_label text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_label text := trim(coalesce(p_label, ''));
begin
  perform require_permission('users.manage');
  if v_label = '' then raise exception 'Give the role a name.'; end if;
  if exists (select 1 from roles where lower(label) = lower(v_label) and key <> p_key) then
    raise exception 'There is already a role called "%".', v_label;
  end if;
  update roles set label = v_label where key = p_key;
  if not found then raise exception 'Unknown role "%".', p_key; end if;
end;
$$;

-- Built-in roles can't be deleted. People left with no role become Members.
create or replace function public.delete_role(p_key text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('users.manage');
  if p_key in ('member', 'ce', 'treasurer', 'admin') then
    raise exception 'Built-in roles can''t be deleted.';
  end if;
  delete from roles where key = p_key;
  if not found then raise exception 'Unknown role "%".', p_key; end if;
  insert into profile_roles (user_id, role)
  select p.id, 'member' from profiles p
  where not exists (select 1 from profile_roles pr where pr.user_id = p.id);
  perform assert_someone_can_manage_users();
  perform record_permissions_snapshot();
end;
$$;


-- ---------------------------------------------------------------------------
-- Settings history: every version of every settings document (and of the
-- permission grid) is kept, so changes can be undone from the website.
-- ---------------------------------------------------------------------------
-- Lists and appearance start empty (= the built-in defaults), so even their
-- first change has a version to go back to.
insert into public.app_settings (key, value) values ('lists', '{}'), ('appearance', '{}')
on conflict (key) do nothing;

create table public.settings_history (
  id               bigserial primary key,
  key              text not null,          -- 'general' | 'form' | 'lists' | 'appearance' | 'permissions'
  value            jsonb not null,
  changed_by       uuid references public.profiles(id) on delete set null,
  changed_by_name  text not null default '',
  changed_at       timestamptz not null default now(),
  note             text not null default ''
);
create index settings_history_key_idx on public.settings_history (key, id desc);

alter table public.settings_history enable row level security;
create policy "signed-in read" on public.settings_history for select to authenticated using (true);
revoke all on public.settings_history from anon, authenticated;
grant select on public.settings_history to authenticated;

create or replace function public.record_settings_version()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.value = old.value then return new; end if;
  insert into settings_history (key, value, changed_by, changed_by_name)
  values (new.key, new.value, auth.uid(), coalesce(my_display_name(), 'Database update'));
  return new;
end;
$$;
create trigger app_settings_history
  after insert or update on public.app_settings
  for each row execute function public.record_settings_version();

-- The permission grid as { role: [permissions] } — used for history and restore.
create or replace function public.permission_matrix()
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(jsonb_object_agg(r.key, coalesce(
    (select jsonb_agg(rp.permission order by rp.permission) from role_permissions rp where rp.role = r.key), '[]')), '{}')
  from roles r;
$$;

create or replace function public.record_permissions_snapshot()
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_now  jsonb := permission_matrix();
  v_last jsonb := (select value from settings_history where key = 'permissions' order by id desc limit 1);
begin
  if v_last is distinct from v_now then
    insert into settings_history (key, value, changed_by, changed_by_name)
    values ('permissions', v_now, auth.uid(), coalesce(my_display_name(), 'Database update'));
  end if;
end;
$$;

-- Starting point, so the first change can be undone too.
insert into public.settings_history (key, value, changed_by_name, note)
select key, value, 'Before history started', 'Starting point' from public.app_settings;
insert into public.settings_history (key, value, changed_by_name, note)
values ('permissions', public.permission_matrix(), 'Before history started', 'Starting point');

-- Put a saved version back. Uses the same checks as a normal save.
create or replace function public.restore_settings_version(p_id bigint)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_row    settings_history;
  v_before bigint := (select coalesce(max(id), 0) from settings_history);
begin
  select * into v_row from settings_history where id = p_id;
  if not found then raise exception 'That version no longer exists.'; end if;
  if v_row.key = 'permissions' then
    -- Only roles that still exist; roles created since then keep their permissions.
    perform set_permission_matrix(
      (select coalesce(jsonb_object_agg(k, v), '{}') from jsonb_each(v_row.value) e(k, v) where k in (select key from roles)));
  else
    perform update_settings(v_row.key, v_row.value);
  end if;
  -- Label the new version (if anything actually changed).
  update settings_history
     set note = format('Restored the version from %s', to_char(v_row.changed_at at time zone 'America/New_York', 'Mon DD, YYYY HH12:MI AM'))
   where id = (select max(id) from settings_history where key = v_row.key) and id > v_before;
end;
$$;


-- ---------------------------------------------------------------------------
-- update_settings: which permission each settings document needs.
--   general, form        → settings.edit   (Edit form & settings)
--   lists, appearance    → site.customize  (Customize lists & appearance)
-- The season (and its prefix) still only change via start_new_season.
-- ---------------------------------------------------------------------------
create or replace function public.update_settings(p_key text, p_value jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_locked jsonb;
begin
  if p_key in ('general', 'form') then
    perform require_permission('settings.edit');
  elsif p_key in ('lists', 'appearance') then
    perform require_permission('site.customize');
  else
    raise exception 'Unknown settings key "%".', p_key;
  end if;
  if jsonb_typeof(p_value) <> 'object' then
    raise exception 'Settings must be a JSON object.';
  end if;

  if p_key = 'form' then
    if coalesce(jsonb_typeof(p_value -> 'subsystems'), '') <> 'array' or jsonb_array_length(p_value -> 'subsystems') = 0 then
      raise exception 'At least one subsystem is required.';
    end if;
    if coalesce(jsonb_typeof(p_value -> 'priorities'), '') <> 'array' or jsonb_array_length(p_value -> 'priorities') = 0 then
      raise exception 'At least one priority is required.';
    end if;
    perform validate_form_fields(p_value -> 'requestFields', 'request');
    perform validate_form_fields(p_value -> 'itemFields', 'item');
  end if;

  if p_key = 'general' then
    select coalesce(jsonb_object_agg(k, value -> k), '{}') into v_locked
    from app_settings, unnest(array['schemaVersion', 'season', 'seasonPrefix']) k
    where key = 'general' and value ? k;
    p_value := (p_value - 'schemaVersion' - 'season' - 'seasonPrefix') || v_locked;
  end if;

  insert into app_settings (key, value, updated_at, updated_by)
  values (p_key, p_value, now(), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid();
end;
$$;


-- ---------------------------------------------------------------------------
-- Seasons & imports: same as before, now checking "seasons.manage".
-- ---------------------------------------------------------------------------
create or replace function public.import_archive(
  p_season text, p_source_file text, p_sheet text, p_columns jsonb, p_rows jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  perform require_permission('seasons.manage');
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
  perform require_permission('seasons.manage');
  delete from archive_imports where id = p_id;
  if not found then raise exception 'Import not found.'; end if;
end;
$$;

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
  perform require_permission('seasons.manage');
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

create or replace function public.start_new_season(p_season text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_general jsonb;
  v_current text;
  v_new     text := trim(coalesce(p_season, ''));
  v_start   int;
  v_prefix  text;
begin
  perform require_permission('seasons.manage');
  if v_new !~ '^\d{4}-\d{4}$' or split_part(v_new, '-', 2)::int <> split_part(v_new, '-', 1)::int + 1 then
    raise exception 'Enter the season as YYYY-YYYY, e.g. 2027-2028.';
  end if;

  select value into v_general from app_settings where key = 'general' for update;
  v_current := coalesce(v_general ->> 'season', '');
  if v_current ~ '^\d{4}-\d{4}$' and split_part(v_new, '-', 1)::int <= split_part(v_current, '-', 1)::int then
    raise exception 'The new season must come after the current one (%).', v_current;
  end if;
  if exists (select 1 from requests where season = v_new) then
    raise exception 'There are already requests in %.', v_new;
  end if;

  v_start := split_part(v_new, '-', 1)::int;
  v_prefix := coalesce(nullif(v_general ->> 'requestIdPrefix', ''), 'SG') || right(v_start::text, 2);

  update app_settings
     set value = v_general || jsonb_build_object('season', v_new, 'seasonPrefix', v_prefix),
         updated_at = now(), updated_by = auth.uid()
   where key = 'general';
  insert into request_counters (season, last) values (v_new, 0) on conflict (season) do nothing;
  return v_prefix;
end;
$$;


-- ---------------------------------------------------------------------------
-- Permission grid saves: same as 005, now also recorded in the settings history.
-- ---------------------------------------------------------------------------
create or replace function public.set_role_permissions(p_role text, p_permissions text[])
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_unknown text;
begin
  perform require_permission('users.manage');
  if not exists (select 1 from roles where key = p_role) then
    raise exception 'Unknown role "%".', p_role;
  end if;
  select p into v_unknown from unnest(coalesce(p_permissions, '{}')) p
  where p not in (select key from permissions) limit 1;
  if v_unknown is not null then
    raise exception 'Unknown permission "%".', v_unknown;
  end if;

  delete from role_permissions where role = p_role;
  insert into role_permissions (role, permission)
  select distinct p_role, p from unnest(coalesce(p_permissions, '{}')) p;

  perform assert_someone_can_manage_users();
  perform record_permissions_snapshot();
end;
$$;

create or replace function public.set_permission_matrix(p_matrix jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_role  text;
  v_perms jsonb;
  v_unknown text;
begin
  perform require_permission('users.manage');
  if coalesce(jsonb_typeof(p_matrix), '') <> 'object' then raise exception 'Nothing to save.'; end if;

  for v_role, v_perms in select * from jsonb_each(p_matrix) loop
    if not exists (select 1 from roles where key = v_role) then raise exception 'Unknown role "%".', v_role; end if;
    if coalesce(jsonb_typeof(v_perms), '') <> 'array' then raise exception 'Permissions for "%" must be a list.', v_role; end if;
    select p into v_unknown from jsonb_array_elements_text(v_perms) p where p not in (select key from permissions) limit 1;
    if v_unknown is not null then raise exception 'Unknown permission "%".', v_unknown; end if;

    delete from role_permissions where role = v_role;
    insert into role_permissions (role, permission)
    select distinct v_role, p from jsonb_array_elements_text(v_perms) p;
  end loop;

  perform assert_someone_can_manage_users();
  perform record_permissions_snapshot();
end;
$$;

-- The old single-role column is replaced by profile_roles.
alter table public.profiles drop column role;


revoke execute on function
  public.record_settings_version(),
  public.permission_matrix(),
  public.record_permissions_snapshot()
from public, anon, authenticated;
revoke execute on function
  public.set_user_roles(uuid, text[]),
  public.create_role(text),
  public.rename_role(text, text),
  public.delete_role(text),
  public.restore_settings_version(bigint)
from public, anon;
grant execute on function
  public.set_user_roles(uuid, text[]),
  public.create_role(text),
  public.rename_role(text, text),
  public.delete_role(text),
  public.restore_settings_version(bigint)
to authenticated;

update public.app_settings set value = value || '{"schemaVersion": 8}' where key = 'general';
