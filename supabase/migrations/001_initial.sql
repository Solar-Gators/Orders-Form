-- =============================================================================
-- Solar Gators Orders — Supabase database schema
--
-- Run the files in supabase/migrations/ in order (001, 002, ...) on a new
-- Supabase project. This first one creates everything:
--   Supabase dashboard → SQL Editor → New query → paste → Run.
--
-- Security model
--   * Every signed-in user can READ requests, items, approvals, profiles and
--     settings (the team shares one order sheet).
--   * Nobody writes to tables directly. All changes go through the functions
--     at the bottom of this file (save_request, review_request, ...). Each one
--     checks the caller's permissions and the request's status, so the rules
--     hold even though the website itself is public on GitHub Pages.
--   * Permissions are data (role_permissions table), so changing what a role
--     can do is an UPDATE, not a code change.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- Settings: editable from the website by users with `settings.edit`.
-- `general` is readable before sign-in (team name, allowed email domains).
-- ---------------------------------------------------------------------------
create table public.app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

insert into public.app_settings (key, value) values
('general', '{
  "teamName": "Solar Gators",
  "season": "2026-2027",
  "requestIdPrefix": "SG",
  "allowedEmailDomains": ["ufl.edu"]
}'),
('form', '{
  "subsystems": ["Battery", "Solar Array", "Motor", "Aero", "Chassis", "Suspension", "Cockpit", "Electrical", "Telemetry", "Other"],
  "priorities": ["Normal", "High", "Urgent"],
  "defaultPriority": "Normal"
}');


-- ---------------------------------------------------------------------------
-- Roles and permissions
--   request.review  approve / request changes / reject
--   request.order   mark ordered / received
--   settings.edit   edit team settings and form options
--   users.manage    change other users' roles
-- Everyone signed in can create and submit their own requests.
-- ---------------------------------------------------------------------------
create table public.roles (
  key    text primary key,
  label  text not null,
  sort   int  not null default 0
);

insert into public.roles (key, label, sort) values
  ('member',    'Member',         1),
  ('ce',        'Chief Engineer', 2),
  ('treasurer', 'Treasurer',      3);

create table public.role_permissions (
  role        text not null references public.roles(key) on delete cascade,
  permission  text not null,
  primary key (role, permission)
);

-- Only Chief Engineers approve; only the Treasurer orders. Both are leads
-- who can edit settings and manage roles.
insert into public.role_permissions (role, permission) values
  ('ce',        'request.review'),
  ('ce',        'settings.edit'),
  ('ce',        'users.manage'),
  ('treasurer', 'settings.edit'),
  ('treasurer', 'users.manage'),
  ('treasurer', 'request.order');


-- ---------------------------------------------------------------------------
-- Profiles: one per account, created automatically on sign-up.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text not null default '',
  role        text not null default 'member' references public.roles(key),
  created_at  timestamptz not null default now()
);

create or replace function public.has_permission(p_permission text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from profiles p
    join role_permissions rp on rp.role = p.role
    where p.id = auth.uid() and rp.permission = p_permission
  );
$$;

-- Runs when someone signs up. Enforces the allowed email domains and creates
-- the profile. Raising an error here cancels the sign-up.
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
    where v_domain = lower(d) or v_domain like '%.' || lower(d)   -- allow subdomains, e.g. cise.ufl.edu
  ) then
    raise exception 'Sign-ups are limited to % email addresses.',
      (select string_agg('@' || d, ', ') from jsonb_array_elements_text(v_domains) d);
  end if;

  insert into profiles (id, email, full_name)
  values (new.id, new.email, coalesce(trim(new.raw_user_meta_data ->> 'full_name'), ''));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ---------------------------------------------------------------------------
-- Requests and their items, approvals and order info.
-- `data` jsonb columns hold answers to custom fields added from the website.
-- ---------------------------------------------------------------------------
create sequence public.request_number_seq;

-- e.g. "SG-001". The prefix comes from settings.
create or replace function public.next_request_number()
returns text
language sql volatile security definer set search_path = public, pg_temp
as $$
  select coalesce((select value ->> 'requestIdPrefix' from app_settings where key = 'general'), 'SG')
         || '-' || lpad(nextval('request_number_seq')::text, 3, '0');
$$;

create table public.requests (
  id              uuid primary key default gen_random_uuid(),
  request_number  text not null unique default public.next_request_number(),
  created_by      uuid references public.profiles(id) on delete set null,
  title           text not null default '',
  requester       text not null default '',
  subsystem       text not null default '',
  priority        text not null default '',
  needed_by       date,
  justification   text not null default '',
  status          text not null default 'Draft'
                  check (status in ('Draft', 'Submitted', 'Changes Requested', 'Approved', 'Rejected', 'Ordered', 'Received')),
  data            jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index requests_status_idx on public.requests (status);

create table public.request_items (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references public.requests(id) on delete cascade,
  position      int not null default 0,
  item_name     text not null default '',
  vendor        text not null default '',
  product_link  text not null default '',
  part_number   text not null default '',
  quantity      numeric,
  unit_price    numeric,
  notes         text not null default '',
  data          jsonb not null default '{}'
);
create index request_items_request_idx on public.request_items (request_id);

create table public.approvals (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references public.requests(id) on delete cascade,
  approver_id  uuid references public.profiles(id) on delete set null,
  approver     text not null,                     -- name at the time of the decision
  decision     text not null check (decision in ('approve', 'request_changes', 'reject')),
  comment      text not null default '',
  created_at   timestamptz not null default now()
);
create index approvals_request_idx on public.approvals (request_id);

create table public.order_information (
  request_id               uuid primary key references public.requests(id) on delete cascade,
  order_date               date not null,
  department_order_number  text not null default '',
  treasurer_notes          text not null default '',
  ordered_by               uuid references public.profiles(id) on delete set null,
  received_date            date,
  received_notes           text not null default '',
  received_by              uuid references public.profiles(id) on delete set null
);


-- ---------------------------------------------------------------------------
-- Row-level security: signed-in users read everything; nobody writes directly.
-- ---------------------------------------------------------------------------
alter table public.app_settings      enable row level security;
alter table public.roles             enable row level security;
alter table public.role_permissions  enable row level security;
alter table public.profiles          enable row level security;
alter table public.requests          enable row level security;
alter table public.request_items     enable row level security;
alter table public.approvals         enable row level security;
alter table public.order_information enable row level security;

create policy "signed-in read" on public.app_settings      for select to authenticated using (true);
create policy "public general" on public.app_settings      for select to anon using (key = 'general');
create policy "signed-in read" on public.roles             for select to authenticated using (true);
create policy "signed-in read" on public.role_permissions  for select to authenticated using (true);
create policy "signed-in read" on public.profiles          for select to authenticated using (true);
create policy "signed-in read" on public.requests          for select to authenticated using (true);
create policy "signed-in read" on public.request_items     for select to authenticated using (true);
create policy "signed-in read" on public.approvals         for select to authenticated using (true);
create policy "signed-in read" on public.order_information for select to authenticated using (true);

-- Supabase grants full table access to API roles by default; take writes away.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant select on all tables in schema public to authenticated;
grant select on public.app_settings to anon;


-- =============================================================================
-- Actions (called from the website with supabase.rpc)
-- =============================================================================

create or replace function public.require_permission(p_permission text)
returns void
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;
  if not has_permission(p_permission) then
    raise exception 'Your role does not allow this action (%).', p_permission;
  end if;
end;
$$;

create or replace function public.my_display_name()
returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(nullif(full_name, ''), email) from profiles where id = auth.uid();
$$;


-- Create (p_id null) or update a request. p_action: 'draft' | 'submit'.
-- Drafts need only a title; submissions must be complete.
-- Returns the request number.
create or replace function public.save_request(p_id uuid, p_request jsonb, p_items jsonb, p_action text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_submit    boolean := p_action = 'submit';
  v_form      jsonb;
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
  v_items     jsonb := '[]';
  v_item      jsonb;
  v_n         int := 0;
  v_qty_txt   text;
  v_price_txt text;
  v_label     text;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if p_action not in ('draft', 'submit') then raise exception 'action must be draft or submit'; end if;

  select value into v_form from app_settings where key = 'form';
  if v_priority = '' then v_priority := coalesce(v_form ->> 'defaultPriority', ''); end if;

  -- Request fields
  if v_title = '' then v_errors := array_append(v_errors, 'Request title is required.'); end if;
  if v_subsystem <> '' and not (v_form -> 'subsystems') ? v_subsystem then
    v_errors := array_append(v_errors, format('Unknown subsystem "%s".', v_subsystem));
  end if;
  if v_priority <> '' and not (v_form -> 'priorities') ? v_priority then
    v_errors := array_append(v_errors, format('Unknown priority "%s".', v_priority));
  end if;
  if v_needed <> '' then
    begin
      if v_needed !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'bad date'; end if;
      v_needed_by := v_needed::date;
    exception when others then
      v_errors := array_append(v_errors, 'Needed-by date must be a valid date.');
    end;
  end if;
  if v_submit then
    if v_requester = '' then v_errors := array_append(v_errors, 'Requester name is required.'); end if;
    if v_subsystem = '' then v_errors := array_append(v_errors, 'Subsystem is required.'); end if;
    if v_needed = ''    then v_errors := array_append(v_errors, 'Needed-by date is required.'); end if;
    if v_just = ''      then v_errors := array_append(v_errors, 'Justification is required.'); end if;
  end if;

  -- Items: drop fully blank rows, validate the rest.
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
    v_qty_txt   := regexp_replace(trim(coalesce(v_item ->> 'quantity', '')), '[$,]', '', 'g');
    v_price_txt := regexp_replace(trim(coalesce(v_item ->> 'unit_price', '')), '[$,]', '', 'g');
    continue when trim(coalesce(v_item ->> 'item_name', '')) = '' and trim(coalesce(v_item ->> 'vendor', '')) = ''
              and trim(coalesce(v_item ->> 'product_link', '')) = '' and trim(coalesce(v_item ->> 'part_number', '')) = ''
              and trim(coalesce(v_item ->> 'notes', '')) = '' and v_qty_txt = '' and v_price_txt = '';
    v_n := v_n + 1;
    v_label := 'Item ' || v_n;

    if v_qty_txt <> '' and (v_qty_txt !~ '^\d*\.?\d+$' or v_qty_txt::numeric <= 0) then
      v_errors := array_append(v_errors, v_label || ': quantity must be a positive number.');
      v_qty_txt := '';
    end if;
    if v_price_txt <> '' and v_price_txt !~ '^\d*\.?\d+$' then
      v_errors := array_append(v_errors, v_label || ': unit price must be a number of 0 or more.');
      v_price_txt := '';
    end if;
    if v_submit then
      if trim(coalesce(v_item ->> 'item_name', '')) = '' then v_errors := array_append(v_errors, v_label || ': item name is required.'); end if;
      if trim(coalesce(v_item ->> 'vendor', '')) = ''    then v_errors := array_append(v_errors, v_label || ': vendor is required.'); end if;
      if v_qty_txt = ''   then v_errors := array_append(v_errors, v_label || ': quantity is required.'); end if;
      if v_price_txt = '' then v_errors := array_append(v_errors, v_label || ': unit price is required.'); end if;
    end if;

    v_items := v_items || jsonb_build_object(
      'item_name',    trim(coalesce(v_item ->> 'item_name', '')),
      'vendor',       trim(coalesce(v_item ->> 'vendor', '')),
      'product_link', trim(coalesce(v_item ->> 'product_link', '')),
      'part_number',  trim(coalesce(v_item ->> 'part_number', '')),
      'quantity',     nullif(v_qty_txt, ''),
      'unit_price',   nullif(v_price_txt, ''),
      'notes',        trim(coalesce(v_item ->> 'notes', ''))
    );
  end loop;
  if v_submit and v_n = 0 then v_errors := array_append(v_errors, 'Add at least one item.'); end if;

  if cardinality(v_errors) > 0 then
    raise exception using message = 'Please fix the following:', detail = array_to_string(v_errors, E'\n');
  end if;

  if p_id is null then
    insert into requests (created_by, title, requester, subsystem, priority, needed_by, justification, status)
    values (v_uid, v_title, v_requester, v_subsystem, v_priority, v_needed_by, v_just,
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
      needed_by = v_needed_by, justification = v_just,
      status = case when v_submit then 'Submitted' else 'Draft' end,
      updated_at = now()
    where id = p_id;
    delete from request_items where request_id = p_id;
    v_id := p_id;
    v_number := v_existing.request_number;
  end if;

  insert into request_items (request_id, position, item_name, vendor, product_link, part_number, quantity, unit_price, notes)
  select v_id, (e.ord - 1)::int, e.item ->> 'item_name', e.item ->> 'vendor', e.item ->> 'product_link',
         e.item ->> 'part_number', (e.item ->> 'quantity')::numeric, (e.item ->> 'unit_price')::numeric, e.item ->> 'notes'
  from jsonb_array_elements(v_items) with ordinality as e(item, ord);

  return v_number;
end;
$$;


-- Chief Engineer decision on a Submitted request.
create or replace function public.review_request(p_id uuid, p_decision text, p_comment text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_req     requests;
  v_comment text := trim(coalesce(p_comment, ''));
begin
  perform require_permission('request.review');
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

  insert into approvals (request_id, approver_id, approver, decision, comment)
  values (p_id, auth.uid(), my_display_name(), p_decision, v_comment);

  update requests set
    status = case p_decision when 'approve' then 'Approved' when 'reject' then 'Rejected' else 'Changes Requested' end,
    updated_at = now()
  where id = p_id;
end;
$$;


-- Treasurer: Approved -> Ordered.
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

  insert into order_information (request_id, order_date, department_order_number, treasurer_notes, ordered_by)
  values (p_id, coalesce(p_order_date, current_date), trim(coalesce(p_order_number, '')), trim(coalesce(p_notes, '')), auth.uid())
  on conflict (request_id) do update set
    order_date = excluded.order_date,
    department_order_number = excluded.department_order_number,
    treasurer_notes = excluded.treasurer_notes,
    ordered_by = excluded.ordered_by;

  update requests set status = 'Ordered', updated_at = now() where id = p_id;
end;
$$;


-- Treasurer: Ordered -> Received.
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
end;
$$;


-- Update your own name.
create or replace function public.update_my_profile(p_full_name text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if trim(coalesce(p_full_name, '')) = '' then raise exception 'Name is required.'; end if;
  update profiles set full_name = trim(p_full_name) where id = auth.uid();
end;
$$;


-- Change another user's role. You can't change your own (prevents locking
-- the team out by accident).
create or replace function public.set_user_role(p_user_id uuid, p_role text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('users.manage');
  if p_user_id = auth.uid() then
    raise exception 'You can''t change your own role. Ask another lead.';
  end if;
  if not exists (select 1 from roles where key = p_role) then
    raise exception 'Unknown role "%".', p_role;
  end if;
  update profiles set role = p_role where id = p_user_id;
  if not found then raise exception 'User not found.'; end if;
end;
$$;


-- Replace one settings document ('general' or 'form').
create or replace function public.update_settings(p_key text, p_value jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('settings.edit');
  if p_key not in ('general', 'form') then
    raise exception 'Unknown settings key "%".', p_key;
  end if;
  if jsonb_typeof(p_value) <> 'object' then
    raise exception 'Settings must be a JSON object.';
  end if;
  if p_key = 'form' and (jsonb_typeof(p_value -> 'subsystems') <> 'array' or jsonb_array_length(p_value -> 'subsystems') = 0) then
    raise exception 'At least one subsystem is required.';
  end if;
  if p_key = 'form' and (jsonb_typeof(p_value -> 'priorities') <> 'array' or jsonb_array_length(p_value -> 'priorities') = 0) then
    raise exception 'At least one priority is required.';
  end if;

  insert into app_settings (key, value, updated_at, updated_by)
  values (p_key, p_value, now(), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid();
end;
$$;


-- Only the action functions are callable from the website, and only when signed in.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.save_request(uuid, jsonb, jsonb, text),
  public.review_request(uuid, text, text),
  public.mark_ordered(uuid, date, text, text),
  public.mark_received(uuid, date, text),
  public.update_my_profile(text),
  public.set_user_role(uuid, text),
  public.update_settings(text, jsonb)
to authenticated;
