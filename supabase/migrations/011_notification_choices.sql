-- =============================================================================
-- 011 — Choose notifications per event (My account)
--
-- Each person can turn email / Teams on or off for each kind of message, e.g.
-- keep "needs your approval" but mute "your order arrived".
--   profiles.notify_events: { "<event>": { "email": false, "teams": false } }
--   Anything not listed is on. The overall Email / Teams switches still apply.
--
-- Run once, after 010: Supabase → SQL Editor → New query → paste → Run.
-- =============================================================================

alter table public.profiles add column notify_events jsonb not null default '{}';

create or replace function public.update_my_notification_events(p_events jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_clean jsonb;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if jsonb_typeof(coalesce(p_events, '{}')) <> 'object' then raise exception 'Choices must be a JSON object.'; end if;
  -- Keep only known events and true/false per channel.
  select coalesce(jsonb_object_agg(e.key, jsonb_strip_nulls(jsonb_build_object(
           'email', case when jsonb_typeof(e.value -> 'email') = 'boolean' then e.value -> 'email' end,
           'teams', case when jsonb_typeof(e.value -> 'teams') = 'boolean' then e.value -> 'teams' end))), '{}')
    into v_clean
  from jsonb_each(coalesce(p_events, '{}')) e
  where e.key in ('submitted', 'approved', 'ready_to_order', 'changes_requested', 'rejected', 'ordered', 'received')
    and jsonb_typeof(e.value) = 'object';
  update profiles set notify_events = v_clean where id = auth.uid();
end;
$$;

-- enqueue_notification: same as 010, plus each person's per-event choices.
create or replace function public.enqueue_notification(p_event text, p_request_id uuid, p_recipients uuid[])
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_settings jsonb := (select value from app_settings where key = 'notifications');
  v_ev       jsonb := v_settings -> 'events' -> p_event;
  v_payload  jsonb;
  v_person   profiles;
begin
  if v_settings is null or (v_settings -> 'enabled') is distinct from 'true'::jsonb or v_ev is null then return; end if;
  if (v_ev -> 'email') is distinct from 'true'::jsonb and (v_ev -> 'teams') is distinct from 'true'::jsonb then return; end if;

  select jsonb_build_object(
      'request_number', r.request_number, 'title', r.title, 'requester', r.requester,
      'status', r.status, 'season', r.season, 'total', request_total(r.id),
      'vendor', (select string_agg(distinct nullif(vendor, ''), ', ') from request_items i where i.request_id = r.id),
      'comment', coalesce((select comment from approvals a where a.request_id = r.id order by created_at desc limit 1), ''),
      'approver', coalesce((select approver from approvals a where a.request_id = r.id order by created_at desc limit 1), ''),
      'ticket', coalesce((select department_order_number from order_information o where o.request_id = r.id), ''),
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
revoke execute on function public.update_my_notification_events(jsonb) from public, anon;
grant execute on function public.update_my_notification_events(jsonb) to authenticated;

update public.app_settings set value = value || '{"schemaVersion": 11}' where key = 'general';
