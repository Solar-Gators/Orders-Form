-- =============================================================================
-- 022 — A "Paid" status for the ledger
--
--   For payments with nothing to order: a debt, a reimbursement, an invoice paid
--   straight away. Paid counts as spent, like Ordered and Received. It's for
--   purchases added on Finances; requests are still marked Ordered / Received on
--   their own page.
--
-- Run once, after 021: Supabase → SQL Editor → New query → paste → Run.
-- =============================================================================

alter table public.finance_purchases drop constraint if exists finance_purchases_dept_status_check;
alter table public.finance_purchases add constraint finance_purchases_dept_status_check
  check (dept_status in ('to_submit', 'sent', 'dept_approved', 'ordered', 'received', 'paid', 'cancelled'));

-- Same as 020, plus 'paid' (not on rows linked to a request).
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
  if p_fields ? 'dept_status' and p_fields ->> 'dept_status' not in ('to_submit', 'sent', 'dept_approved', 'ordered', 'received', 'paid', 'cancelled') then
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
    if p_fields ->> 'dept_status' = 'paid' then
      raise exception 'Paid is for purchases added on Finances. Mark a request Ordered or Received from its own page.';
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

update app_settings set value = jsonb_set(value, '{schemaVersion}', '22') where key = 'general';
