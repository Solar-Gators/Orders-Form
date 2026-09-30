-- =============================================================================
-- 010 — Workflow rules, budgets, notifications
--
-- Workflow (Admin → Workflow), settings document `workflow`:
--   rules: checked in order when a request is submitted; the first match decides:
--     { name, when: { field, op, value, minTotal, maxTotal },
--       then: { type: 'auto' | 'any' | 'people', people: [user ids], needAll } }
--     auto   → approved immediately
--     any    → any Chief Engineer (anyone with "Approve requests")
--     people → these people (any one of them, or all of them when needAll)
--   No rule matches → any Chief Engineer, as before.
--   budgets: { field, amounts: { value: dollars }, block } — per current season.
--
-- Notifications (Admin → Notifications), settings document `notifications`:
--   Each workflow step writes messages to notification_outbox (same transaction,
--   so nothing is lost); the send-notifications Edge Function delivers them by
--   email and Microsoft Teams. Off until turned on in Admin → Notifications.
--
-- Run once, after 009: Supabase → SQL Editor → New query → paste → Run.
-- =============================================================================

insert into public.permissions (key, label, description, sort) values
  ('workflow.edit', 'Workflow, budgets & notifications',
   'Approval rules, budgets, and who gets emails / Teams messages.', 6)
on conflict (key) do nothing;
update public.permissions set sort = 7 where key = 'users.manage';
insert into public.role_permissions (role, permission) values ('admin', 'workflow.edit') on conflict do nothing;

-- Policies below call has_permission() as the signed-in user.
grant execute on function public.has_permission(text) to authenticated;


-- ---------------------------------------------------------------------------
-- Per-person notification choices (My account).
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column notify_email boolean not null default true,
  add column notify_teams boolean not null default true;

create or replace function public.update_my_notification_prefs(p_email boolean, p_teams boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  update profiles set notify_email = coalesce(p_email, true), notify_teams = coalesce(p_teams, true) where id = auth.uid();
end;
$$;


-- ---------------------------------------------------------------------------
-- Approval plan, decided when a request is submitted.
--   { rule, type: 'auto'|'any'|'people', people: [ids], needAll, submitted_at }
-- ---------------------------------------------------------------------------
alter table public.requests add column approval_plan jsonb;

create or replace function public.request_total(p_request_id uuid)
returns numeric
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(sum(coalesce(quantity, 0) * coalesce(unit_price, 0) + coalesce(shipping_cost, 0)), 0)
  from request_items where request_id = p_request_id;
$$;

create or replace function public.users_with_permission(p_permission text)
returns uuid[]
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct pr.user_id), '{}')
  from profile_roles pr join role_permissions rp on rp.role = pr.role
  where rp.permission = p_permission;
$$;

-- Does a rule's "when" match this request? Empty conditions match everything.
create or replace function public.rule_matches(p_when jsonb, p_request jsonb, p_total numeric)
returns boolean
language plpgsql immutable set search_path = public, pg_temp
as $$
begin
  if p_when is null or jsonb_typeof(p_when) <> 'object' then return true; end if;
  if coalesce(p_when ->> 'minTotal', '') ~ '^\d*\.?\d+$' and p_total < (p_when ->> 'minTotal')::numeric then return false; end if;
  if coalesce(p_when ->> 'maxTotal', '') ~ '^\d*\.?\d+$' and p_total >= (p_when ->> 'maxTotal')::numeric then return false; end if;
  if coalesce(p_when ->> 'field', '') <> '' then
    return field_visible(jsonb_build_object('showIf', p_when - 'minTotal' - 'maxTotal'), p_request, null);
  end if;
  return true;
end;
$$;

create or replace function public.compute_approval_plan(p_request_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_req   jsonb := (select to_jsonb(r) from requests r where r.id = p_request_id);
  v_total numeric := request_total(p_request_id);
  v_rule  jsonb;
  v_type  text;
  v_people jsonb;
begin
  for v_rule in
    select * from jsonb_array_elements(coalesce((select value -> 'rules' from app_settings where key = 'workflow'), '[]'))
  loop
    continue when (v_rule -> 'disabled') = 'true'::jsonb;
    if rule_matches(v_rule -> 'when', v_req, v_total) then
      v_type := coalesce(v_rule #>> '{then,type}', 'any');
      v_people := coalesce(v_rule #> '{then,people}', '[]');
      -- "Specific people" with nobody listed (or nobody who still exists) falls back to any CE.
      v_people := coalesce((select jsonb_agg(p) from jsonb_array_elements_text(v_people) p where p::uuid in (select id from profiles)), '[]');
      if v_type = 'people' and jsonb_array_length(v_people) = 0 then v_type := 'any'; end if;
      return jsonb_build_object(
        'rule', coalesce(v_rule ->> 'name', 'Rule'),
        'type', case when v_type in ('auto', 'any', 'people') then v_type else 'any' end,
        'people', case when v_type = 'people' then v_people else '[]'::jsonb end,
        'needAll', v_type = 'people' and (v_rule #> '{then,needAll}') = 'true'::jsonb,
        'submitted_at', now());
    end if;
  end loop;
  return jsonb_build_object('rule', null, 'type', 'any', 'people', '[]'::jsonb, 'needAll', false, 'submitted_at', now());
end;
$$;

/** Who should approve under a plan. */
create or replace function public.plan_approvers(p_plan jsonb)
returns uuid[]
language sql stable security definer set search_path = public, pg_temp
as $$
  select case when p_plan ->> 'type' = 'people'
    then (select coalesce(array_agg(p::uuid), '{}') from jsonb_array_elements_text(p_plan -> 'people') p)
    else users_with_permission('request.review') end;
$$;


-- ---------------------------------------------------------------------------
-- Budgets (current season): used = Approved + Ordered + Received.
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
  if v_used + v_this > v_amount then
    return format('Approving this would put %s over its budget: $%s used + $%s = $%s of $%s.',
      v_value, to_char(v_used, 'FM999,999,990.00'), to_char(v_this, 'FM999,999,990.00'),
      to_char(v_used + v_this, 'FM999,999,990.00'), to_char(v_amount, 'FM999,999,990.00'));
  end if;
  return null;
end;
$$;


-- ---------------------------------------------------------------------------
-- Notification outbox. The Edge Function (service role) delivers pending rows.
-- ---------------------------------------------------------------------------
create table public.notification_outbox (
  id           bigserial primary key,
  created_at   timestamptz not null default now(),
  event        text not null,        -- submitted | approved | ready_to_order | changes_requested | rejected | ordered | received | test
  request_id   uuid references public.requests(id) on delete cascade,
  recipient_id uuid references public.profiles(id) on delete cascade,
  email        text not null,
  channel      text not null check (channel in ('email', 'teams')),
  payload      jsonb not null default '{}',
  status       text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts     int not null default 0,
  claimed_at   timestamptz,
  sent_at      timestamptz,
  error        text not null default ''
);
create index notification_outbox_pending_idx on public.notification_outbox (status, id);

alter table public.notification_outbox enable row level security;
create policy "leads read" on public.notification_outbox for select to authenticated using (public.has_permission('workflow.edit'));
revoke all on public.notification_outbox from anon, authenticated;
grant select on public.notification_outbox to authenticated;

-- Queue a message for each recipient and channel that's switched on.
-- The person who caused the event isn't messaged about it.
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
    if (v_ev -> 'email') = 'true'::jsonb and v_person.notify_email then
      insert into notification_outbox (event, request_id, recipient_id, email, channel, payload)
      values (p_event, p_request_id, v_person.id, v_person.email, 'email', v_payload || jsonb_build_object('recipient_name', v_person.full_name));
    end if;
    if (v_ev -> 'teams') = 'true'::jsonb and v_person.notify_teams then
      insert into notification_outbox (event, request_id, recipient_id, email, channel, payload)
      values (p_event, p_request_id, v_person.id, v_person.email, 'teams', v_payload || jsonb_build_object('recipient_name', v_person.full_name));
    end if;
  end loop;
end;
$$;

-- Status changes → messages (submitted is handled in on_request_submitted, which knows the plan).
create or replace function public.notify_status_change()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.status is not distinct from old.status then return new; end if;
  case new.status
    when 'Approved' then
      perform enqueue_notification('approved', new.id, array[new.created_by]);
      perform enqueue_notification('ready_to_order', new.id, users_with_permission('request.order'));
    when 'Changes Requested' then perform enqueue_notification('changes_requested', new.id, array[new.created_by]);
    when 'Rejected' then perform enqueue_notification('rejected', new.id, array[new.created_by]);
    when 'Ordered' then perform enqueue_notification('ordered', new.id, array[new.created_by]);
    when 'Received' then perform enqueue_notification('received', new.id, array[new.created_by]);
    else null;
  end case;
  return new;
end;
$$;
create trigger requests_notify_status
  after update of status on public.requests
  for each row execute function public.notify_status_change();

-- Called by save_request after a submission (items are saved by then).
create or replace function public.on_request_submitted(p_request_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_plan jsonb := compute_approval_plan(p_request_id);
begin
  update requests set approval_plan = v_plan where id = p_request_id;
  if v_plan ->> 'type' = 'auto' and budget_problem(p_request_id) is null then
    insert into approvals (request_id, approver_id, approver, decision, comment)
    values (p_request_id, null, 'Automatic', 'approve', format('Approved automatically by the rule "%s".', v_plan ->> 'rule'));
    update requests set status = 'Approved', updated_at = now() where id = p_request_id;
  else
    perform enqueue_notification('submitted', p_request_id, plan_approvers(v_plan));
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- Reviewing follows the plan:
--   any    → anyone with "Approve requests"
--   people → the listed people (anyone with "Workflow…" can step in too);
--            with needAll, it's Approved once every listed person has approved.
-- Budgets can block the final approval. Reject / request changes end the round.
-- ---------------------------------------------------------------------------
create or replace function public.review_request(p_id uuid, p_decision text, p_comment text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_req      requests;
  v_plan     jsonb;
  v_comment  text := trim(coalesce(p_comment, ''));
  v_people   uuid[];
  v_missing  uuid[];
  v_problem  text;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if p_decision not in ('approve', 'request_changes', 'reject') then
    raise exception 'Decision must be approve, request_changes or reject.';
  end if;
  if p_decision <> 'approve' and v_comment = '' then
    raise exception 'A comment is required when requesting changes or rejecting.';
  end if;

  select * into v_req from requests where id = p_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if v_req.status <> 'Submitted' then
    raise exception '% is "%", not Submitted.', v_req.request_number, v_req.status;
  end if;

  v_plan := coalesce(v_req.approval_plan, jsonb_build_object('type', 'any', 'submitted_at', v_req.updated_at));
  if v_plan ->> 'type' = 'people' then
    v_people := plan_approvers(v_plan);
    if not (auth.uid() = any(v_people) or has_permission('workflow.edit')) then
      raise exception 'Only % can review %.',
        (select string_agg(coalesce(nullif(full_name, ''), email), ', ') from profiles where id = any(v_people)), v_req.request_number;
    end if;
  else
    perform require_permission('request.review');
  end if;

  insert into approvals (request_id, approver_id, approver, decision, comment)
  values (p_id, auth.uid(), my_display_name(), p_decision, v_comment);

  if p_decision = 'approve' then
    if (v_plan -> 'needAll') = 'true'::jsonb then
      select coalesce(array_agg(p), '{}') into v_missing
      from unnest(v_people) p
      where not exists (
        select 1 from approvals a
        where a.request_id = p_id and a.approver_id = p and a.decision = 'approve'
          and a.created_at >= coalesce((v_plan ->> 'submitted_at')::timestamptz, '-infinity'));
      if cardinality(v_missing) > 0 then
        update requests set updated_at = now() where id = p_id; -- still waiting on others
        return;
      end if;
    end if;
    v_problem := budget_problem(p_id);
    if v_problem is not null then raise exception '%', v_problem; end if;
  end if;

  update requests set
    status = case p_decision when 'approve' then 'Approved' when 'reject' then 'Rejected' else 'Changes Requested' end,
    updated_at = now()
  where id = p_id;
end;
$$;


-- The Edge Function takes a batch of messages to send (so two runs never send
-- the same one), then reports back. Failed messages are retried up to 5 times.
create or replace function public.claim_notifications(p_limit int)
returns setof public.notification_outbox
language sql security definer set search_path = public, pg_temp
as $$
  update notification_outbox set status = 'sending', attempts = attempts + 1, claimed_at = now()
  where id in (
    select id from notification_outbox
    where status = 'pending' or (status = 'sending' and claimed_at < now() - interval '10 minutes' and attempts < 5)
    order by id limit p_limit
    for update skip locked)
  returning *;
$$;

create or replace function public.finish_notification(p_id bigint, p_ok boolean, p_error text)
returns void
language sql security definer set search_path = public, pg_temp
as $$
  update notification_outbox set
    status = case when p_ok then 'sent' when attempts >= 5 then 'failed' else 'pending' end,
    sent_at = case when p_ok then now() end,
    error = case when p_ok then '' else left(coalesce(p_error, ''), 1000) end
  where id = p_id;
$$;

-- Admin → Notifications: send a failed message again.
create or replace function public.retry_notification(p_id bigint)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('workflow.edit');
  update notification_outbox set status = 'pending', attempts = 0, error = '' where id = p_id and status = 'failed';
end;
$$;

-- Admin → Notifications → "Send me a test".
create or replace function public.queue_test_notification(p_channel text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_me profiles;
begin
  perform require_permission('workflow.edit');
  select * into v_me from profiles where id = auth.uid();
  if p_channel not in ('email', 'teams') then raise exception 'Channel must be email or teams.'; end if;
  insert into notification_outbox (event, request_id, recipient_id, email, channel, payload)
  values ('test', null, v_me.id, v_me.email, p_channel, jsonb_build_object('recipient_name', v_me.full_name));
end;
$$;


-- Settings documents: workflow + notifications need "Workflow, budgets & notifications".
insert into public.app_settings (key, value) values
  ('workflow', '{"rules": [], "budgets": {"field": "", "amounts": {}, "block": false}}'),
  ('notifications', '{
    "enabled": false,
    "siteUrl": "",
    "events": {
      "submitted":         {"email": true, "teams": true},
      "approved":          {"email": true, "teams": true},
      "ready_to_order":    {"email": true, "teams": true},
      "changes_requested": {"email": true, "teams": true},
      "rejected":          {"email": true, "teams": true},
      "ordered":           {"email": true, "teams": false},
      "received":          {"email": true, "teams": true}
    },
    "templates": {
      "submitted": {
        "subject": "{request_number} needs your approval",
        "body": "{requester} submitted \"{title}\": {total} from {vendor}.\nRule: {rule}"
      },
      "approved": {
        "subject": "{request_number} was approved",
        "body": "Hi {first_name}, \"{title}\" was approved by {approver}. The treasurer will order it next.\nComment: {comment}"
      },
      "ready_to_order": {
        "subject": "{request_number} is ready to order",
        "body": "\"{title}\" ({total} from {vendor}) was approved by {approver} and is ready to order."
      },
      "changes_requested": {
        "subject": "{request_number}: changes requested",
        "body": "Hi {first_name}, {approver} asked for changes to \"{title}\":\n{comment}\nEdit it and submit again."
      },
      "rejected": {
        "subject": "{request_number} was rejected",
        "body": "Hi {first_name}, {approver} rejected \"{title}\":\n{comment}"
      },
      "ordered": {
        "subject": "{request_number} has been ordered",
        "body": "Hi {first_name}, \"{title}\" has been ordered from {vendor}.\nOrder / ticket number: {ticket}"
      },
      "received": {
        "subject": "{request_number} has arrived",
        "body": "Hi {first_name}, \"{title}\" was marked received."
      }
    }
  }')
on conflict (key) do nothing;


-- save_request: same as 009; submitting runs the approval rules.
create or replace function public.save_request(p_id uuid, p_request jsonb, p_items jsonb, p_action text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_submit    boolean := p_action = 'submit';
  v_form      jsonb;
  v_rf        jsonb;
  v_if        jsonb;
  v_errors    text[] := '{}';
  v_existing  requests;
  v_id        uuid;
  v_number    text;
  v_title     text := trim(coalesce(p_request ->> 'title', ''));
  v_requester text := trim(coalesce(p_request ->> 'requester', ''));
  v_subsystem text := trim(coalesce(p_request ->> 'subsystem', ''));
  v_priority  text := trim(coalesce(p_request ->> 'priority', ''));
  v_needed    text := trim(coalesce(p_request ->> 'needed_by', ''));
  v_just      text := trim(coalesce(p_request ->> 'justification', ''));
  v_needed_by date;
  v_values    jsonb;
  v_custom    record;
  v_rdata     jsonb;
  v_field     jsonb;
  v_key       text;
  v_val       text;
  v_items     jsonb := '[]';
  v_item      jsonb;
  v_n         int := 0;
  v_qty_txt   text;
  v_price_txt text;
  v_label     text;
  v_qty_bad   boolean;
  v_price_bad boolean;
  v_ship_txt  text;
  v_ship_bad  boolean;
  v_vendors   text[];
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if p_action not in ('draft', 'submit') then raise exception 'action must be draft or submit'; end if;

  select value into v_form from app_settings where key = 'form';
  v_rf := coalesce(v_form -> 'requestFields', '[]');
  v_if := coalesce(v_form -> 'itemFields', '[]');
  if v_priority = '' then v_priority := coalesce(v_form ->> 'defaultPriority', ''); end if;

  -- Built-in request fields
  if v_title = '' then
    v_errors := array_append(v_errors, form_field_label(v_rf, 'title', 'Request title') || ' is required.');
  end if;
  if v_subsystem <> '' and not (v_form -> 'subsystems') ? v_subsystem then
    v_errors := array_append(v_errors, format('Unknown subsystem "%s".', v_subsystem));
  end if;
  if v_priority <> '' and not (v_form -> 'priorities') ? v_priority then
    v_errors := array_append(v_errors, format('Unknown priority "%s".', v_priority));
  end if;
  if v_needed <> '' then
    if is_valid_date(v_needed) then
      v_needed_by := v_needed::date;
    else
      v_errors := array_append(v_errors, form_field_label(v_rf, 'needed_by', 'Needed-by date') || ' must be a valid date.');
    end if;
  end if;

  if v_submit then
    v_values := jsonb_build_object('requester', v_requester, 'subsystem', v_subsystem, 'priority', v_priority,
                                   'needed_by', v_needed, 'justification', v_just);
    for v_field in select * from jsonb_array_elements(v_rf) loop
      continue when (v_field -> 'builtin') is distinct from 'true'::jsonb or v_field ->> 'key' = 'title'
                 or (v_field -> 'hidden') = 'true'::jsonb or (v_field -> 'required') is distinct from 'true'::jsonb
                 or not field_visible(v_field, p_request, null);
      if coalesce(v_values ->> (v_field ->> 'key'), '') = '' then
        v_errors := array_append(v_errors, (v_field ->> 'label') || ' is required.');
      end if;
    end loop;
  end if;

  -- Custom request fields
  select * into v_custom from clean_custom_fields(v_rf, p_request -> 'data', '', v_submit, p_request, null);
  v_rdata := v_custom.o_data;
  v_errors := v_errors || v_custom.o_errors;

  -- Items: drop fully blank rows, validate the rest.
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
    v_qty_txt   := regexp_replace(trim(coalesce(v_item ->> 'quantity', '')), '[$,]', '', 'g');
    v_price_txt := regexp_replace(trim(coalesce(v_item ->> 'unit_price', '')), '[$,]', '', 'g');
    v_ship_txt  := regexp_replace(trim(coalesce(v_item ->> 'shipping_cost', '')), '[$,]', '', 'g');
    continue when trim(coalesce(v_item ->> 'item_name', '')) = '' and trim(coalesce(v_item ->> 'vendor', '')) = ''
              and trim(coalesce(v_item ->> 'product_link', '')) = '' and trim(coalesce(v_item ->> 'part_number', '')) = ''
              and trim(coalesce(v_item ->> 'notes', '')) = '' and v_qty_txt = '' and v_price_txt = '' and v_ship_txt = ''
              and not exists (select 1 from jsonb_each_text(case when jsonb_typeof(v_item -> 'data') = 'object'
                                                                 then v_item -> 'data' else '{}' end) d
                              where trim(d.value) <> '');
    v_n := v_n + 1;
    v_label := 'Item ' || v_n || ': ';
    v_qty_bad := false;
    v_price_bad := false;
    v_ship_bad := false;

    if v_qty_txt <> '' and (v_qty_txt !~ '^\d*\.?\d+$' or v_qty_txt::numeric <= 0) then
      v_errors := array_append(v_errors, v_label || form_field_label(v_if, 'quantity', 'Quantity') || ' must be a positive number.');
      v_qty_txt := '';
      v_qty_bad := true;
    end if;
    if v_price_txt <> '' and v_price_txt !~ '^\d*\.?\d+$' then
      v_errors := array_append(v_errors, v_label || form_field_label(v_if, 'unit_price', 'Unit price') || ' must be a number of 0 or more.');
      v_price_txt := '';
      v_price_bad := true;
    end if;
    if v_ship_txt <> '' and v_ship_txt !~ '^\d*\.?\d+$' then
      v_errors := array_append(v_errors, v_label || form_field_label(v_if, 'shipping_cost', 'Shipping') || ' must be a number of 0 or more.');
      v_ship_txt := '';
      v_ship_bad := true;
    end if;

    if v_submit then
      -- Item name, quantity and unit price are always required; others per settings.
      foreach v_key in array array['item_name', 'vendor', 'product_link', 'part_number', 'quantity', 'unit_price', 'shipping_cost', 'notes'] loop
        select f into v_field from jsonb_array_elements(v_if) f where f ->> 'key' = v_key;
        continue when v_key not in ('item_name', 'quantity', 'unit_price')
                   and (v_field is null or (v_field -> 'required') is distinct from 'true'::jsonb or (v_field -> 'hidden') = 'true'::jsonb
                        or not field_visible(v_field, p_request, v_item));
        -- Already reported as invalid; don't also say it's missing.
        continue when (v_key = 'quantity' and v_qty_bad) or (v_key = 'unit_price' and v_price_bad)
                   or (v_key = 'shipping_cost' and v_ship_bad);
        v_val := case v_key when 'quantity' then v_qty_txt when 'unit_price' then v_price_txt
                            when 'shipping_cost' then v_ship_txt
                            else trim(coalesce(v_item ->> v_key, '')) end;
        if v_val = '' then
          v_errors := array_append(v_errors, v_label || form_field_label(v_if, v_key, initcap(replace(v_key, '_', ' '))) || ' is required.');
        end if;
      end loop;
    end if;

    select * into v_custom from clean_custom_fields(v_if, v_item -> 'data', v_label, v_submit, p_request, v_item);
    v_errors := v_errors || v_custom.o_errors;

    v_items := v_items || jsonb_build_object(
      'item_name',    trim(coalesce(v_item ->> 'item_name', '')),
      'vendor',       trim(coalesce(v_item ->> 'vendor', '')),
      'product_link', trim(coalesce(v_item ->> 'product_link', '')),
      'part_number',  trim(coalesce(v_item ->> 'part_number', '')),
      'quantity',     nullif(v_qty_txt, ''),
      'unit_price',   nullif(v_price_txt, ''),
      'shipping_cost', nullif(v_ship_txt, ''),
      'notes',        trim(coalesce(v_item ->> 'notes', '')),
      'data',         v_custom.o_data
    );
  end loop;
  if v_submit and v_n = 0 then v_errors := array_append(v_errors, 'Add at least one item.'); end if;

  -- One vendor per request (setting form.oneVendorPerRequest, on unless set to false;
  -- skipped when the Vendor field is hidden). Compared ignoring case and spacing.
  if (v_form -> 'oneVendorPerRequest') is distinct from 'false'::jsonb
     and not exists (select 1 from jsonb_array_elements(v_if) f where f ->> 'key' = 'vendor' and (f -> 'hidden') = 'true'::jsonb) then
    select array_agg(v order by v) into v_vendors from (
      select min(i ->> 'vendor') as v
      from jsonb_array_elements(v_items) i
      where trim(i ->> 'vendor') <> ''
      group by lower(regexp_replace(trim(i ->> 'vendor'), '\s+', ' ', 'g'))
    ) d;
    if cardinality(v_vendors) > 1 then
      v_errors := array_append(v_errors, format(
        'All items in a request must come from the same %s. This one has: %s. Split them into separate requests.',
        lower(form_field_label(v_if, 'vendor', 'Vendor')), array_to_string(v_vendors, ', ')));
    end if;
  end if;

  if cardinality(v_errors) > 0 then
    raise exception using message = 'Please fix the following:', detail = array_to_string(v_errors, E'\n');
  end if;

  if p_id is null then
    insert into requests (created_by, title, requester, subsystem, priority, needed_by, justification, data, status)
    values (v_uid, v_title, v_requester, v_subsystem, v_priority, v_needed_by, v_just, v_rdata,
            case when v_submit then 'Submitted' else 'Draft' end)
    returning id, request_number into v_id, v_number;
  else
    select * into v_existing from requests where id = p_id for update;
    if not found then raise exception 'Request not found.'; end if;
    if v_existing.created_by is distinct from v_uid then
      raise exception 'Only the person who created % can edit it.', v_existing.request_number;
    end if;
    if v_existing.status not in ('Draft', 'Changes Requested') then
      raise exception '% is "%" and can no longer be edited.', v_existing.request_number, v_existing.status;
    end if;
    update requests set
      title = v_title, requester = v_requester, subsystem = v_subsystem, priority = v_priority,
      needed_by = v_needed_by, justification = v_just, data = v_rdata,
      status = case when v_submit then 'Submitted' else 'Draft' end,
      updated_at = now()
    where id = p_id;
    delete from request_items where request_id = p_id;
    v_id := p_id;
    v_number := v_existing.request_number;
  end if;

  insert into request_items (request_id, position, item_name, vendor, product_link, part_number, quantity, unit_price, shipping_cost, notes, data)
  select v_id, (e.ord - 1)::int, e.item ->> 'item_name', e.item ->> 'vendor', e.item ->> 'product_link',
         e.item ->> 'part_number', (e.item ->> 'quantity')::numeric, (e.item ->> 'unit_price')::numeric,
         (e.item ->> 'shipping_cost')::numeric, e.item ->> 'notes', e.item -> 'data'
  from jsonb_array_elements(v_items) with ordinality as e(item, ord);

  if v_submit then
    perform on_request_submitted(v_id);
  end if;

  return v_number;
end;
$$;

-- update_settings: same as 009, plus the `workflow` and `notifications` documents.
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


revoke execute on function
  public.request_total(uuid),
  public.users_with_permission(text),
  public.rule_matches(jsonb, jsonb, numeric),
  public.compute_approval_plan(uuid),
  public.plan_approvers(jsonb),
  public.budget_problem(uuid),
  public.enqueue_notification(text, uuid, uuid[]),
  public.notify_status_change(),
  public.on_request_submitted(uuid)
from public, anon, authenticated;
-- (service_role always exists on Supabase; this is for local test databases.)
do $$ begin
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
revoke execute on function
  public.claim_notifications(int),
  public.finish_notification(bigint, boolean, text)
from public, anon, authenticated;
grant execute on function
  public.claim_notifications(int),
  public.finish_notification(bigint, boolean, text)
to service_role;
revoke execute on function
  public.update_my_notification_prefs(boolean, boolean),
  public.queue_test_notification(text),
  public.retry_notification(bigint)
from public, anon;
grant execute on function
  public.update_my_notification_prefs(boolean, boolean),
  public.queue_test_notification(text),
  public.retry_notification(bigint)
to authenticated;

update public.app_settings set value = value || '{"schemaVersion": 10}' where key = 'general';
