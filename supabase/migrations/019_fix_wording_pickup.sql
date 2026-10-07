-- =============================================================================
-- 019 — Fixing wording after submitting; picking up your own delivery
--
--   * fix_request_wording: once a request is submitted, its requester (or a
--     Chief Engineer / Treasurer) can still fix typos: the title, the
--     justification, other text answers, and item names and notes. Nothing that
--     changes the order (vendor, links, part numbers, quantities, prices,
--     dropdowns, dates), and no field an approval rule, the budgets or a
--     "show only when" condition looks at. Every fix is kept in the History.
--   * mark_received: the requester can mark their own order received (they
--     picked it up from the receiving room). A note saying where is now required
--     from everyone: where it was picked up, or where the Treasurer left it.
--     The "has arrived" message includes it as {where} and {received_by}.
--
-- Run once, after 018: Supabase → SQL Editor → New query → paste → Run.
-- Then redeploy the send-notifications Edge Function (for {where} / {received_by}).
-- =============================================================================

alter table public.request_events drop constraint if exists request_events_kind_check;
alter table public.request_events add constraint request_events_kind_check
  check (kind in ('submitted', 'resubmitted', 'withdrawn', 'ordered', 'received', 'edited'));


-- Request fields whose wording can be fixed after submitting: shown text answers
-- that nothing else depends on.
create or replace function public.wording_field_keys()
returns text[]
language sql stable security definer set search_path = public, pg_temp
as $$
  with form as (select value as v from app_settings where key = 'form'),
       wf as (select value as v from app_settings where key = 'workflow'),
       used as (
         -- approval rules and budgets
         select r -> 'when' ->> 'field' as k from wf, jsonb_array_elements(coalesce(wf.v -> 'rules', '[]')) r
         union select wf.v -> 'budgets' ->> 'field' from wf
         -- "show only when" conditions on any field
         union select f -> 'showIf' ->> 'field' from form,
           jsonb_array_elements(coalesce(form.v -> 'requestFields', '[]') || coalesce(form.v -> 'itemFields', '[]')) f
       )
  select coalesce(array_agg(f ->> 'key'), '{}')
  from form, jsonb_array_elements(coalesce(form.v -> 'requestFields', '[]')) f
  where f ->> 'type' in ('text', 'textarea')
    and f ->> 'key' <> 'requester'
    and (f -> 'hidden') is distinct from 'true'::jsonb
    and f ->> 'key' not in (select k from used where k is not null and k <> '');
$$;
revoke execute on function public.wording_field_keys() from public, anon;
grant execute on function public.wording_field_keys() to authenticated;


-- p_request: { key: new text } for request fields; p_items: [{ id, item_name?, notes? }].
-- Returns how many things changed (0 = nothing to save).
create or replace function public.fix_request_wording(p_id uuid, p_request jsonb, p_items jsonb)
returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_req     requests;
  v_rf      jsonb := coalesce((select value -> 'requestFields' from app_settings where key = 'form'), '[]');
  v_if      jsonb := coalesce((select value -> 'itemFields' from app_settings where key = 'form'), '[]');
  v_keys    text[] := wording_field_keys();
  v_changes text[] := '{}';
  v_data    jsonb;
  v_field   jsonb;
  v_key     text;
  v_label   text;
  v_old     text;
  v_new     text;
  v_item    jsonb;
  v_row     request_items;
  v_n       int;
  v_k       text;
begin
  select * into v_req from requests where id = p_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if v_req.created_by is distinct from auth.uid() and not has_permission('request.review') and not has_permission('request.order') then
    raise exception 'Only the person who made this request, a Chief Engineer or the Treasurer can fix its wording.';
  end if;
  if v_req.status in ('Draft', 'Changes Requested') then
    raise exception '% can still be edited in full: use Edit request.', v_req.request_number;
  end if;
  v_data := coalesce(v_req.data, '{}');

  for v_field in select * from jsonb_array_elements(v_rf) loop
    v_key := v_field ->> 'key';
    continue when not (v_key = any(v_keys)) or p_request is null or not (p_request ? v_key);
    v_label := coalesce(nullif(v_field ->> 'label', ''), v_key);
    v_new := trim(coalesce(p_request ->> v_key, ''));
    v_old := case v_key when 'title' then coalesce(v_req.title, '')
                        when 'justification' then coalesce(v_req.justification, '')
                        else coalesce(v_data ->> v_key, '') end;
    continue when v_new = v_old;
    if v_new = '' and (v_key = 'title' or (v_field -> 'required') = 'true'::jsonb) then
      raise exception '% can''t be empty.', v_label;
    end if;
    if (v_field ->> 'maxLength') ~ '^\d+$' and length(v_new) > (v_field ->> 'maxLength')::int then
      raise exception '% can be at most % characters.', v_label, v_field ->> 'maxLength';
    end if;
    if v_key = 'title' then
      update requests set title = v_new where id = p_id;
    elsif v_key = 'justification' then
      update requests set justification = v_new where id = p_id;
    else
      v_data := jsonb_set(v_data, array[v_key], to_jsonb(v_new));
    end if;
    v_changes := array_append(v_changes, format('%s: "%s" → "%s"', v_label, left(v_old, 120), left(v_new, 120)));
  end loop;
  update requests set data = v_data where id = p_id and data is distinct from v_data;

  -- Items: their name and notes only.
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
    select * into v_row from request_items where id = (v_item ->> 'id')::uuid and request_id = p_id;
    continue when not found;
    select count(*) + 1 into v_n from request_items
      where request_id = p_id and (position, id::text) < (v_row.position, v_row.id::text);
    foreach v_k in array array['item_name', 'notes'] loop
      continue when not (v_item ? v_k);
      v_new := trim(coalesce(v_item ->> v_k, ''));
      v_old := case v_k when 'item_name' then v_row.item_name else v_row.notes end;
      continue when v_new = v_old;
      v_label := coalesce((select nullif(f ->> 'label', '') from jsonb_array_elements(v_if) f where f ->> 'key' = v_k),
                          case v_k when 'item_name' then 'Item name' else 'Notes' end);
      if v_k = 'item_name' and v_new = '' then raise exception 'Item %: % can''t be empty.', v_n, v_label; end if;
      if v_k = 'item_name' then
        update request_items set item_name = v_new where id = v_row.id;
      else
        update request_items set notes = v_new where id = v_row.id;
      end if;
      v_changes := array_append(v_changes, format('Item %s %s: "%s" → "%s"', v_n, case v_k when 'item_name' then 'name' else lower(v_label) end, left(v_old, 120), left(v_new, 120)));
    end loop;
  end loop;

  if cardinality(v_changes) = 0 then return 0; end if;
  update requests set updated_at = now() where id = p_id;
  insert into request_events (request_id, kind, actor_id, actor_name, changes)
  values (p_id, 'edited', auth.uid(), my_display_name(), v_changes);
  return cardinality(v_changes);
end;
$$;
revoke execute on function public.fix_request_wording(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.fix_request_wording(uuid, jsonb, jsonb) to authenticated;


-- Received: the Treasurer, or the requester who picked it up. Saying where is required.
create or replace function public.mark_received(p_id uuid, p_received_date date, p_notes text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_req  requests;
  v_note text := trim(coalesce(p_notes, ''));
begin
  select * into v_req from requests where id = p_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if not has_permission('request.order') and v_req.created_by is distinct from auth.uid() then
    raise exception 'Only the Treasurer or the person who requested it can mark it received.';
  end if;
  if v_req.status <> 'Ordered' then
    raise exception '% is "%", not Ordered.', v_req.request_number, v_req.status;
  end if;
  if v_note = '' then
    raise exception 'Say where it is: where you picked it up, or where you left it (e.g. "in our office").';
  end if;
  if p_received_date > current_date then
    raise exception 'The received date can''t be in the future.';
  end if;

  update order_information set
    received_date = coalesce(p_received_date, current_date),
    received_notes = v_note,
    received_by = auth.uid()
  where request_id = p_id;

  update requests set status = 'Received', updated_at = now() where id = p_id;
  insert into request_events (request_id, kind, actor_id, actor_name) values (p_id, 'received', auth.uid(), my_display_name());
end;
$$;


-- Messages: same as 011, plus {where} and {received_by} for "has arrived".
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

-- The standard "has arrived" message now says where it is (custom wording is left alone).
update app_settings
set value = jsonb_set(value, '{templates,received,body}',
                      to_jsonb('Hi {first_name}, "{title}" was marked received by {received_by}.' || chr(10) || 'Where: {where}'::text))
where key = 'notifications'
  and value #>> '{templates,received,body}' = 'Hi {first_name}, "{title}" was marked received.';

update app_settings set value = jsonb_set(value, '{schemaVersion}', '19') where key = 'general';
