-- =============================================================================
-- 015: Sponsors board — sponsorships and donations as cards on a kanban board.
--
--   * sponsor_cards: one card per sponsor / donor per season, with contacts,
--     amount, tags, a description, and "tips for next time" for future teams.
--   * sponsor_watchers: people who get an email / Teams message when a card
--     moves or someone comments.
--   * sponsor_activity: the card's history (created, moved, edited, comments).
--   * Stages, kinds and which Finances sheet receives money live in the
--     `sponsors` settings document (edited on the board).
--   * When a card reaches a stage marked "money received", a row is added to
--     the chosen Finances sheet (once), so income is never typed twice.
--   * Permissions: sponsors.view / sponsors.edit, and a new "Business
--     Coordinator" role that has both.
--
-- Run once, after 014: Supabase → SQL Editor → New query → paste → Run.
-- =============================================================================

insert into public.permissions (key, label, description, sort) values
  ('sponsors.view', 'See sponsors', 'Open the Sponsors board and its history (read only, can watch cards).', 9),
  ('sponsors.edit', 'Edit sponsors', 'Add and move sponsor cards, change the board''s stages.', 10)
on conflict (key) do nothing;
update public.permissions set sort = 11 where key = 'users.manage';

insert into public.roles (key, label, sort) values ('coordinator', 'Business Coordinator', 5) on conflict (key) do nothing;
insert into public.role_permissions (role, permission) values
  ('coordinator', 'sponsors.view'), ('coordinator', 'sponsors.edit'), ('coordinator', 'finances.view'),
  ('admin', 'sponsors.view'), ('admin', 'sponsors.edit')
on conflict do nothing;
-- Leads can follow along.
insert into public.role_permissions (role, permission)
select distinct role, 'sponsors.view' from public.role_permissions where permission in ('request.review', 'request.order')
on conflict do nothing;

/** Does someone else have a permission? (has_permission() is about the signed-in user.) */
create or replace function public.user_has_permission(p_user uuid, p_permission text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from profile_roles pr join role_permissions rp on rp.role = pr.role
    where pr.user_id = p_user and rp.permission = p_permission
  );
$$;


-- ---------------------------------------------------------------------------
-- Settings: stages, kinds, where received money goes
-- ---------------------------------------------------------------------------
insert into public.app_settings (key, value) values ('sponsors', '{
  "stages": [
    {"key": "prospect", "label": "Prospect", "kind": "open"},
    {"key": "contacted", "label": "Contacted", "kind": "open"},
    {"key": "talks", "label": "In talks", "kind": "open"},
    {"key": "committed", "label": "Committed", "kind": "open"},
    {"key": "received", "label": "Received", "kind": "received"},
    {"key": "thanked", "label": "Thanked", "kind": "done"},
    {"key": "declined", "label": "Not this year", "kind": "lost"}
  ],
  "kinds": ["Sponsorship", "Donation", "In-kind (parts or services)", "Discount", "Grant"],
  "income": {}
}') on conflict (key) do nothing;

/** The board's stages, kinds and income sheet (Edit sponsors). */
create or replace function public.save_sponsor_settings(p_value jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('sponsors.edit');
  if jsonb_typeof(p_value) <> 'object' or coalesce(jsonb_typeof(p_value -> 'stages'), '') <> 'array' or jsonb_array_length(p_value -> 'stages') = 0 then
    raise exception 'The board needs at least one stage.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_value -> 'stages') s where coalesce(s ->> 'key', '') = '' or coalesce(trim(s ->> 'label'), '') = '') then
    raise exception 'Every stage needs a name.';
  end if;
  if (select count(distinct s ->> 'key') from jsonb_array_elements(p_value -> 'stages') s) <> jsonb_array_length(p_value -> 'stages') then
    raise exception 'Two stages have the same key.';
  end if;
  -- Cards in a stage that's being removed move to the first stage.
  update sponsor_cards set stage = p_value -> 'stages' -> 0 ->> 'key', updated_at = now()
  where stage not in (select s ->> 'key' from jsonb_array_elements(p_value -> 'stages') s);
  insert into app_settings (key, value, updated_at, updated_by) values ('sponsors', p_value, now(), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid();
end;
$$;


-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.sponsor_cards (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(trim(name)) between 1 and 120),
  stage          text not null,
  position       double precision not null default 0,
  season         text not null default '',
  kind           text not null default '',
  amount         numeric(12, 2),
  owner_id       uuid references public.profiles(id) on delete set null,
  contact_name   text not null default '',
  contact_email  text not null default '',
  contact_phone  text not null default '',
  website        text not null default '',
  tags           text[] not null default '{}',
  description    text not null default '',   -- who they are, what they give, what they get back
  playbook       text not null default '',   -- what worked: tips for next year's team
  follow_up      date,
  renewed_from   uuid references public.sponsor_cards(id) on delete set null,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index sponsor_cards_board_idx on public.sponsor_cards (season, stage, position);

create table public.sponsor_watchers (
  card_id  uuid not null references public.sponsor_cards(id) on delete cascade,
  user_id  uuid not null references public.profiles(id) on delete cascade,
  primary key (card_id, user_id)
);

create table public.sponsor_activity (
  id          bigserial primary key,
  card_id     uuid not null references public.sponsor_cards(id) on delete cascade,
  kind        text not null check (kind in ('created', 'moved', 'edited', 'comment', 'income', 'renewed')),
  body        text not null default '',
  from_stage  text,
  to_stage    text,
  actor_id    uuid references public.profiles(id) on delete set null,
  actor_name  text not null default '',
  created_at  timestamptz not null default now()
);
create index sponsor_activity_card_idx on public.sponsor_activity (card_id, id);

-- Money a card brought in, as a row in a Finances sheet (added once).
alter table public.finance_rows add column sponsor_card_id uuid references public.sponsor_cards(id) on delete set null;
create unique index finance_rows_sponsor_card_idx on public.finance_rows (sheet_id, sponsor_card_id) where sponsor_card_id is not null;

alter table public.sponsor_cards enable row level security;
alter table public.sponsor_watchers enable row level security;
alter table public.sponsor_activity enable row level security;
create policy "sponsor readers" on public.sponsor_cards for select to authenticated using (has_permission('sponsors.view') or has_permission('sponsors.edit'));
create policy "sponsor readers" on public.sponsor_watchers for select to authenticated using (has_permission('sponsors.view') or has_permission('sponsors.edit'));
create policy "sponsor readers" on public.sponsor_activity for select to authenticated using (has_permission('sponsors.view') or has_permission('sponsors.edit'));
revoke all on public.sponsor_cards, public.sponsor_watchers, public.sponsor_activity from anon, authenticated;
grant select on public.sponsor_cards, public.sponsor_watchers, public.sponsor_activity to authenticated;


-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.sponsor_stage_label(p_key text)
returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce((select s ->> 'label' from app_settings, jsonb_array_elements(value -> 'stages') s
                   where key = 'sponsors' and s ->> 'key' = p_key limit 1), p_key);
$$;

create or replace function public.sponsor_stage_kind(p_key text)
returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce((select s ->> 'kind' from app_settings, jsonb_array_elements(value -> 'stages') s
                   where key = 'sponsors' and s ->> 'key' = p_key limit 1), 'open');
$$;

create or replace function public.log_sponsor_activity(p_card uuid, p_kind text, p_body text, p_from text default null, p_to text default null)
returns void
language sql security definer set search_path = public, pg_temp
as $$
  insert into sponsor_activity (card_id, kind, body, from_stage, to_stage, actor_id, actor_name)
  values (p_card, p_kind, coalesce(p_body, ''), p_from, p_to, auth.uid(), coalesce(my_display_name(), ''));
$$;

/**
 * Tell a card's watchers (except whoever did it) by email / Teams, following
 * Admin → Notifications and each person's own choices, like request messages.
 */
create or replace function public.notify_sponsor_watchers(p_card uuid, p_what text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_settings jsonb := (select value from app_settings where key = 'notifications');
  v_ev       jsonb := v_settings -> 'events' -> 'sponsor_update';
  v_card     sponsor_cards;
  v_payload  jsonb;
  v_person   profiles;
begin
  if v_settings is null or (v_settings -> 'enabled') is distinct from 'true'::jsonb or v_ev is null then return; end if;
  select * into v_card from sponsor_cards where id = p_card;
  v_payload := jsonb_build_object(
    'sponsor', v_card.name, 'stage', sponsor_stage_label(v_card.stage), 'what', p_what,
    'actor', coalesce(my_display_name(), 'Someone'), 'amount', v_card.amount, 'kind', v_card.kind,
    'path', '/sponsors/' || v_card.id);
  for v_person in
    select p.* from profiles p join sponsor_watchers w on w.user_id = p.id
    where w.card_id = p_card and p.id is distinct from auth.uid()
  loop
    if (v_ev -> 'email') = 'true'::jsonb and v_person.notify_email
       and (v_person.notify_events -> 'sponsor_update' -> 'email') is distinct from 'false'::jsonb then
      insert into notification_outbox (event, recipient_id, email, channel, payload)
      values ('sponsor_update', v_person.id, v_person.email, 'email', v_payload || jsonb_build_object('recipient_name', v_person.full_name));
    end if;
    if (v_ev -> 'teams') = 'true'::jsonb and v_person.notify_teams
       and (v_person.notify_events -> 'sponsor_update' -> 'teams') is distinct from 'false'::jsonb then
      insert into notification_outbox (event, recipient_id, email, channel, payload)
      values ('sponsor_update', v_person.id, v_person.email, 'teams', v_payload || jsonb_build_object('recipient_name', v_person.full_name));
    end if;
  end loop;
end;
$$;

/** Add the card's amount to the income Finances sheet (once per card). Returns true if a row was added. */
create or replace function public.log_sponsor_income(p_card uuid)
returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_income jsonb := (select value -> 'income' from app_settings where key = 'sponsors');
  v_sheet  uuid := nullif(v_income ->> 'sheet', '')::uuid;
  v_cols   jsonb := coalesce(v_income -> 'columns', '{}');
  v_card   sponsor_cards;
  v_data   jsonb := '{}';
begin
  select * into v_card from sponsor_cards where id = p_card;
  if v_sheet is null or v_card.amount is null or v_card.amount = 0 or not exists (select 1 from finance_sheets where id = v_sheet) then
    return false;
  end if;
  if exists (select 1 from finance_rows where sheet_id = v_sheet and sponsor_card_id = p_card) then return false; end if;
  if v_cols ? 'date'     then v_data := v_data || jsonb_build_object(v_cols ->> 'date', to_char(current_date, 'YYYY-MM-DD')); end if;
  if v_cols ? 'from'     then v_data := v_data || jsonb_build_object(v_cols ->> 'from', v_card.name); end if;
  if v_cols ? 'type'     then v_data := v_data || jsonb_build_object(v_cols ->> 'type', split_part(v_card.kind, ' (', 1)); end if;
  if v_cols ? 'amount'   then v_data := v_data || jsonb_build_object(v_cols ->> 'amount', to_char(v_card.amount, 'FM999999990.00')); end if;
  if v_cols ? 'received' then v_data := v_data || jsonb_build_object(v_cols ->> 'received', 'Yes'); end if;
  if v_cols ? 'notes'    then v_data := v_data || jsonb_build_object(v_cols ->> 'notes', 'From the Sponsors board'); end if;
  insert into finance_rows (sheet_id, position, data, sponsor_card_id, updated_by)
  values (v_sheet, (select coalesce(max(position), 0) + 1 from finance_rows where sheet_id = v_sheet), v_data, p_card, auth.uid());
  perform log_sponsor_activity(p_card, 'income', format('Added $%s to the Finances sheet "%s".',
    to_char(v_card.amount, 'FM999,999,990.00'), (select name from finance_sheets where id = v_sheet)));
  return true;
end;
$$;


-- ---------------------------------------------------------------------------
-- Actions
-- ---------------------------------------------------------------------------

/**
 * Create (p_id null) or update a card. p_fields: any of name, stage, season, kind,
 * amount, owner_id, contact_name, contact_email, contact_phone, website, tags,
 * description, playbook, follow_up. Returns the card's id.
 */
create or replace function public.save_sponsor_card(p_id uuid, p_fields jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_old  sponsor_cards;
  v_new  sponsor_cards;
  v_id   uuid := p_id;
  v_changed text[] := '{}';
  v_first text := (select value -> 'stages' -> 0 ->> 'key' from app_settings where key = 'sponsors');
  v_amount text := nullif(trim(coalesce(p_fields ->> 'amount', '')), '');
begin
  perform require_permission('sponsors.edit');
  if p_fields ? 'stage' and not exists (
    select 1 from app_settings, jsonb_array_elements(value -> 'stages') s where key = 'sponsors' and s ->> 'key' = p_fields ->> 'stage') then
    raise exception 'That stage doesn''t exist anymore. Reload the page.';
  end if;
  if v_amount is not null and v_amount !~ '^-?\d+(\.\d{1,2})?$' then
    raise exception 'The amount must be a number, like 2500 or 2500.50.';
  end if;
  if coalesce(p_fields ->> 'contact_email', '') <> '' and p_fields ->> 'contact_email' !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'The contact email doesn''t look right.';
  end if;

  if v_id is null then
    insert into sponsor_cards (name, stage, season, position, created_by, owner_id)
    values (
      coalesce(nullif(trim(p_fields ->> 'name'), ''), 'New sponsor'),
      coalesce(p_fields ->> 'stage', v_first),
      coalesce(nullif(p_fields ->> 'season', ''), (select value ->> 'season' from app_settings where key = 'general'), ''),
      (select coalesce(max(position), 0) + 1 from sponsor_cards),
      auth.uid(), auth.uid())
    returning id into v_id;
    insert into sponsor_watchers (card_id, user_id) values (v_id, auth.uid()) on conflict do nothing;
    perform log_sponsor_activity(v_id, 'created', '');
  end if;

  select * into v_old from sponsor_cards where id = v_id;
  if not found then raise exception 'That card was deleted by someone else.'; end if;

  update sponsor_cards set
    name          = case when p_fields ? 'name' then coalesce(nullif(trim(p_fields ->> 'name'), ''), name) else name end,
    season        = case when p_fields ? 'season' then trim(p_fields ->> 'season') else season end,
    kind          = case when p_fields ? 'kind' then trim(p_fields ->> 'kind') else kind end,
    amount        = case when p_fields ? 'amount' then v_amount::numeric else amount end,
    owner_id      = case when p_fields ? 'owner_id' then nullif(p_fields ->> 'owner_id', '')::uuid else owner_id end,
    contact_name  = case when p_fields ? 'contact_name' then trim(p_fields ->> 'contact_name') else contact_name end,
    contact_email = case when p_fields ? 'contact_email' then trim(p_fields ->> 'contact_email') else contact_email end,
    contact_phone = case when p_fields ? 'contact_phone' then trim(p_fields ->> 'contact_phone') else contact_phone end,
    website       = case when p_fields ? 'website' then trim(p_fields ->> 'website') else website end,
    tags          = case when p_fields ? 'tags' then coalesce((select array_agg(distinct trim(t)) from jsonb_array_elements_text(p_fields -> 'tags') t where trim(t) <> ''), '{}') else tags end,
    description   = case when p_fields ? 'description' then left(p_fields ->> 'description', 20000) else description end,
    playbook      = case when p_fields ? 'playbook' then left(p_fields ->> 'playbook', 20000) else playbook end,
    follow_up     = case when p_fields ? 'follow_up' then nullif(p_fields ->> 'follow_up', '')::date else follow_up end,
    updated_at    = now()
  where id = v_id
  returning * into v_new;

  if p_id is not null then
    if v_new.name is distinct from v_old.name then v_changed := array_append(v_changed, 'name'); end if;
    if v_new.kind is distinct from v_old.kind then v_changed := array_append(v_changed, 'kind'); end if;
    if v_new.amount is distinct from v_old.amount then v_changed := array_append(v_changed, 'amount'); end if;
    if v_new.season is distinct from v_old.season then v_changed := array_append(v_changed, 'season'); end if;
    if v_new.owner_id is distinct from v_old.owner_id then v_changed := array_append(v_changed, 'lead'); end if;
    if (v_new.contact_name, v_new.contact_email, v_new.contact_phone, v_new.website) is distinct from
       (v_old.contact_name, v_old.contact_email, v_old.contact_phone, v_old.website) then v_changed := array_append(v_changed, 'contact'); end if;
    if v_new.tags is distinct from v_old.tags then v_changed := array_append(v_changed, 'tags'); end if;
    if v_new.description is distinct from v_old.description then v_changed := array_append(v_changed, 'description'); end if;
    if v_new.playbook is distinct from v_old.playbook then v_changed := array_append(v_changed, 'tips for next time'); end if;
    if v_new.follow_up is distinct from v_old.follow_up then v_changed := array_append(v_changed, 'follow-up date'); end if;
    if cardinality(v_changed) > 0 then
      perform log_sponsor_activity(v_id, 'edited', 'Changed ' || array_to_string(v_changed, ', ') || '.');
    end if;
  end if;

  if p_fields ? 'stage' and p_fields ->> 'stage' is distinct from v_old.stage then
    perform move_sponsor_card(v_id, p_fields ->> 'stage', null);
  end if;
  return v_id;
end;
$$;

/** Move a card to a stage (and place). Logs it, tells watchers, records income. */
create or replace function public.move_sponsor_card(p_id uuid, p_stage text, p_position double precision)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_old text;
begin
  perform require_permission('sponsors.edit');
  if not exists (select 1 from app_settings, jsonb_array_elements(value -> 'stages') s where key = 'sponsors' and s ->> 'key' = p_stage) then
    raise exception 'That stage doesn''t exist anymore. Reload the page.';
  end if;
  select stage into v_old from sponsor_cards where id = p_id;
  if not found then raise exception 'That card was deleted by someone else.'; end if;
  update sponsor_cards set stage = p_stage, position = coalesce(p_position, position), updated_at = now() where id = p_id;
  if v_old is distinct from p_stage then
    perform log_sponsor_activity(p_id, 'moved', '', v_old, p_stage);
    perform notify_sponsor_watchers(p_id, format('moved from %s to %s', sponsor_stage_label(v_old), sponsor_stage_label(p_stage)));
    if sponsor_stage_kind(p_stage) = 'received' then perform log_sponsor_income(p_id); end if;
  end if;
end;
$$;

create or replace function public.add_sponsor_comment(p_id uuid, p_body text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not (has_permission('sponsors.edit') or has_permission('sponsors.view')) then
    raise exception 'Your role does not allow this action (sponsors.view).';
  end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'Write something first.'; end if;
  if not exists (select 1 from sponsor_cards where id = p_id) then raise exception 'That card was deleted by someone else.'; end if;
  perform log_sponsor_activity(p_id, 'comment', left(trim(p_body), 5000));
  perform notify_sponsor_watchers(p_id, format('new note: %s', left(trim(p_body), 300)));
end;
$$;

/** Watch / stop watching. Anyone who can see the board can watch; adding others needs Edit sponsors. */
create or replace function public.set_sponsor_watch(p_id uuid, p_user uuid, p_on boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_user is distinct from auth.uid() then
    perform require_permission('sponsors.edit');
  elsif not (has_permission('sponsors.edit') or has_permission('sponsors.view')) then
    raise exception 'Your role does not allow this action (sponsors.view).';
  end if;
  if p_on then
    if not (user_has_permission(p_user, 'sponsors.view') or user_has_permission(p_user, 'sponsors.edit')) then
      raise exception 'That person can''t see the Sponsors board. Give their role "See sponsors" first.';
    end if;
    insert into sponsor_watchers (card_id, user_id) values (p_id, p_user) on conflict do nothing;
  else
    delete from sponsor_watchers where card_id = p_id and user_id = p_user;
  end if;
end;
$$;

/** Copy a card into a new season at the first stage: same contacts, notes and watchers. Returns the new id. */
create or replace function public.renew_sponsor_card(p_id uuid, p_season text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_new uuid;
  v_old sponsor_cards;
begin
  perform require_permission('sponsors.edit');
  select * into v_old from sponsor_cards where id = p_id;
  if not found then raise exception 'That card was deleted by someone else.'; end if;
  if exists (select 1 from sponsor_cards where renewed_from = p_id and season = trim(p_season)) then
    raise exception 'This sponsor is already on the % board.', trim(p_season);
  end if;
  insert into sponsor_cards (name, stage, position, season, kind, amount, owner_id, contact_name, contact_email, contact_phone,
                             website, tags, description, playbook, renewed_from, created_by)
  select name, (select value -> 'stages' -> 0 ->> 'key' from app_settings where key = 'sponsors'),
         (select coalesce(max(position), 0) + 1 from sponsor_cards), trim(p_season), kind, amount, owner_id,
         contact_name, contact_email, contact_phone, website, tags, description, playbook, id, auth.uid()
  from sponsor_cards where id = p_id
  returning id into v_new;
  insert into sponsor_watchers (card_id, user_id) select v_new, user_id from sponsor_watchers where card_id = p_id;
  insert into sponsor_watchers (card_id, user_id) values (v_new, auth.uid()) on conflict do nothing;
  perform log_sponsor_activity(v_new, 'renewed', format('Renewed from the %s season.', v_old.season));
  return v_new;
end;
$$;

create or replace function public.delete_sponsor_card(p_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('sponsors.edit');
  delete from sponsor_cards where id = p_id;
end;
$$;

revoke execute on function
  public.user_has_permission(uuid, text), public.sponsor_stage_label(text), public.sponsor_stage_kind(text),
  public.log_sponsor_activity(uuid, text, text, text, text), public.notify_sponsor_watchers(uuid, text), public.log_sponsor_income(uuid)
from public, anon, authenticated;
revoke execute on function
  public.save_sponsor_settings(jsonb), public.save_sponsor_card(uuid, jsonb), public.move_sponsor_card(uuid, text, double precision),
  public.add_sponsor_comment(uuid, text), public.set_sponsor_watch(uuid, uuid, boolean), public.renew_sponsor_card(uuid, text),
  public.delete_sponsor_card(uuid)
from public, anon;
grant execute on function
  public.save_sponsor_settings(jsonb), public.save_sponsor_card(uuid, jsonb), public.move_sponsor_card(uuid, text, double precision),
  public.add_sponsor_comment(uuid, text), public.set_sponsor_watch(uuid, uuid, boolean), public.renew_sponsor_card(uuid, text),
  public.delete_sponsor_card(uuid)
to authenticated;

-- Watchers' messages are on by default once notifications are turned on (Admin → Notifications).
update public.app_settings
set value = jsonb_set(
  jsonb_set(value, '{events,sponsor_update}', coalesce(value -> 'events' -> 'sponsor_update', '{"email": true, "teams": true}'), true),
  '{templates,sponsor_update}',
  coalesce(value -> 'templates' -> 'sponsor_update', '{"subject": "{sponsor}: {what}", "body": "Hi {first_name}, {actor} updated {sponsor} on the Sponsors board: {what}."}'),
  true)
where key = 'notifications';

update public.app_settings set value = value || '{"schemaVersion": 15}' where key = 'general';
