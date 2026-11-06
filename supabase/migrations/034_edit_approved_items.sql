-- =============================================================================
-- 034: The Treasurer can change the items on an approved or ordered request
-- =============================================================================
-- Run once, after 033: Supabase → SQL Editor → New query → paste → Run.
-- Then redeploy the send-notifications Edge Function (for the new message).
--
--   For when the supplier is out of stock: remove items, change quantities,
--   swap a part (name, part number, link, price, shipping, notes) or add a
--   substitute. Treasurer only ("Order & receive"). A reason is required.
--
--   * Every change is listed in the History (old → new) with the reason, and
--     the requester is told ("Items changed" in Admin → Notifications).
--   * If the total goes UP and that crosses into a different approval rule
--     (Admin → Workflow), or puts the request over its budget, an Approved
--     request goes back to Submitted for the new rule's approvers. An Ordered
--     one can't be raised that far here: put the extra on a new request.
--     Lower totals, and increases within the same rule, just save.
--   * Items that already arrived can't be removed (mark them not arrived first).
--     The vendor stays the request's vendor (one vendor per request).
-- =============================================================================

alter table public.request_events drop constraint if exists request_events_kind_check;
alter table public.request_events add constraint request_events_kind_check
  check (kind in ('submitted', 'resubmitted', 'withdrawn', 'ordered', 'received', 'edited', 'cancelled', 'restored',
                  'arrived', 'unreceived', 'items_edited'));

/** "$1,234.50" */
create or replace function public.fmt_money(p numeric)
returns text
language sql immutable set search_path = public, pg_temp
as $$
  select case when p is null then '—' else '$' || trim(to_char(p, 'FM999,999,990.00')) end;
$$;

/**
 * p_items: the whole list of items after the edit, in order:
 *   [{ id (existing items; leave out for a new one), item_name, part_number,
 *      product_link, quantity, unit_price, shipping_cost, notes }]
 * Existing items left out of the list are removed.
 * Returns { changes, reapproval, total }.
 */
create or replace function public.edit_request_items(p_id uuid, p_items jsonb, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_req      requests;
  v_why      text := trim(coalesce(p_reason, ''));
  v_old      numeric;
  v_new      numeric;
  v_vendor   text;
  v_item     jsonb;
  v_row      request_items;
  v_keep     uuid[] := '{}';
  v_changes  text[] := '{}';
  v_pos      int := 0;
  v_name     text;
  v_qty      numeric;
  v_price    numeric;
  v_ship     numeric;
  v_txt      text;
  v_plan     jsonb;
  v_reapprove boolean := false;
  v_diff     text[];
begin
  perform require_permission('request.order');
  select * into v_req from requests where id = p_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if v_req.status not in ('Approved', 'Ordered') then
    raise exception '% is "%", not Approved or Ordered.', v_req.request_number, v_req.status;
  end if;
  if v_why = '' then raise exception 'Say why the items changed (e.g. "Out of stock; McMaster suggested 91251A540").'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Keep at least one item. To drop everything, cancel the request instead.';
  end if;

  v_old := request_total(p_id);
  select coalesce(max(nullif(vendor, '')), '') into v_vendor from request_items where request_id = p_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_pos := v_pos + 1;
    v_name := left(trim(coalesce(v_item ->> 'item_name', '')), 300);
    if v_name = '' then raise exception 'Item % needs a name.', v_pos; end if;

    v_txt := regexp_replace(trim(coalesce(v_item ->> 'quantity', '')), '[,]', '', 'g');
    if v_txt !~ '^\d*\.?\d+$' or v_txt::numeric <= 0 then raise exception '%: quantity must be more than 0.', v_name; end if;
    v_qty := v_txt::numeric;
    v_txt := regexp_replace(trim(coalesce(v_item ->> 'unit_price', '')), '[$,]', '', 'g');
    if v_txt !~ '^\d*\.?\d+$' then raise exception '%: unit price must be a number of 0 or more.', v_name; end if;
    v_price := v_txt::numeric;
    v_txt := regexp_replace(trim(coalesce(v_item ->> 'shipping_cost', '')), '[$,]', '', 'g');
    if v_txt <> '' and v_txt !~ '^\d*\.?\d+$' then raise exception '%: shipping must be a number of 0 or more.', v_name; end if;
    v_ship := nullif(v_txt, '')::numeric;

    if coalesce(v_item ->> 'id', '') <> '' then
      select * into v_row from request_items where id = (v_item ->> 'id')::uuid and request_id = p_id for update;
      if not found then raise exception 'That item is not on %.', v_req.request_number; end if;
      v_keep := v_keep || v_row.id;
      v_diff := array_remove(array[
        case when v_row.item_name is distinct from v_name then format('name "%s" → "%s"', v_row.item_name, v_name) end,
        case when v_row.part_number is distinct from left(trim(coalesce(v_item ->> 'part_number', '')), 200)
             then format('part # "%s" → "%s"', v_row.part_number, left(trim(coalesce(v_item ->> 'part_number', '')), 200)) end,
        case when v_row.product_link is distinct from left(trim(coalesce(v_item ->> 'product_link', '')), 2000) then 'link changed' end,
        case when v_row.quantity is distinct from v_qty then format('quantity %s → %s', coalesce(v_row.quantity::text, '—'), v_qty) end,
        case when v_row.unit_price is distinct from v_price then format('unit price %s → %s', fmt_money(v_row.unit_price), fmt_money(v_price)) end,
        case when v_row.shipping_cost is distinct from v_ship then format('shipping %s → %s', fmt_money(v_row.shipping_cost), fmt_money(v_ship)) end,
        case when v_row.notes is distinct from left(trim(coalesce(v_item ->> 'notes', '')), 2000) then 'notes changed' end
      ], null);
      if cardinality(v_diff) > 0 then
        v_changes := v_changes || format('%s: %s', v_row.item_name, array_to_string(v_diff, ', '));
      end if;
      update request_items set
        position = v_pos, item_name = v_name,
        part_number = left(trim(coalesce(v_item ->> 'part_number', '')), 200),
        product_link = left(trim(coalesce(v_item ->> 'product_link', '')), 2000),
        quantity = v_qty, unit_price = v_price, shipping_cost = v_ship,
        notes = left(trim(coalesce(v_item ->> 'notes', '')), 2000)
      where id = v_row.id;
    else
      insert into request_items (request_id, position, item_name, vendor, part_number, product_link, quantity, unit_price, shipping_cost, notes)
      values (p_id, v_pos, v_name, v_vendor, left(trim(coalesce(v_item ->> 'part_number', '')), 200),
              left(trim(coalesce(v_item ->> 'product_link', '')), 2000), v_qty, v_price, v_ship, left(trim(coalesce(v_item ->> 'notes', '')), 2000))
      returning * into v_row;
      v_keep := v_keep || v_row.id;
      v_changes := v_changes || format('Added %s × %s at %s', v_qty, v_name, fmt_money(v_price));
    end if;
  end loop;

  -- Removed items
  if exists (select 1 from request_items where request_id = p_id and not (id = any(v_keep)) and arrived_on is not null) then
    raise exception '% has already arrived. Mark it not arrived before removing it.',
      (select item_name from request_items where request_id = p_id and not (id = any(v_keep)) and arrived_on is not null limit 1);
  end if;
  select v_changes || coalesce(array_agg(format('Removed %s × %s', coalesce(quantity::text, '—'), item_name) order by position), '{}')
    into v_changes from request_items where request_id = p_id and not (id = any(v_keep));
  delete from request_items where request_id = p_id and not (id = any(v_keep));

  if cardinality(v_changes) = 0 then
    return jsonb_build_object('changes', 0, 'reapproval', false, 'total', v_old);
  end if;
  v_new := request_total(p_id);

  -- More money: does it now need someone else's approval, or break the budget?
  if v_new > v_old then
    v_plan := compute_approval_plan(p_id);
    v_reapprove := (v_plan ->> 'type' <> 'auto' and (v_plan ->> 'rule') is distinct from (v_req.approval_plan ->> 'rule'))
                   or budget_problem(p_id) is not null;
    if v_reapprove and v_req.status = 'Ordered' then
      raise exception 'That raises % from % to %, which needs approval again (%). It''s already ordered, so put the extra on a new request instead.',
        v_req.request_number, fmt_money(v_old), fmt_money(v_new),
        coalesce(budget_problem(p_id), format('the "%s" rule', coalesce(v_plan ->> 'rule', 'Any Chief Engineer')));
    end if;
  end if;

  insert into request_events (request_id, kind, actor_id, actor_name, changes, note)
  values (p_id, 'items_edited', auth.uid(), my_display_name(),
          v_changes || format('Total %s → %s', fmt_money(v_old), fmt_money(v_new)), v_why);

  if v_reapprove then
    update requests set status = 'Submitted', approval_plan = v_plan, updated_at = now() where id = p_id;
    perform enqueue_notification('submitted', p_id, plan_approvers(v_plan));
  else
    update requests set updated_at = now() where id = p_id;
  end if;
  perform enqueue_notification('items_changed', p_id, array[v_req.created_by]);
  return jsonb_build_object('changes', cardinality(v_changes), 'reapproval', v_reapprove, 'total', v_new);
end;
$$;
revoke execute on function public.edit_request_items(uuid, jsonb, text) from public, anon;
grant execute on function public.edit_request_items(uuid, jsonb, text) to authenticated;
revoke execute on function public.fmt_money(numeric) from public, anon;


-- Message details: same as 024, plus "Items changed": {comment} is why, {approver} who changed them.
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
  v_edit     request_events;
begin
  if v_settings is null or (v_settings -> 'enabled') is distinct from 'true'::jsonb or v_ev is null then return; end if;
  if (v_ev -> 'email') is distinct from 'true'::jsonb and (v_ev -> 'teams') is distinct from 'true'::jsonb then return; end if;

  select * into v_cancel from request_events
  where request_id = p_request_id and kind = 'cancelled' order by id desc limit 1;
  if p_event = 'items_changed' then
    select * into v_edit from request_events
    where request_id = p_request_id and kind = 'items_edited' order by id desc limit 1;
  end if;

  select jsonb_build_object(
      'request_number', r.request_number, 'title', r.title, 'requester', r.requester,
      'status', r.status, 'season', r.season, 'total', request_total(r.id),
      'vendor', (select string_agg(distinct nullif(vendor, ''), ', ') from request_items i where i.request_id = r.id),
      'comment', case when v_edit.id is not null then v_edit.note
                      when r.status = 'Cancelled' then coalesce(v_cancel.note, '')
                      else coalesce((select comment from approvals a where a.request_id = r.id order by created_at desc limit 1), '') end,
      'approver', case when v_edit.id is not null then v_edit.actor_name
                       when r.status = 'Cancelled' then coalesce(v_cancel.actor_name, '')
                       else coalesce((select approver from approvals a where a.request_id = r.id order by created_at desc limit 1), '') end,
      'changes', case when v_edit.id is not null then array_to_string(v_edit.changes, chr(10)) else '' end,
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

-- "Items changed" is on by default once notifications are turned on (Admin → Notifications).
update public.app_settings
set value = jsonb_set(
  jsonb_set(value, '{events,items_changed}', coalesce(value -> 'events' -> 'items_changed', '{"email": true, "teams": true}'), true),
  '{templates,items_changed}',
  coalesce(value -> 'templates' -> 'items_changed', to_jsonb(json_build_object(
    'subject', '{request_number}: the items changed',
    'body', 'Hi {first_name}, {approver} changed the items on "{title}" (now {total}):' || chr(10) || '{changes}' || chr(10) || 'Why: {comment}'))),
  true)
where key = 'notifications';

update app_settings set value = jsonb_set(value, '{schemaVersion}', '34') where key = 'general';
