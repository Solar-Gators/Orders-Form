-- =============================================================================
-- 033: Undo "Mark as Received", keeping the items ticked off one by one
-- =============================================================================
-- Run once, after 032: Supabase → SQL Editor → New query → paste → Run.
--
--   Marking a request Received also marks every item that hadn't arrived yet.
--   Now each item remembers whether it arrived on its own (ticked) or only
--   because the whole request was marked Received. "Undo received" puts the
--   request back to Ordered and un-arrives only the second kind, so the
--   items that were ticked off one by one stay ticked.
--
--   Who can undo: whoever could mark it Received (the Treasurer, or the
--   requester). Nobody is emailed about the undo.
--
--   Requests marked Received before this migration: an item counts as
--   "arrived with the request" if it has the request's received date and
--   person, no note, and no one ticked items on that request that day. If
--   items were ticked the same day the request was marked Received, those
--   requests can't be told apart and their items stay arrived when undone.
-- =============================================================================

alter table public.request_items add column if not exists arrived_with_request boolean not null default false;

-- Best guess for requests already Received (see above).
update public.request_items i set arrived_with_request = true
from public.order_information oi
join public.requests r on r.id = oi.request_id
where i.request_id = oi.request_id and r.status = 'Received'
  and i.arrived_on is not null and i.arrived_on = oi.received_date
  and i.arrived_by is not distinct from oi.received_by and i.arrived_note = ''
  and not exists (
    select 1 from public.request_events e
    where e.request_id = i.request_id and e.kind = 'arrived'
      and (e.created_at at time zone 'America/New_York')::date = oi.received_date
  );

alter table public.request_events drop constraint if exists request_events_kind_check;
alter table public.request_events add constraint request_events_kind_check
  check (kind in ('submitted', 'resubmitted', 'withdrawn', 'ordered', 'received', 'edited', 'cancelled', 'restored', 'arrived', 'unreceived'));


-- Ticking items: same as 025, and a ticked item is its own arrival.
create or replace function public.set_items_arrived(p_request uuid, p_items uuid[], p_arrived boolean, p_date date, p_note text)
returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_req   requests;
  v_n     int;
  v_names text;
begin
  select * into v_req from requests where id = p_request for update;
  if not found then raise exception 'Request not found.'; end if;
  if not has_permission('request.order') and v_req.created_by is distinct from auth.uid() then
    raise exception 'Only the Treasurer or the person who requested it can mark items arrived.';
  end if;
  if v_req.status <> 'Ordered' then
    raise exception '% is "%", not Ordered.', v_req.request_number, v_req.status;
  end if;
  if p_arrived and p_date > current_date then raise exception 'The arrival date can''t be in the future.'; end if;

  if p_arrived then
    update request_items set arrived_on = coalesce(p_date, current_date), arrived_note = left(trim(coalesce(p_note, '')), 500),
                             arrived_by = auth.uid(), arrived_with_request = false
    where request_id = p_request and id = any(coalesce(p_items, '{}'));
  else
    update request_items set arrived_on = null, arrived_note = '', arrived_by = null, arrived_with_request = false
    where request_id = p_request and id = any(coalesce(p_items, '{}'));
  end if;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'Tick the items first.'; end if;

  select string_agg(coalesce(nullif(trim(item_name), ''), 'an item'), ', ' order by position) into v_names
  from (select item_name, position from request_items where request_id = p_request and id = any(p_items) order by position limit 6) x;
  insert into request_events (request_id, kind, actor_id, actor_name, note)
  values (p_request, 'arrived', auth.uid(), my_display_name(),
          case when p_arrived then '' else 'Not arrived after all: ' end || v_names || case when v_n > 6 then format(' and %s more', v_n - 6) else '' end
          || case when p_arrived and trim(coalesce(p_note, '')) <> '' then ' — ' || left(trim(p_note), 500) else '' end);
  return (select count(*) from request_items where request_id = p_request and arrived_on is null);
end;
$$;

-- Received: same as 025, and items that arrive with it are marked as such.
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
  update request_items set arrived_on = coalesce(p_received_date, current_date), arrived_by = auth.uid(), arrived_with_request = true
  where request_id = p_id and arrived_on is null;

  update requests set status = 'Received', updated_at = now() where id = p_id;
  insert into request_events (request_id, kind, actor_id, actor_name) values (p_id, 'received', auth.uid(), my_display_name());
end;
$$;

/** Back to Ordered: only the items that arrived with "Mark as Received" are un-arrived. Returns how many. */
create or replace function public.undo_received(p_id uuid)
returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_req requests;
  v_n   int;
begin
  select * into v_req from requests where id = p_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if not has_permission('request.order') and v_req.created_by is distinct from auth.uid() then
    raise exception 'Only the Treasurer or the person who requested it can undo this.';
  end if;
  if v_req.status <> 'Received' then
    raise exception '% is "%", not Received.', v_req.request_number, v_req.status;
  end if;

  update request_items set arrived_on = null, arrived_by = null, arrived_note = '', arrived_with_request = false
  where request_id = p_id and arrived_with_request;
  get diagnostics v_n = row_count;
  update order_information set received_date = null, received_notes = '', received_by = null where request_id = p_id;

  perform set_config('sg.quiet_status', 'on', true);   -- no "ordered" / "now Ordered" messages for an undo
  update requests set status = 'Ordered', updated_at = now() where id = p_id;
  perform set_config('sg.quiet_status', '', true);
  insert into request_events (request_id, kind, actor_id, actor_name, note)
  values (p_id, 'unreceived', auth.uid(), my_display_name(),
          case when v_n = 0 then '' else format('%s item%s back to not arrived', v_n, case when v_n = 1 then '' else 's' end) end);
  return v_n;
end;
$$;
revoke execute on function public.undo_received(uuid) from public, anon;
grant execute on function public.undo_received(uuid) to authenticated;

-- Status messages: same as 025 / 016, but quiet during an undo.
create or replace function public.notify_status_change()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.status is not distinct from old.status then return new; end if;
  if old.status = 'Cancelled' then return new; end if; -- put back: the requester was told it's cancelled
  if coalesce(current_setting('sg.quiet_status', true), '') = 'on' then return new; end if;
  case new.status
    when 'Approved' then
      perform enqueue_notification('approved', new.id, array[new.created_by]);
      perform enqueue_notification('ready_to_order', new.id, users_with_permission('request.order'));
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

create or replace function public.notify_request_watchers()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_watchers uuid[];
begin
  if new.status is not distinct from old.status or new.status = 'Draft' then return new; end if;
  if coalesce(current_setting('sg.quiet_status', true), '') = 'on' then return new; end if;
  select coalesce(array_agg(user_id), '{}') into v_watchers
  from request_watchers where request_id = new.id and user_id is distinct from new.created_by;
  if cardinality(v_watchers) > 0 then
    perform enqueue_notification('request_update', new.id, v_watchers);
  end if;
  return new;
end;
$$;

update app_settings set value = jsonb_set(value, '{schemaVersion}', '33') where key = 'general';
