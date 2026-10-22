-- =============================================================================
-- 025: Treasurer tools — purchasing steps, cancelling, deleting, items arriving
-- =============================================================================
-- Run once, after 024: Supabase → SQL Editor → New query → paste → Run.
--
--   * Purchasing steps (To submit → Request sent → Dept approved → Ordered …) can
--     be renamed, recolored, hidden, and added to (Finances › Purchases › Edit
--     steps). They live in settings "ledger". A new step counts either as "in the
--     pipeline" or as "spent". The Treasurer (Order & receive) can set a request's
--     step from the request page and the To order list, not only on Finances.
--   * Cancelling also works once a request is Ordered (the order fell through);
--     putting it back returns it to Ordered or Approved, whichever it was.
--     Requests marked "Cancelled" on Finances before 024 (which only changed the
--     ledger, so they stayed in To order) become cancelled requests now.
--   * The Treasurer can delete a request entirely (e.g. an accidental duplicate),
--     saying why. A copy is kept in deleted_requests, in case it was a mistake.
--   * Items can be marked arrived one by one (or all at once) while a request is
--     Ordered, with an optional note; marking the request Received marks the rest.
--   * The Treasurer's notes: per budget category (settings "ledger"), and a
--     request's ledger note can be kept from the request page and To order list.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- Purchasing steps
-- ---------------------------------------------------------------------------
alter table public.finance_purchases drop constraint if exists finance_purchases_dept_status_check;
alter table public.finance_purchases add constraint finance_purchases_dept_status_check
  check (dept_status ~ '^[a-z][a-z0-9_]{0,39}$');

-- Empty = the standard steps (the website fills in their names and colors).
insert into public.app_settings (key, value) values ('ledger', '{}') on conflict (key) do nothing;

/** What a step means: pipeline (committed, not spent), spent, cancelled, or null when there is no such step. */
create or replace function public.ledger_step_kind(p_key text)
returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when p_key in ('to_submit', 'sent', 'dept_approved') then 'pipeline'
    when p_key in ('ordered', 'received', 'paid') then 'spent'
    when p_key = 'cancelled' then 'cancelled'
    else (select case when s ->> 'counts' = 'spent' then 'spent' else 'pipeline' end
          from app_settings, jsonb_array_elements(case when jsonb_typeof(value -> 'steps') = 'array' then value -> 'steps' else '[]' end) s
          where key = 'ledger' and s ->> 'key' = p_key limit 1)
  end
$$;
revoke execute on function public.ledger_step_kind(text) from public, anon;
grant execute on function public.ledger_step_kind(text) to authenticated;

create or replace function public.validate_ledger_settings(p_value jsonb)
returns void
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_builtin text[] := array['to_submit', 'sent', 'dept_approved', 'ordered', 'received', 'paid', 'cancelled'];
  v_steps   jsonb := coalesce(p_value -> 'steps', '[]');
  v_step    jsonb;
  v_keys    text[] := '{}';
  v_key     text;
  v_used    record;
begin
  if jsonb_typeof(v_steps) <> 'array' then raise exception 'Steps must be a list.'; end if;
  if coalesce(jsonb_typeof(p_value -> 'categoryNotes'), 'object') <> 'object' then raise exception 'Category notes must be a list of notes by category.'; end if;
  if jsonb_array_length(v_steps) = 0 then return; end if; -- the standard steps
  for v_step in select * from jsonb_array_elements(v_steps) loop
    v_key := v_step ->> 'key';
    if coalesce(v_key, '') !~ '^[a-z][a-z0-9_]{0,39}$' then raise exception 'Each step needs a key of lowercase letters, like "sent".'; end if;
    if v_key = any(v_keys) then raise exception 'Two steps have the key "%".', v_key; end if;
    if length(trim(coalesce(v_step ->> 'label', ''))) not between 1 and 40 then
      raise exception 'Give every step a name (up to 40 characters).';
    end if;
    if not (v_key = any(v_builtin)) and coalesce(v_step ->> 'counts', 'pipeline') not in ('pipeline', 'spent') then
      raise exception 'Step "%" must count as in the pipeline or as spent.', v_step ->> 'label';
    end if;
    v_keys := v_keys || v_key;
  end loop;
  if not (v_builtin <@ v_keys) then raise exception 'The standard steps can be renamed or hidden, but not removed.'; end if;
  -- A step that's gone can't leave purchases behind.
  select dept_status, count(*) as n into v_used from finance_purchases
  where not (dept_status = any(v_keys)) group by dept_status limit 1;
  if found then
    raise exception '% purchase(s) are at step "%". Move them to another step before removing it.', v_used.n, v_used.dept_status;
  end if;
  -- Requests' lines only use steps before ordering (ordering is recorded on the request).
  select p.dept_status, count(*) as n into v_used
  from finance_purchases p, jsonb_array_elements(v_steps) s
  where p.request_id is not null and s ->> 'key' = p.dept_status and not (p.dept_status = any(v_builtin)) and s ->> 'counts' = 'spent'
  group by p.dept_status limit 1;
  if found then
    raise exception '% request(s) are at step "%", so it has to count as in the pipeline.', v_used.n, v_used.dept_status;
  end if;
end;
$$;
revoke execute on function public.validate_ledger_settings(jsonb) from public, anon, authenticated;

-- Same as 010, plus "ledger" (purchasing steps, category notes) for whoever edits finances.
create or replace function public.update_settings(p_key text, p_value jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_locked jsonb;
begin
  if p_key in ('general', 'form') then
    perform require_permission('settings.edit');
  elsif p_key in ('lists', 'appearance', 'layout', 'exports') then
    perform require_permission('site.customize');
  elsif p_key in ('workflow', 'notifications') then
    perform require_permission('workflow.edit');
  elsif p_key = 'ledger' then
    perform require_permission('finances.edit');
  else
    raise exception 'Unknown settings key "%".', p_key;
  end if;
  if jsonb_typeof(p_value) <> 'object' then
    raise exception 'Settings must be a JSON object.';
  end if;

  if p_key = 'form' then
    if coalesce(jsonb_typeof(p_value -> 'subsystems'), '') <> 'array' or jsonb_array_length(p_value -> 'subsystems') = 0 then
      raise exception 'At least one subsystem is required.';
    end if;
    if coalesce(jsonb_typeof(p_value -> 'priorities'), '') <> 'array' or jsonb_array_length(p_value -> 'priorities') = 0 then
      raise exception 'At least one priority is required.';
    end if;
    perform validate_form_fields(p_value -> 'requestFields', 'request');
    perform validate_form_fields(p_value -> 'itemFields', 'item');
  end if;

  if p_key = 'appearance' and length(coalesce(p_value ->> 'logo', '')) > 400000 then
    raise exception 'The logo is too large. Use an image under 300 KB.';
  end if;
  if p_key = 'appearance' and coalesce(p_value ->> 'accent', '') !~ '^(#[0-9a-fA-F]{6})?$' then
    raise exception 'The accent color must look like #f26b1d.';
  end if;

  if p_key = 'workflow' and coalesce(jsonb_typeof(p_value -> 'rules'), 'array') <> 'array' then
    raise exception 'Workflow rules must be a list.';
  end if;
  if p_key = 'notifications' and coalesce(p_value ->> 'siteUrl', '') !~ '^(https?://\S+)?$' then
    raise exception 'The site address must start with https://';
  end if;
  if p_key = 'ledger' then
    perform validate_ledger_settings(p_value);
  end if;

  if p_key = 'general' then
    select coalesce(jsonb_object_agg(k, value -> k), '{}') into v_locked
    from app_settings, unnest(array['schemaVersion', 'season', 'seasonPrefix']) k
    where key = 'general' and value ? k;
    p_value := (p_value - 'schemaVersion' - 'season' - 'seasonPrefix') || v_locked;
  end if;

  insert into app_settings (key, value, updated_at, updated_by)
  values (p_key, p_value, now(), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid();
end;
$$;

-- Same as 022, except: any step from the settings; on a request's line the
-- Treasurer (Order & receive) can also set the step and note, and the step is one
-- before ordering (ordering, receiving and cancelling are done on the request).
create or replace function public.save_purchase(p_id uuid, p_fields jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id      uuid := p_id;
  v_row     finance_purchases;
  v_request uuid;
  v_amount  text := nullif(trim(coalesce(p_fields ->> 'amount', '')), '');
  v_step    text := p_fields ->> 'dept_status';
begin
  if not has_permission('finances.edit') and not has_permission('request.order') then
    raise exception 'Your role does not allow this action (finances.edit).';
  end if;
  if v_amount is not null and v_amount !~ '^-?\d+(\.\d{1,2})?$' then
    raise exception 'The cost must be a number, like 25 or 25.99.';
  end if;
  if p_fields ? 'dept_status' and ledger_step_kind(v_step) is null then
    raise exception 'Unknown status.';
  end if;

  if v_id is null then
    v_request := nullif(p_fields ->> 'request_id', '')::uuid;
    if v_request is not null then
      -- One row per request: reuse it if it exists.
      select id into v_id from finance_purchases where request_id = v_request;
      if v_id is null then
        if not exists (select 1 from requests where id = v_request) then raise exception 'Request not found.'; end if;
        insert into finance_purchases (request_id, season, updated_by)
        values (v_request, (select season from requests where id = v_request), auth.uid())
        returning id into v_id;
      end if;
    else
      perform require_permission('finances.edit');
      insert into finance_purchases (season, updated_by)
      values (coalesce(nullif(p_fields ->> 'season', ''), (select value ->> 'season' from app_settings where key = 'general'), ''), auth.uid())
      returning id into v_id;
    end if;
  end if;

  select * into v_row from finance_purchases where id = v_id;
  if not found then raise exception 'That purchase was deleted by someone else. Reload the page.'; end if;

  if v_row.request_id is not null then
    if v_step = 'cancelled' then
      raise exception 'Cancel the request itself instead (it asks why and tells the requester).';
    end if;
    if v_step = 'paid' then
      raise exception 'Paid is for purchases added on Finances. Mark a request Ordered or Received from its own page.';
    end if;
    if p_fields ? 'dept_status' and ledger_step_kind(v_step) <> 'pipeline' then
      raise exception 'Mark the request Ordered or Received from its own page (it records the date and ticket number).';
    end if;
    update finance_purchases set
      category    = case when p_fields ? 'category' then left(trim(p_fields ->> 'category'), 80) else category end,
      dept        = case when p_fields ? 'dept' then left(trim(p_fields ->> 'dept'), 20) else dept end,
      dept_status = case when p_fields ? 'dept_status' then v_step else dept_status end,
      notes       = case when p_fields ? 'notes' then left(p_fields ->> 'notes', 2000) else notes end,
      updated_at  = now(), updated_by = auth.uid()
    where id = v_id;
  else
    perform require_permission('finances.edit');
    update finance_purchases set
      description  = case when p_fields ? 'description' then left(trim(p_fields ->> 'description'), 300) else description end,
      amount       = case when p_fields ? 'amount' then v_amount::numeric else amount end,
      category     = case when p_fields ? 'category' then left(trim(p_fields ->> 'category'), 80) else category end,
      dept         = case when p_fields ? 'dept' then left(trim(p_fields ->> 'dept'), 20) else dept end,
      dept_status  = case when p_fields ? 'dept_status' then v_step else dept_status end,
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


-- ---------------------------------------------------------------------------
-- History entries for items arriving
-- ---------------------------------------------------------------------------
alter table public.request_events drop constraint if exists request_events_kind_check;
alter table public.request_events add constraint request_events_kind_check
  check (kind in ('submitted', 'resubmitted', 'withdrawn', 'ordered', 'received', 'edited', 'cancelled', 'restored', 'arrived'));


-- ---------------------------------------------------------------------------
-- Cancelling: also once it's Ordered; putting it back returns it where it was
-- ---------------------------------------------------------------------------
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
  if v_req.status not in ('Approved', 'Ordered') then
    raise exception '% is "%", not Approved or Ordered.', v_req.request_number, v_req.status;
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

-- It now says where it went back to, so drop the old one first.
drop function if exists public.restore_request(uuid);
create or replace function public.restore_request(p_id uuid)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_req requests;
  v_to  text;
begin
  perform require_permission('request.order');
  select * into v_req from requests where id = p_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if v_req.status <> 'Cancelled' then
    raise exception '% is "%", not Cancelled.', v_req.request_number, v_req.status;
  end if;
  -- Back to Ordered if it had been ordered, else to Approved (To order).
  v_to := case when exists (select 1 from order_information where request_id = p_id) then 'Ordered' else 'Approved' end;
  insert into request_events (request_id, kind, actor_id, actor_name, note)
  values (p_id, 'restored', auth.uid(), my_display_name(), v_to);
  update requests set status = v_to, updated_at = now() where id = p_id;
  -- A "Cancelled" message that hasn't gone out yet no longer applies.
  update notification_outbox set status = 'cancelled', error = 'The request was restored before this was sent.'
  where request_id = p_id and event = 'cancelled' and status = 'pending';
  return v_to;
end;
$$;
revoke execute on function public.restore_request(uuid) from public, anon;
grant execute on function public.restore_request(uuid) to authenticated;

-- Same as 024; putting a cancelled request back doesn't repeat "approved" / "ordered".
create or replace function public.notify_status_change()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.status is not distinct from old.status then return new; end if;
  if old.status = 'Cancelled' then return new; end if; -- put back: the requester was told it's cancelled
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

-- The standard "Cancelled" wording no longer says "before it was ordered".
update public.app_settings
set value = jsonb_set(value, '{templates,cancelled,body}',
                      to_jsonb('Hi {first_name}, "{title}" was cancelled by {approver}.' || chr(10) || 'Why: {comment}'::text))
where key = 'notifications'
  and value #>> '{templates,cancelled,body}' = 'Hi {first_name}, "{title}" was approved but cancelled by {approver} before it was ordered.' || chr(10) || 'Why: {comment}';

-- Before 024, "Cancelled" on Finances only changed the ledger: the request stayed
-- Approved (still in To order, still counted). Those become cancelled requests,
-- quietly (no messages), with a History entry saying so.
create temporary table legacy_cancelled as
  select r.id from requests r join finance_purchases p on p.request_id = r.id
  where r.status = 'Approved' and p.dept_status = 'cancelled';
alter table public.requests disable trigger requests_notify_status;
alter table public.requests disable trigger requests_notify_watchers;
insert into request_events (request_id, kind, actor_name, note)
select id, 'cancelled', 'Finances', 'Marked Cancelled on the Finances page.' from legacy_cancelled;
update requests set status = 'Cancelled', updated_at = now() where id in (select id from legacy_cancelled);
update finance_purchases set dept_status = 'to_submit' where request_id in (select id from legacy_cancelled);
alter table public.requests enable trigger requests_notify_status;
alter table public.requests enable trigger requests_notify_watchers;
drop table legacy_cancelled;


-- ---------------------------------------------------------------------------
-- Deleting a request entirely (duplicates, mistakes) — a copy is kept
-- ---------------------------------------------------------------------------
create table if not exists public.deleted_requests (
  id              uuid primary key default gen_random_uuid(),
  request_number  text not null,
  title           text not null default '',
  season          text not null default '',
  status          text not null default '',
  total           numeric(12, 2),
  reason          text not null default '',
  deleted_by      uuid references public.profiles(id) on delete set null,
  deleted_by_name text not null default '',
  deleted_at      timestamptz not null default now(),
  snapshot        jsonb not null            -- the request, items, approvals, order, history, ledger line
);
alter table public.deleted_requests enable row level security;
drop policy if exists "leads read" on public.deleted_requests;
create policy "leads read" on public.deleted_requests for select to authenticated
  using (has_permission('request.order') or has_permission('settings.edit'));
revoke all on public.deleted_requests from anon, authenticated;
grant select on public.deleted_requests to authenticated;

/** Delete a request and everything on it. Returns the storage paths of its files, to remove. */
create or replace function public.purge_request(p_id uuid, p_reason text)
returns text[]
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_req    requests;
  v_reason text := trim(coalesce(p_reason, ''));
  v_paths  text[];
begin
  perform require_permission('request.order');
  select * into v_req from requests where id = p_id for update;
  if not found then raise exception 'Request not found. It may already be deleted.'; end if;
  if v_reason = '' then raise exception 'Say why it''s being deleted (e.g. "Duplicate of SG-014").'; end if;

  insert into deleted_requests (request_number, title, season, status, total, reason, deleted_by, deleted_by_name, snapshot)
  values (v_req.request_number, coalesce(v_req.title, ''), coalesce(v_req.season, ''), v_req.status, request_total(p_id),
          left(v_reason, 500), auth.uid(), my_display_name(), jsonb_build_object(
    'request', to_jsonb(v_req),
    'items', (select coalesce(jsonb_agg(to_jsonb(i) order by i.position), '[]') from request_items i where i.request_id = p_id),
    'approvals', (select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at), '[]') from approvals a where a.request_id = p_id),
    'order', (select to_jsonb(o) from order_information o where o.request_id = p_id),
    'events', (select coalesce(jsonb_agg(to_jsonb(e) - 'snapshot' order by e.id), '[]') from request_events e where e.request_id = p_id),
    'cost_changes', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from cost_changes c where c.request_id = p_id),
    'ledger', (select to_jsonb(p) from finance_purchases p where p.request_id = p_id),
    'files', (select coalesce(jsonb_agg(jsonb_build_object('file_name', a.file_name, 'url', a.url, 'label', a.label)), '[]') from attachments a where a.request_id = p_id)));

  -- Files used only by this request go too (the website removes them from storage).
  select coalesce(array_agg(distinct a.path), '{}') into v_paths from attachments a
  where a.request_id = p_id and a.path is not null
    and not exists (select 1 from attachments b where b.path = a.path and b.request_id is distinct from p_id);

  delete from requests where id = p_id; -- items, approvals, history, files, ledger line, watchers go with it
  return v_paths;
end;
$$;
revoke execute on function public.purge_request(uuid, text) from public, anon;
grant execute on function public.purge_request(uuid, text) to authenticated;

-- Storage: a file whose request was deleted can be removed by whoever could edit it
-- (removing needs to read it too). Skipped where there is no Supabase Storage.
do $storage$
begin
  if to_regclass('storage.objects') is null then return; end if;
  execute 'drop policy if exists "attachments: read" on storage.objects';
  execute $p$
    create policy "attachments: read" on storage.objects for select to authenticated using (
      bucket_id = 'attachments' and (
        exists (
          select 1 from public.attachments a where a.path = name
            and public.attachment_access(public.attachment_kind(a), coalesce(a.sponsor_card_id, a.request_id, a.finance_row_id), false))
        or (split_part(name, '/', 2) ~ '^[0-9a-f-]{36}$'
            and not exists (select 1 from public.attachments a where a.path = name)
            and public.attachment_access(split_part(name, '/', 1), split_part(name, '/', 2)::uuid, true))))
  $p$;
end
$storage$;


-- ---------------------------------------------------------------------------
-- Items arriving one by one
-- ---------------------------------------------------------------------------
alter table public.request_items add column if not exists arrived_on date;
alter table public.request_items add column if not exists arrived_note text not null default '';
alter table public.request_items add column if not exists arrived_by uuid references public.profiles(id) on delete set null;

/** Mark items arrived (or not). The Treasurer or the requester, while it's Ordered. Returns how many still haven't arrived. */
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
    update request_items set arrived_on = coalesce(p_date, current_date), arrived_note = left(trim(coalesce(p_note, '')), 500), arrived_by = auth.uid()
    where request_id = p_request and id = any(coalesce(p_items, '{}'));
  else
    update request_items set arrived_on = null, arrived_note = '', arrived_by = null
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
revoke execute on function public.set_items_arrived(uuid, uuid[], boolean, date, text) from public, anon;
grant execute on function public.set_items_arrived(uuid, uuid[], boolean, date, text) to authenticated;

-- Received: same as 019, and any item not marked arrived yet arrives with it.
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
  update request_items set arrived_on = coalesce(p_received_date, current_date), arrived_by = auth.uid()
  where request_id = p_id and arrived_on is null;

  update requests set status = 'Received', updated_at = now() where id = p_id;
  insert into request_events (request_id, kind, actor_id, actor_name) values (p_id, 'received', auth.uid(), my_display_name());
end;
$$;

update app_settings set value = jsonb_set(value, '{schemaVersion}', '25') where key = 'general';
