-- =============================================================================
-- 024: The Treasurer can cancel an approved request before ordering it
-- =============================================================================
-- Run once, after 023: Supabase → SQL Editor → New query → paste → Run.
--
--   * New request status "Cancelled": approved, then not ordered after all (the
--     part was found in the shop, the vendor is out of stock, the plan changed).
--     It leaves the To order list, stops counting toward budgets, and shows as
--     Cancelled on Finances.
--   * cancel_request(id, reason): Approved → Cancelled. "Order & receive" only; a
--     reason is required and the requester is sent it ("Cancelled" message).
--   * restore_request(id): Cancelled → Approved, to undo a mistake. No "approved"
--     or "ready to order" messages are sent again.
--   * History records who cancelled / restored it, and why.
--   * Renaming a budget category (Finances) moves cancelled requests' lines too.
-- =============================================================================

alter table public.requests drop constraint if exists requests_status_check;
alter table public.requests add constraint requests_status_check
  check (status in ('Draft', 'Submitted', 'Changes Requested', 'Approved', 'Rejected', 'Ordered', 'Received', 'Cancelled'));

alter table public.request_events drop constraint if exists request_events_kind_check;
alter table public.request_events add constraint request_events_kind_check
  check (kind in ('submitted', 'resubmitted', 'withdrawn', 'ordered', 'received', 'edited', 'cancelled', 'restored'));


create or replace function public.cancel_request(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_req    requests;
  v_reason text := trim(coalesce(p_reason, ''));
begin
  perform require_permission('request.order');
  select * into v_req from requests where id = p_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if v_req.status <> 'Approved' then
    raise exception '% is "%", not Approved.', v_req.request_number, v_req.status;
  end if;
  if v_reason = '' then
    raise exception 'Say why it''s cancelled, so % knows.', coalesce(nullif(v_req.requester, ''), 'the requester');
  end if;
  -- The History entry first: the "Cancelled" message (queued by the status trigger) quotes it.
  insert into request_events (request_id, kind, actor_id, actor_name, note)
  values (p_id, 'cancelled', auth.uid(), my_display_name(), v_reason);
  update requests set status = 'Cancelled', updated_at = now() where id = p_id;
end;
$$;
revoke execute on function public.cancel_request(uuid, text) from public, anon;
grant execute on function public.cancel_request(uuid, text) to authenticated;

create or replace function public.restore_request(p_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_req requests;
begin
  perform require_permission('request.order');
  select * into v_req from requests where id = p_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if v_req.status <> 'Cancelled' then
    raise exception '% is "%", not Cancelled.', v_req.request_number, v_req.status;
  end if;
  insert into request_events (request_id, kind, actor_id, actor_name)
  values (p_id, 'restored', auth.uid(), my_display_name());
  update requests set status = 'Approved', updated_at = now() where id = p_id;
  -- A "Cancelled" message that hasn't gone out yet no longer applies.
  update notification_outbox set status = 'cancelled', error = 'The request was restored before this was sent.'
  where request_id = p_id and event = 'cancelled' and status = 'pending';
end;
$$;
revoke execute on function public.restore_request(uuid) from public, anon;
grant execute on function public.restore_request(uuid) to authenticated;


-- Messages on status changes: same as 010, plus Cancelled → the requester, and no
-- "approved" / "ready to order" again when a cancelled request is restored.
create or replace function public.notify_status_change()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.status is not distinct from old.status then return new; end if;
  case new.status
    when 'Approved' then
      if old.status <> 'Cancelled' then
        perform enqueue_notification('approved', new.id, array[new.created_by]);
        perform enqueue_notification('ready_to_order', new.id, users_with_permission('request.order'));
      end if;
    when 'Changes Requested' then perform enqueue_notification('changes_requested', new.id, array[new.created_by]);
    when 'Rejected' then perform enqueue_notification('rejected', new.id, array[new.created_by]);
    when 'Ordered' then perform enqueue_notification('ordered', new.id, array[new.created_by]);
    when 'Received' then perform enqueue_notification('received', new.id, array[new.created_by]);
    when 'Cancelled' then perform enqueue_notification('cancelled', new.id, array[new.created_by]);
    else null;
  end case;
  return new;
end;
$$;
revoke execute on function public.notify_status_change() from public, anon, authenticated;


-- Message details: same as 019, except a cancelled request's {comment} is why it
-- was cancelled and {approver} who cancelled it (no Edge Function redeploy needed).
create or replace function public.enqueue_notification(p_event text, p_request_id uuid, p_recipients uuid[])
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_settings jsonb := (select value from app_settings where key = 'notifications');
  v_ev       jsonb := v_settings -> 'events' -> p_event;
  v_payload  jsonb;
  v_person   profiles;
  v_cancel   request_events;
begin
  if v_settings is null or (v_settings -> 'enabled') is distinct from 'true'::jsonb or v_ev is null then return; end if;
  if (v_ev -> 'email') is distinct from 'true'::jsonb and (v_ev -> 'teams') is distinct from 'true'::jsonb then return; end if;

  select * into v_cancel from request_events
  where request_id = p_request_id and kind = 'cancelled' order by id desc limit 1;

  select jsonb_build_object(
      'request_number', r.request_number, 'title', r.title, 'requester', r.requester,
      'status', r.status, 'season', r.season, 'total', request_total(r.id),
      'vendor', (select string_agg(distinct nullif(vendor, ''), ', ') from request_items i where i.request_id = r.id),
      'comment', case when r.status = 'Cancelled' then coalesce(v_cancel.note, '')
                      else coalesce((select comment from approvals a where a.request_id = r.id order by created_at desc limit 1), '') end,
      'approver', case when r.status = 'Cancelled' then coalesce(v_cancel.actor_name, '')
                       else coalesce((select approver from approvals a where a.request_id = r.id order by created_at desc limit 1), '') end,
      'ticket', coalesce((select department_order_number from order_information o where o.request_id = r.id), ''),
      'where', coalesce((select received_notes from order_information o where o.request_id = r.id), ''),
      'received_by', coalesce((select p.full_name from order_information o join profiles p on p.id = o.received_by where o.request_id = r.id), ''),
      'rule', coalesce(r.approval_plan ->> 'rule', ''))
    into v_payload
  from requests r where r.id = p_request_id;

  for v_person in
    select * from profiles where id = any(p_recipients) and id is distinct from auth.uid()
  loop
    if (v_ev -> 'email') = 'true'::jsonb and v_person.notify_email
       and (v_person.notify_events -> p_event -> 'email') is distinct from 'false'::jsonb then
      insert into notification_outbox (event, request_id, recipient_id, email, channel, payload)
      values (p_event, p_request_id, v_person.id, v_person.email, 'email', v_payload || jsonb_build_object('recipient_name', v_person.full_name));
    end if;
    if (v_ev -> 'teams') = 'true'::jsonb and v_person.notify_teams
       and (v_person.notify_events -> p_event -> 'teams') is distinct from 'false'::jsonb then
      insert into notification_outbox (event, request_id, recipient_id, email, channel, payload)
      values (p_event, p_request_id, v_person.id, v_person.email, 'teams', v_payload || jsonb_build_object('recipient_name', v_person.full_name));
    end if;
  end loop;
end;
$$;
revoke execute on function public.enqueue_notification(text, uuid, uuid[]) from public, anon, authenticated;


-- Renaming / combining / deleting a budget category: same as 023, and cancelled
-- requests' lines move too (they show on Finances, not counting toward budgets).
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
  -- Also when budgets don't follow a dropdown yet: then only the Treasurer's choice counts.
  begin
    with moved as (
      insert into finance_purchases (request_id, season, category, updated_by)
      select r.id, r.season,
             case when lower(trim(form_value(to_jsonb(r), v_field))) = lower(v_to) then '' else v_to end, auth.uid()
      from requests r
      where r.status in ('Approved', 'Ordered', 'Received', 'Cancelled')
        and lower(trim(request_category(r.id, v_field))) = lower(v_from)
      on conflict (request_id) do update set category = excluded.category, updated_at = now(), updated_by = auth.uid()
      returning 1)
    select count(*) into v_moved from moved;
  end;
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


-- The "Cancelled" message: on (email and Teams) wherever notifications are set up.
update public.app_settings
set value = jsonb_set(value, '{events,cancelled}', '{"email": true, "teams": true}'::jsonb)
where key = 'notifications' and value ? 'events' and not (value -> 'events') ? 'cancelled';

update public.app_settings
set value = jsonb_set(value, '{templates,cancelled}', jsonb_build_object(
  'subject', '{request_number} was cancelled',
  'body', 'Hi {first_name}, "{title}" was approved but cancelled by {approver} before it was ordered.' || chr(10) || 'Why: {comment}'))
where key = 'notifications' and value ? 'templates' and not (value -> 'templates') ? 'cancelled';

update public.app_settings set value = jsonb_set(value, '{schemaVersion}', '24') where key = 'general';
