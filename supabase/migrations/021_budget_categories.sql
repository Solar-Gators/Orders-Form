-- =============================================================================
-- 021 — Renaming, combining and reordering budget categories
--
--   * set_budgets keeps an `order`: the Treasurer's order of the categories on
--     Finances › Budget (budgets.amounts is a JSON object, which has no order).
--   * rename_category(from, to, drop_budget): every purchase in "from" (requests
--     too, in every season) moves to "to", and its budget goes with it. If "to"
--     already exists the two are combined and their budgets added up. Deleting a
--     category is the same move with drop_budget = true: its budget just goes.
--
-- Run once, after 020: Supabase → SQL Editor → New query → paste → Run.
-- =============================================================================

-- Same as 013, plus `order`.
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
    'block', coalesce((p_budgets -> 'block') = 'true'::jsonb, false),
    'order', coalesce((select jsonb_agg(v) from jsonb_array_elements_text(
                         case when jsonb_typeof(p_budgets -> 'order') = 'array' then p_budgets -> 'order' else '[]' end) v
                       where trim(v) <> ''), '[]'));
  insert into app_settings (key, value, updated_at, updated_by)
  values ('workflow', jsonb_build_object('rules', '[]'::jsonb, 'budgets', v_clean), now(), auth.uid())
  on conflict (key) do update set value = app_settings.value || jsonb_build_object('budgets', v_clean), updated_at = now(), updated_by = auth.uid();
end;
$$;

-- Move everything in category p_from to p_to (combining them if p_to exists).
-- Returns how many purchases moved.
create or replace function public.rename_category(p_from text, p_to text, p_drop_budget boolean default false)
returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_from    text := trim(coalesce(p_from, ''));
  v_to      text := trim(coalesce(p_to, ''));
  v_b       jsonb := coalesce((select value -> 'budgets' from app_settings where key = 'workflow'), '{}');
  v_field   text := coalesce(v_b ->> 'field', '');
  v_amounts jsonb := coalesce(v_b -> 'amounts', '{}');
  v_old     numeric;
  v_new     numeric;
  v_key     text;
  v_order   jsonb;
  v_moved   int := 0;
  v_n       int;
begin
  if not (has_permission('request.order') or has_permission('workflow.edit')) then
    raise exception 'Only the Treasurer can change budgets.';
  end if;
  if v_from = '' or v_to = '' then raise exception 'Give the category a name.'; end if;
  if length(v_to) > 80 then raise exception 'Category names can be at most 80 characters.'; end if;

  -- Requests: point their ledger line at the new category ('' when that's their own answer).
  if v_field <> '' then
    with moved as (
      insert into finance_purchases (request_id, season, category, updated_by)
      select r.id, r.season,
             case when lower(trim(form_value(to_jsonb(r), v_field))) = lower(v_to) then '' else v_to end, auth.uid()
      from requests r
      where r.status in ('Approved', 'Ordered', 'Received')
        and lower(trim(request_category(r.id, v_field))) = lower(v_from)
      on conflict (request_id) do update set category = excluded.category, updated_at = now(), updated_by = auth.uid()
      returning 1)
    select count(*) into v_moved from moved;
  end if;
  -- Purchases added on Finances.
  update finance_purchases set category = v_to, updated_at = now(), updated_by = auth.uid()
  where request_id is null and lower(trim(category)) = lower(v_from);
  get diagnostics v_n = row_count;
  v_moved := v_moved + v_n;

  -- Budgets: the old one moves over (added to the new one's if both exist).
  select sum(value::numeric) into v_old from jsonb_each_text(v_amounts) where lower(trim(key)) = lower(v_from);
  select sum(value::numeric) into v_new from jsonb_each_text(v_amounts) where lower(trim(key)) = lower(v_to) and lower(v_to) <> lower(v_from);
  if p_drop_budget then v_old := null; end if;
  for v_key in select key from jsonb_each(v_amounts) where lower(trim(key)) in (lower(v_from), lower(v_to)) loop
    v_amounts := v_amounts - v_key;
  end loop;
  if v_old is not null or v_new is not null then
    v_amounts := v_amounts || jsonb_build_object(v_to, to_char(coalesce(v_old, 0) + coalesce(v_new, 0), 'FM999999990.00'));
  end if;

  -- Order: the new name takes the old one's place (or keeps its own, when combining).
  select coalesce(jsonb_agg(x order by i), '[]') into v_order from (
    select distinct on (lower(x)) x, i from (
      select case when lower(trim(v)) in (lower(v_from), lower(v_to)) then v_to else v end as x, i
      from jsonb_array_elements_text(coalesce(v_b -> 'order', '[]')) with ordinality as t(v, i)) a
    order by lower(x), i) b;

  update app_settings set
    value = jsonb_set(jsonb_set(value, '{budgets,amounts}', v_amounts), '{budgets,order}', v_order),
    updated_at = now(), updated_by = auth.uid()
  where key = 'workflow' and value ? 'budgets';
  return v_moved;
end;
$$;
revoke execute on function public.rename_category(text, text, boolean) from public, anon;
grant execute on function public.rename_category(text, text, boolean) to authenticated;

update app_settings set value = jsonb_set(value, '{schemaVersion}', '21') where key = 'general';
