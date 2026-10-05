-- =============================================================================
-- 016: Watchers on requests (orders).
--
--   * request_watchers: people following a request. Anyone signed in can watch
--     any request; the requester and leads (Approve / Order) can add others.
--   * When a watched request changes status (submitted, approved, sent back,
--     rejected, ordered, received), watchers get a "request_update" email /
--     Teams message, following Admin → Notifications and their own choices.
--     The requester isn't messaged twice (they already get their own messages).
--
-- Run once, after 015: Supabase → SQL Editor → New query → paste → Run.
-- =============================================================================

create table public.request_watchers (
  request_id  uuid not null references public.requests(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  added_by    uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (request_id, user_id)
);
create index request_watchers_user_idx on public.request_watchers (user_id);

alter table public.request_watchers enable row level security;
-- Everyone signed in can see every request, so also who's watching it.
create policy "signed-in read" on public.request_watchers for select to authenticated using (true);
revoke all on public.request_watchers from anon, authenticated;
grant select on public.request_watchers to authenticated;

/** Watch / stop watching a request. Anyone can for themselves; adding or removing others needs to be the requester or a lead. */
create or replace function public.set_request_watch(p_request uuid, p_user uuid, p_on boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  select created_by into v_owner from requests where id = p_request;
  if not found then raise exception 'That request no longer exists.'; end if;
  if p_user is distinct from auth.uid()
     and v_owner is distinct from auth.uid()
     and not (has_permission('request.review') or has_permission('request.order')) then
    raise exception 'Only the requester or a lead can add or remove other watchers.';
  end if;
  if p_on then
    if not exists (select 1 from profiles where id = p_user) then raise exception 'That person doesn''t have an account.'; end if;
    insert into request_watchers (request_id, user_id, added_by) values (p_request, p_user, auth.uid()) on conflict do nothing;
  else
    delete from request_watchers where request_id = p_request and user_id = p_user;
  end if;
end;
$$;
revoke execute on function public.set_request_watch(uuid, uuid, boolean) from public, anon;
grant execute on function public.set_request_watch(uuid, uuid, boolean) to authenticated;

/** Status changes → a message to each watcher (not the requester, and not whoever made the change). */
create or replace function public.notify_request_watchers()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_watchers uuid[];
begin
  if new.status is not distinct from old.status or new.status = 'Draft' then return new; end if;
  select coalesce(array_agg(user_id), '{}') into v_watchers
  from request_watchers where request_id = new.id and user_id is distinct from new.created_by;
  if cardinality(v_watchers) > 0 then
    perform enqueue_notification('request_update', new.id, v_watchers);
  end if;
  return new;
end;
$$;
revoke execute on function public.notify_request_watchers() from public, anon, authenticated;
create trigger requests_notify_watchers
  after update of status on public.requests
  for each row execute function public.notify_request_watchers();

-- On by default once notifications are turned on, with its own wording.
update public.app_settings
set value = jsonb_set(
  jsonb_set(value, '{events,request_update}', coalesce(value -> 'events' -> 'request_update', '{"email": true, "teams": true}'), true),
  '{templates,request_update}',
  coalesce(value -> 'templates' -> 'request_update', '{"subject": "{request_number} is now {status}", "body": "Hi {first_name}, \"{title}\" ({requester}) is now {status}. You''re getting this because you watch it."}'),
  true)
where key = 'notifications';

update public.app_settings set value = value || '{"schemaVersion": 16}' where key = 'general';
