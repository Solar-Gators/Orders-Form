-- =============================================================================
-- 020 — Changing which budget category a request counts toward
--
--   A request's category on Finances comes from its answer to the dropdown budgets
--   follow (e.g. Subsystem). When that dropdown changes (say, to Cost center), older
--   requests answered the old one. The Treasurer can now set the category of any
--   request's ledger line; blank goes back to the request's own answer. The budget
--   check when approving uses the same category.
--
-- Run once, after 019: Supabase → SQL Editor → New query → paste → Run.
-- =============================================================================

/**
 * Same as 018, except that a row linked to a request also keeps a category: the
 * budget category it counts toward instead of the request's own answer ('' = the answer).
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
      category    = case when p_fields ? 'category' then left(trim(p_fields ->> 'category'), 80) else category end,
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

-- The budget category a request counts toward: the Treasurer's choice, else its answer.
create or replace function public.request_category(p_request_id uuid, p_field text)
returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(
    nullif(trim((select category from finance_purchases where request_id = p_request_id)), ''),
    form_value((select to_jsonb(r) from requests r where r.id = p_request_id), p_field));
$$;
revoke execute on function public.request_category(uuid, text) from public, anon;
grant execute on function public.request_category(uuid, text) to authenticated;

-- Same as 018, going by request_category.
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
  v_value := request_category(p_request_id, v_field);
  if v_value = '' or coalesce(v_b -> 'amounts' ->> v_value, '') !~ '^\d*\.?\d+$' then return null; end if;
  v_amount := (v_b -> 'amounts' ->> v_value)::numeric;
  select coalesce(sum(request_total(r.id)), 0) into v_used
  from requests r
  where r.id <> p_request_id and r.season = (v_req ->> 'season') and r.status in ('Approved', 'Ordered', 'Received')
    and lower(trim(request_category(r.id, v_field))) = lower(trim(v_value));
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

update app_settings set value = jsonb_set(value, '{schemaVersion}', '20') where key = 'general';
