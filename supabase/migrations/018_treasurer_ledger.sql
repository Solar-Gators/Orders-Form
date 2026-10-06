-- =============================================================================
-- 018: The Treasurer's ledger, the way the Treasurer works.
--
--   * finance_purchases: the purchasing steps after a request is approved here:
--     to submit → request sent to MAE / ECE purchasing → department approved →
--     ordered → received (or cancelled), plus which department (M / E / other)
--     and notes. Two kinds of row:
--       - linked to a request (request_id): only those Treasurer extras are kept
--         here; the description, cost, category and order # come from the request;
--       - on its own: something bought outside the site (a PayPal invoice, a quote
--         over the phone, last summer's orders), with its own details.
--   * finance_funds: where the money comes from (allocation, donations, ECE…),
--     expected and received, per season.
--   * finance_seasons: the rainy-day fund balance and the Treasurer's notes.
--   * Budgets: purchases on their own now count toward a category's budget,
--     including the "over budget" check when approving.
--
-- Run once, after 017: Supabase → SQL Editor → New query → paste → Run.
-- =============================================================================

create table public.finance_purchases (
  id            uuid primary key default gen_random_uuid(),
  season        text not null default '',
  request_id    uuid unique references public.requests(id) on delete cascade,
  description   text not null default '',
  amount        numeric(12, 2),
  category      text not null default '',
  dept          text not null default '',          -- M (MAE), E (ECE), or anything else
  dept_status   text not null default 'to_submit'
                check (dept_status in ('to_submit', 'sent', 'dept_approved', 'ordered', 'received', 'cancelled')),
  order_number  text not null default '',
  purchased_on  date,
  notes         text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.profiles(id) on delete set null
);
create index finance_purchases_season_idx on public.finance_purchases (season);

create table public.finance_funds (
  id          uuid primary key default gen_random_uuid(),
  season      text not null default '',
  name        text not null check (length(trim(name)) between 1 and 120),
  kind        text not null default '',
  expected    numeric(12, 2),
  received    numeric(12, 2),
  notes       text not null default '',
  position    integer not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id) on delete set null
);
create index finance_funds_season_idx on public.finance_funds (season, position);

create table public.finance_seasons (
  season      text primary key,
  rainy_day   numeric(12, 2),
  notes       text not null default '',
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id) on delete set null
);

alter table public.finance_purchases enable row level security;
alter table public.finance_funds enable row level security;
alter table public.finance_seasons enable row level security;
create policy "finances readers" on public.finance_purchases for select to authenticated using (has_permission('finances.view') or has_permission('finances.edit'));
create policy "finances readers" on public.finance_funds for select to authenticated using (has_permission('finances.view') or has_permission('finances.edit'));
create policy "finances readers" on public.finance_seasons for select to authenticated using (has_permission('finances.view') or has_permission('finances.edit'));
revoke all on public.finance_purchases, public.finance_funds, public.finance_seasons from anon, authenticated;
grant select on public.finance_purchases, public.finance_funds, public.finance_seasons to authenticated;

/**
 * Create (p_id null) or update a purchase. p_fields: any of description, amount, category,
 * dept, dept_status, order_number, purchased_on, notes, season, request_id (when creating).
 * For a row linked to a request only dept, dept_status (not ordered / received: use the
 * request's own buttons) and notes are kept. Returns the row's id.
 */
create or replace function public.save_purchase(p_id uuid, p_fields jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id      uuid := p_id;
  v_row     finance_purchases;
  v_request uuid;
  v_amount  text := nullif(trim(coalesce(p_fields ->> 'amount', '')), '');
begin
  perform require_permission('finances.edit');
  if v_amount is not null and v_amount !~ '^-?\d+(\.\d{1,2})?$' then
    raise exception 'The cost must be a number, like 25 or 25.99.';
  end if;
  if p_fields ? 'dept_status' and p_fields ->> 'dept_status' not in ('to_submit', 'sent', 'dept_approved', 'ordered', 'received', 'cancelled') then
    raise exception 'Unknown status.';
  end if;

  if v_id is null then
    v_request := nullif(p_fields ->> 'request_id', '')::uuid;
    if v_request is not null then
      -- One row per request: reuse it if it exists.
      select id into v_id from finance_purchases where request_id = v_request;
      if v_id is null then
        insert into finance_purchases (request_id, season, updated_by)
        values (v_request, (select season from requests where id = v_request), auth.uid())
        returning id into v_id;
      end if;
    else
      insert into finance_purchases (season, updated_by)
      values (coalesce(nullif(p_fields ->> 'season', ''), (select value ->> 'season' from app_settings where key = 'general'), ''), auth.uid())
      returning id into v_id;
    end if;
  end if;

  select * into v_row from finance_purchases where id = v_id;
  if not found then raise exception 'That purchase was deleted by someone else. Reload the page.'; end if;

  if v_row.request_id is not null then
    if p_fields ->> 'dept_status' in ('ordered', 'received') then
      raise exception 'Mark the request Ordered or Received from its own page (it records the date and ticket number).';
    end if;
    update finance_purchases set
      dept        = case when p_fields ? 'dept' then left(trim(p_fields ->> 'dept'), 20) else dept end,
      dept_status = case when p_fields ? 'dept_status' then p_fields ->> 'dept_status' else dept_status end,
      notes       = case when p_fields ? 'notes' then left(p_fields ->> 'notes', 2000) else notes end,
      updated_at  = now(), updated_by = auth.uid()
    where id = v_id;
  else
    update finance_purchases set
      description  = case when p_fields ? 'description' then left(trim(p_fields ->> 'description'), 300) else description end,
      amount       = case when p_fields ? 'amount' then v_amount::numeric else amount end,
      category     = case when p_fields ? 'category' then left(trim(p_fields ->> 'category'), 80) else category end,
      dept         = case when p_fields ? 'dept' then left(trim(p_fields ->> 'dept'), 20) else dept end,
      dept_status  = case when p_fields ? 'dept_status' then p_fields ->> 'dept_status' else dept_status end,
      order_number = case when p_fields ? 'order_number' then left(trim(p_fields ->> 'order_number'), 60) else order_number end,
      purchased_on = case when p_fields ? 'purchased_on' then nullif(p_fields ->> 'purchased_on', '')::date else purchased_on end,
      notes        = case when p_fields ? 'notes' then left(p_fields ->> 'notes', 2000) else notes end,
      season       = case when p_fields ? 'season' and p_fields ->> 'season' <> '' then p_fields ->> 'season' else season end,
      updated_at   = now(), updated_by = auth.uid()
    where id = v_id;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_purchase(p_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('finances.edit');
  if exists (select 1 from finance_purchases where id = p_id and request_id is not null) then
    raise exception 'This line comes from a request. Open the request to change it.';
  end if;
  delete from finance_purchases where id = p_id;
end;
$$;

/** Create (p_id null) or update a funding source. p_fields: name, kind, expected, received, notes, season, position. */
create or replace function public.save_fund(p_id uuid, p_fields jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id uuid := p_id;
  v_exp text := nullif(trim(coalesce(p_fields ->> 'expected', '')), '');
  v_rec text := nullif(trim(coalesce(p_fields ->> 'received', '')), '');
begin
  perform require_permission('finances.edit');
  if (v_exp is not null and v_exp !~ '^-?\d+(\.\d{1,2})?$') or (v_rec is not null and v_rec !~ '^-?\d+(\.\d{1,2})?$') then
    raise exception 'Amounts must be numbers, like 24000 or 24000.50.';
  end if;
  if v_id is null then
    insert into finance_funds (season, name, position, updated_by)
    values (coalesce(nullif(p_fields ->> 'season', ''), (select value ->> 'season' from app_settings where key = 'general'), ''),
            coalesce(nullif(trim(p_fields ->> 'name'), ''), 'New source'),
            (select coalesce(max(position), 0) + 1 from finance_funds), auth.uid())
    returning id into v_id;
  end if;
  update finance_funds set
    name     = case when p_fields ? 'name' then coalesce(nullif(trim(p_fields ->> 'name'), ''), name) else name end,
    kind     = case when p_fields ? 'kind' then left(trim(p_fields ->> 'kind'), 40) else kind end,
    expected = case when p_fields ? 'expected' then v_exp::numeric else expected end,
    received = case when p_fields ? 'received' then v_rec::numeric else received end,
    notes    = case when p_fields ? 'notes' then left(p_fields ->> 'notes', 2000) else notes end,
    updated_at = now(), updated_by = auth.uid()
  where id = v_id;
  if not found then raise exception 'That funding source was deleted by someone else.'; end if;
  return v_id;
end;
$$;

create or replace function public.delete_fund(p_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('finances.edit');
  delete from finance_funds where id = p_id;
end;
$$;

/** The season's rainy-day fund balance and the Treasurer's notes. Leave a key out to keep it. */
create or replace function public.save_finance_season(p_season text, p_fields jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_rainy text := nullif(trim(coalesce(p_fields ->> 'rainy_day', '')), '');
begin
  perform require_permission('finances.edit');
  if v_rainy is not null and v_rainy !~ '^-?\d+(\.\d{1,2})?$' then raise exception 'The rainy-day balance must be a number.'; end if;
  insert into finance_seasons (season, updated_by) values (p_season, auth.uid()) on conflict (season) do nothing;
  update finance_seasons set
    rainy_day = case when p_fields ? 'rainy_day' then v_rainy::numeric else rainy_day end,
    notes     = case when p_fields ? 'notes' then left(p_fields ->> 'notes', 20000) else notes end,
    updated_at = now(), updated_by = auth.uid()
  where season = p_season;
end;
$$;

revoke execute on function public.save_purchase(uuid, jsonb), public.delete_purchase(uuid), public.save_fund(uuid, jsonb),
  public.delete_fund(uuid), public.save_finance_season(text, jsonb) from public, anon;
grant execute on function public.save_purchase(uuid, jsonb), public.delete_purchase(uuid), public.save_fund(uuid, jsonb),
  public.delete_fund(uuid), public.save_finance_season(text, jsonb) to authenticated;


-- ---------------------------------------------------------------------------
-- Budgets: purchases logged on their own count too (same as 010, plus them).
-- ---------------------------------------------------------------------------
create or replace function public.budget_problem(p_request_id uuid)
returns text
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_b      jsonb := (select value -> 'budgets' from app_settings where key = 'workflow');
  v_req    jsonb := (select to_jsonb(r) from requests r where r.id = p_request_id);
  v_field  text := v_b ->> 'field';
  v_value  text;
  v_amount numeric;
  v_used   numeric;
  v_this   numeric := request_total(p_request_id);
begin
  if v_b is null or coalesce(v_field, '') = '' or (v_b -> 'block') is distinct from 'true'::jsonb then return null; end if;
  v_value := form_value(v_req, v_field);
  if v_value = '' or coalesce(v_b -> 'amounts' ->> v_value, '') !~ '^\d*\.?\d+$' then return null; end if;
  v_amount := (v_b -> 'amounts' ->> v_value)::numeric;
  select coalesce(sum(request_total(r.id)), 0) into v_used
  from requests r
  where r.id <> p_request_id and r.season = (v_req ->> 'season') and r.status in ('Approved', 'Ordered', 'Received')
    and form_value(to_jsonb(r), v_field) = v_value;
  v_used := v_used + coalesce((
    select sum(amount) from finance_purchases
    where request_id is null and dept_status <> 'cancelled' and season = (v_req ->> 'season')
      and lower(trim(category)) = lower(trim(v_value))), 0);
  if v_used + v_this > v_amount then
    return format('Approving this would put %s over its budget: $%s used + $%s = $%s of $%s.',
      v_value, to_char(v_used, 'FM999,999,990.00'), to_char(v_this, 'FM999,999,990.00'),
      to_char(v_used + v_this, 'FM999,999,990.00'), to_char(v_amount, 'FM999,999,990.00'));
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Files (017) on purchases logged on their own too: receipts, invoices, quotes.
-- ---------------------------------------------------------------------------
alter table public.attachments add column finance_purchase_id uuid references public.finance_purchases(id) on delete cascade;
create index attachments_purchase_idx on public.attachments (finance_purchase_id) where finance_purchase_id is not null;
do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'public.attachments'::regclass and pg_get_constraintdef(oid) like '%num_nonnulls%' loop
    execute format('alter table public.attachments drop constraint %I', c);
  end loop;
end $$;
alter table public.attachments add constraint attachments_one_owner
  check (num_nonnulls(sponsor_card_id, request_id, finance_row_id, finance_purchase_id) = 1);

create or replace function public.attachment_owner(a attachments)
returns uuid language sql immutable as $$
  select coalesce(a.sponsor_card_id, a.request_id, a.finance_row_id, a.finance_purchase_id);
$$;

create or replace function public.attachment_kind(a attachments)
returns text language sql immutable as $$
  select case when a.sponsor_card_id is not null then 'sponsor' when a.request_id is not null then 'request'
              when a.finance_purchase_id is not null then 'purchase' else 'finance' end;
$$;

create or replace function public.attachment_access(p_kind text, p_owner uuid, p_edit boolean)
returns boolean
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then return false; end if;
  if p_kind = 'sponsor' then
    return has_permission('sponsors.edit') or (not p_edit and has_permission('sponsors.view'));
  elsif p_kind = 'request' then
    return not p_edit
      or has_permission('request.review') or has_permission('request.order')
      or exists (select 1 from requests where id = p_owner and created_by = auth.uid());
  elsif p_kind in ('finance', 'purchase') then
    return has_permission('finances.edit') or (not p_edit and has_permission('finances.view'));
  end if;
  return false;
end;
$$;

drop policy "attachment readers" on public.attachments;
create policy "attachment readers" on public.attachments for select to authenticated
  using (attachment_access(attachment_kind(attachments), attachment_owner(attachments), false));
grant execute on function public.attachment_owner(attachments) to authenticated;

create or replace function public.add_attachment(p_kind text, p_owner uuid, p_path text, p_url text, p_file_name text, p_size bigint, p_mime text, p_label text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_kind not in ('sponsor', 'request', 'finance', 'purchase') then raise exception 'Unknown kind of attachment.'; end if;
  if not attachment_access(p_kind, p_owner, true) then
    raise exception 'You can''t add files here.';
  end if;
  if p_path is not null and p_path not like p_kind || '/' || p_owner || '/%' then
    raise exception 'That file was uploaded to the wrong place.';
  end if;
  if p_url is not null and p_url !~ '^https?://\S+$' then
    raise exception 'Links must start with https://';
  end if;
  insert into attachments (sponsor_card_id, request_id, finance_row_id, finance_purchase_id, path, url, file_name, size, mime, label, uploaded_by, uploaded_by_name)
  values (
    case when p_kind = 'sponsor' then p_owner end,
    case when p_kind = 'request' then p_owner end,
    case when p_kind = 'finance' then p_owner end,
    case when p_kind = 'purchase' then p_owner end,
    p_path, nullif(trim(coalesce(p_url, '')), ''), left(coalesce(p_file_name, ''), 200), p_size, left(coalesce(p_mime, ''), 100),
    left(trim(coalesce(p_label, '')), 120), auth.uid(), coalesce(my_display_name(), ''))
  returning id into v_id;
  if p_kind = 'sponsor' then
    perform log_sponsor_activity(p_owner, 'file', format('Added %s "%s".', case when p_url is null then 'the file' else 'the link' end,
      coalesce(nullif(trim(p_label), ''), nullif(p_file_name, ''), p_url)));
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_attachment(p_id uuid)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_a attachments;
begin
  select * into v_a from attachments where id = p_id;
  if not found then return null; end if;
  if v_a.uploaded_by is distinct from auth.uid() and not attachment_access(attachment_kind(v_a), attachment_owner(v_a), true) then
    raise exception 'You can''t remove this file.';
  end if;
  delete from attachments where id = p_id;
  if v_a.sponsor_card_id is not null then
    perform log_sponsor_activity(v_a.sponsor_card_id, 'file', format('Removed "%s".', coalesce(nullif(v_a.label, ''), nullif(v_a.file_name, ''), v_a.url)));
  end if;
  if v_a.path is not null and not exists (select 1 from attachments where path = v_a.path) then return v_a.path; end if;
  return null;
end;
$$;

create or replace function public.attachment_counts(p_kind text)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(jsonb_object_agg(owner, n), '{}') from (
    select attachment_owner(a) as owner, count(*) as n
    from attachments a
    where attachment_kind(a) = p_kind and attachment_access(p_kind, attachment_owner(a), false)
    group by 1
  ) x;
$$;

do $storage$
begin
  if to_regclass('storage.buckets') is null then return; end if;
  drop policy if exists "attachments: read" on storage.objects;
  execute $p$
    create policy "attachments: read" on storage.objects for select to authenticated using (
      bucket_id = 'attachments' and exists (
        select 1 from public.attachments a where a.path = name
          and public.attachment_access(public.attachment_kind(a), public.attachment_owner(a), false)))
  $p$;
end
$storage$;

update public.app_settings set value = value || '{"schemaVersion": 18}' where key = 'general';
