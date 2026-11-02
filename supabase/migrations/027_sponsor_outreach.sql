-- =============================================================================
-- 027: Sponsor outreach — returning sponsors, asking again, tracker fields, tags
-- =============================================================================
-- Run once, after 026: Supabase → SQL Editor → New query → paste → Run.
--
--   * The same sponsor across cars and seasons: cards with the same name (give or
--     take "Inc.", plurals and punctuation) are grouped by the site. When names
--     differ ("Digikey" / "Digikey Parts Distributor"), link them by hand;
--     sponsor_key keeps that link (and an unlink).
--   * Ask again: copy past sponsors onto this season's board in one go, at the
--     first stage, for the current car, keeping contacts, notes and tips.
--   * Outreach tracker fields on each card: priority (1 = highest), request
--     category, and the date they were last contacted. Anyone who can see the
--     board can claim a card ("I'm reaching out") so two people don't email the
--     same company, and whoever claimed it can log that they contacted them.
--   * Tags can be renamed or merged across every card ("aero-body" → "aerobody").
--   * Cards imported by 026 with "Priority:" / "Date contacted:" lines in About
--     this sponsor get those as real fields.
-- =============================================================================

alter table public.sponsor_cards add column if not exists priority smallint check (priority between 1 and 5);
alter table public.sponsor_cards add column if not exists category text not null default '';
alter table public.sponsor_cards add column if not exists contacted_on date;
alter table public.sponsor_cards add column if not exists sponsor_key text not null default '';

alter table public.sponsor_activity drop constraint if exists sponsor_activity_kind_check;
alter table public.sponsor_activity add constraint sponsor_activity_kind_check
  check (kind in ('created', 'moved', 'edited', 'comment', 'income', 'renewed', 'file', 'claimed', 'contacted'));


-- ---------------------------------------------------------------------------
-- Saving a card: same as 026, plus priority, category and date contacted
-- ---------------------------------------------------------------------------
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
  v_priority text := nullif(trim(coalesce(p_fields ->> 'priority', '')), '');
begin
  perform require_permission('sponsors.edit');
  if p_fields ? 'stage' and not exists (
    select 1 from app_settings, jsonb_array_elements(value -> 'stages') s where key = 'sponsors' and s ->> 'key' = p_fields ->> 'stage') then
    raise exception 'That stage doesn''t exist anymore. Reload the page.';
  end if;
  if v_amount is not null and v_amount !~ '^-?\d+(\.\d{1,2})?$' then
    raise exception 'The amount must be a number, like 2500 or 2500.50.';
  end if;
  if v_priority is not null and v_priority !~ '^[1-5]$' then
    raise exception 'The priority must be 1 (highest) to 5.';
  end if;
  if coalesce(p_fields ->> 'contact_email', '') <> '' and p_fields ->> 'contact_email' !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'The contact email doesn''t look right.';
  end if;
  if coalesce(p_fields ->> 'contacted_on', '') <> '' and (p_fields ->> 'contacted_on')::date > current_date then
    raise exception 'The date contacted can''t be in the future.';
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
    car           = case when p_fields ? 'car' then left(trim(p_fields ->> 'car'), 40) else car end,
    kind          = case when p_fields ? 'kind' then trim(p_fields ->> 'kind') else kind end,
    amount        = case when p_fields ? 'amount' then v_amount::numeric else amount end,
    priority      = case when p_fields ? 'priority' then v_priority::smallint else priority end,
    category      = case when p_fields ? 'category' then left(trim(p_fields ->> 'category'), 80) else category end,
    contacted_on  = case when p_fields ? 'contacted_on' then nullif(p_fields ->> 'contacted_on', '')::date else contacted_on end,
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
    if v_new.car is distinct from v_old.car then v_changed := array_append(v_changed, 'car'); end if;
    if v_new.priority is distinct from v_old.priority then v_changed := array_append(v_changed, 'priority'); end if;
    if v_new.category is distinct from v_old.category then v_changed := array_append(v_changed, 'category'); end if;
    if v_new.contacted_on is distinct from v_old.contacted_on then v_changed := array_append(v_changed, 'date contacted'); end if;
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


-- ---------------------------------------------------------------------------
-- Renewing keeps the car, category, priority and sponsor link (same as 026 otherwise)
-- ---------------------------------------------------------------------------
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
  insert into sponsor_cards (name, stage, position, season, car, kind, amount, priority, category, sponsor_key, owner_id,
                             contact_name, contact_email, contact_phone, website, tags, description, playbook, renewed_from, created_by)
  select name, (select value -> 'stages' -> 0 ->> 'key' from app_settings where key = 'sponsors'),
         (select coalesce(max(position), 0) + 1 from sponsor_cards), trim(p_season), car, kind, amount, priority, category, sponsor_key, owner_id,
         contact_name, contact_email, contact_phone, website, tags, description, playbook, id, auth.uid()
  from sponsor_cards where id = p_id
  returning id into v_new;
  insert into sponsor_watchers (card_id, user_id) select v_new, user_id from sponsor_watchers where card_id = p_id;
  insert into sponsor_watchers (card_id, user_id) values (v_new, auth.uid()) on conflict do nothing;
  insert into attachments (sponsor_card_id, path, url, file_name, size, mime, label, uploaded_by, uploaded_by_name, created_at)
  select v_new, path, url, file_name, size, mime, label, uploaded_by, uploaded_by_name, created_at from attachments where sponsor_card_id = p_id;
  perform log_sponsor_activity(v_new, 'renewed', format('Renewed from the %s season.', v_old.season));
  return v_new;
end;
$$;


-- ---------------------------------------------------------------------------
-- Ask again: past sponsors onto this season's board
-- ---------------------------------------------------------------------------
/**
 * Copy each card onto p_season's board for p_car, at the first stage: contacts,
 * type, tags, category, notes, tips and files. No amount (it's a new ask) and no
 * lead (last time's lead has usually graduated); whoever does it watches the new
 * cards. A card already asked again for that season is skipped. Returns how many were added.
 */
create or replace function public.ask_sponsors_again(p_ids uuid[], p_season text, p_car text)
returns integer
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_old   sponsor_cards;
  v_new   uuid;
  v_n     integer := 0;
  v_season text := trim(coalesce(p_season, ''));
  v_was   text;
begin
  perform require_permission('sponsors.edit');
  if v_season = '' then raise exception 'Choose the season to add them to.'; end if;
  for v_old in select * from sponsor_cards where id = any(p_ids) order by name loop
    continue when exists (select 1 from sponsor_cards where renewed_from = v_old.id and season = v_season);
    insert into sponsor_cards (name, stage, position, season, car, kind, priority, category, sponsor_key,
                               contact_name, contact_email, contact_phone, website, tags, description, playbook, renewed_from, created_by)
    values (v_old.name, (select value -> 'stages' -> 0 ->> 'key' from app_settings where key = 'sponsors'),
            (select coalesce(max(position), 0) + 1 from sponsor_cards), v_season, left(trim(coalesce(p_car, '')), 40),
            v_old.kind, v_old.priority, v_old.category, v_old.sponsor_key, v_old.contact_name, v_old.contact_email,
            v_old.contact_phone, v_old.website, v_old.tags, v_old.description, v_old.playbook, v_old.id, auth.uid())
    returning id into v_new;
    insert into sponsor_watchers (card_id, user_id) values (v_new, auth.uid()) on conflict do nothing;
    insert into attachments (sponsor_card_id, path, url, file_name, size, mime, label, uploaded_by, uploaded_by_name, created_at)
    select v_new, path, url, file_name, size, mime, label, uploaded_by, uploaded_by_name, created_at from attachments where sponsor_card_id = v_old.id;
    v_was := concat_ws(' ', nullif(v_old.car, ''), case when v_old.season <> '' then '(' || v_old.season || ')' end);
    perform log_sponsor_activity(v_new, 'renewed', case when coalesce(v_was, '') <> '' then format('Asking again; they sponsored %s.', v_was) else 'Asking again.' end);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;


-- ---------------------------------------------------------------------------
-- The same sponsor across cards
-- ---------------------------------------------------------------------------
/** Put cards in one sponsor group (p_key: the group's key), or give one its own ('' + one id unlinks it). */
create or replace function public.set_sponsor_key(p_ids uuid[], p_key text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('sponsors.edit');
  update sponsor_cards set sponsor_key = left(trim(coalesce(p_key, '')), 200), updated_at = now() where id = any(p_ids);
end;
$$;


-- ---------------------------------------------------------------------------
-- Claiming a card and logging contact (anyone who can see the board)
-- ---------------------------------------------------------------------------
/** "I'm reaching out" (p_on) or "not anymore". You become the lead and watch it. */
create or replace function public.claim_sponsor_card(p_id uuid, p_on boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_card sponsor_cards;
begin
  if not (has_permission('sponsors.edit') or has_permission('sponsors.view')) then
    raise exception 'Your role does not allow this action (sponsors.view).';
  end if;
  select * into v_card from sponsor_cards where id = p_id for update;
  if not found then raise exception 'That card was deleted by someone else.'; end if;
  if p_on then
    if v_card.owner_id = auth.uid() then return; end if;
    if v_card.owner_id is not null then
      raise exception '% is already reaching out to %. Ask them, or the Business Coordinator, first.',
        coalesce((select full_name from profiles where id = v_card.owner_id), 'Someone'), v_card.name;
    end if;
    update sponsor_cards set owner_id = auth.uid(), updated_at = now() where id = p_id;
    insert into sponsor_watchers (card_id, user_id) values (p_id, auth.uid()) on conflict do nothing;
    perform log_sponsor_activity(p_id, 'claimed', 'is reaching out to them');
    perform notify_sponsor_watchers(p_id, format('%s is reaching out to them', coalesce(my_display_name(), 'Someone')));
  else
    if v_card.owner_id is distinct from auth.uid() then raise exception 'You aren''t the one reaching out to them.'; end if;
    update sponsor_cards set owner_id = null, updated_at = now() where id = p_id;
    perform log_sponsor_activity(p_id, 'claimed', 'isn''t reaching out to them anymore');
    perform notify_sponsor_watchers(p_id, format('%s isn''t reaching out to them anymore', coalesce(my_display_name(), 'Someone')));
  end if;
end;
$$;

/**
 * "I contacted them": sets the date contacted, adds the note to the history, and
 * moves a card still in the first stage to Contacted (the second stage). For the
 * card's lead, or anyone who can edit sponsors.
 */
create or replace function public.log_sponsor_contact(p_id uuid, p_date date, p_note text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_card   sponsor_cards;
  v_stages jsonb := (select value -> 'stages' from app_settings where key = 'sponsors');
  v_to     text;
  v_date   date := coalesce(p_date, current_date);
  v_note   text := left(trim(coalesce(p_note, '')), 5000);
begin
  select * into v_card from sponsor_cards where id = p_id for update;
  if not found then raise exception 'That card was deleted by someone else.'; end if;
  if not (has_permission('sponsors.edit') or (v_card.owner_id = auth.uid() and has_permission('sponsors.view'))) then
    raise exception 'Only whoever is reaching out to them (the lead) or the Business Coordinator can log this.';
  end if;
  if v_date > current_date then raise exception 'The date contacted can''t be in the future.'; end if;
  update sponsor_cards set contacted_on = greatest(coalesce(contacted_on, v_date), v_date), updated_at = now() where id = p_id;
  perform log_sponsor_activity(p_id, 'contacted', concat_ws(': ', 'Contacted them' || case when v_date <> current_date then ' on ' || to_char(v_date, 'Mon FMDD') else '' end, nullif(v_note, '')));
  if v_card.stage = v_stages -> 0 ->> 'key' then
    v_to := coalesce((select s ->> 'key' from jsonb_array_elements(v_stages) s where s ->> 'key' = 'contacted'), v_stages -> 1 ->> 'key');
    if v_to is not null and v_to <> v_card.stage then
      update sponsor_cards set stage = v_to where id = p_id;
      perform log_sponsor_activity(p_id, 'moved', '', v_card.stage, v_to);
    end if;
  end if;
  perform notify_sponsor_watchers(p_id, concat_ws(': ', 'contacted them', nullif(left(v_note, 300), '')));
end;
$$;


-- ---------------------------------------------------------------------------
-- Tags: rename or merge across every card
-- ---------------------------------------------------------------------------
/** Rename p_from to p_to on every card (merging if p_to is already used); p_to '' removes it. Returns cards changed. */
create or replace function public.rename_sponsor_tag(p_from text, p_to text)
returns integer
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_to text := left(trim(coalesce(p_to, '')), 40);
  v_n  integer;
begin
  perform require_permission('sponsors.edit');
  update sponsor_cards set
    tags = coalesce((select array_agg(distinct t) from unnest(array_replace(tags, p_from, nullif(v_to, ''))) t where t is not null), '{}'),
    updated_at = now()
  where p_from = any(tags);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;


-- ---------------------------------------------------------------------------
-- Importing (026) also fills priority, category and date contacted
-- ---------------------------------------------------------------------------
create or replace function public.import_sponsor_cards(p_cards jsonb, p_source text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  c        jsonb;
  v_id     uuid;
  v_ids    uuid[] := '{}';
  v_skip   text[] := '{}';
  v_name   text;
  v_season text;
  v_car    text;
  v_stage  text;
  v_email  text;
  v_amount text;
  v_desc   text;
  v_lead   uuid;
  v_pos    double precision := (select coalesce(max(position), 0) from sponsor_cards);
  v_first  text := (select value -> 'stages' -> 0 ->> 'key' from app_settings where key = 'sponsors');
  v_source text := left(trim(coalesce(p_source, '')), 120);
begin
  perform require_permission('sponsors.edit');
  if jsonb_typeof(p_cards) <> 'array' then raise exception 'Nothing to import.'; end if;
  if jsonb_array_length(p_cards) > 2000 then raise exception 'That''s more than 2000 sponsors. Split the file and import it in parts.'; end if;

  for c in select * from jsonb_array_elements(p_cards) loop
    v_name := left(trim(coalesce(c ->> 'name', '')), 120);
    continue when v_name = '';
    v_season := left(trim(coalesce(c ->> 'season', '')), 9);
    v_car := left(trim(coalesce(c ->> 'car', '')), 40);
    if exists (select 1 from sponsor_cards where lower(name) = lower(v_name) and season = v_season and car = v_car and not id = any(v_ids)) then
      v_skip := array_append(v_skip, v_name);
      continue;
    end if;

    v_stage := c ->> 'stage';
    if v_stage is null or not exists (
      select 1 from app_settings, jsonb_array_elements(value -> 'stages') s where key = 'sponsors' and s ->> 'key' = v_stage) then
      v_stage := v_first;
    end if;
    v_desc := left(coalesce(c ->> 'description', ''), 20000);
    v_email := trim(coalesce(c ->> 'contact_email', ''));
    if v_email <> '' and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      v_desc := concat_ws(E'\n', nullif(v_desc, ''), 'Contact email: ' || v_email);
      v_email := '';
    end if;
    v_amount := nullif(trim(coalesce(c ->> 'amount', '')), '');
    if v_amount is not null and v_amount !~ '^-?\d{1,10}(\.\d{1,2})?$' then
      v_desc := concat_ws(E'\n', nullif(v_desc, ''), 'Amount: ' || v_amount);
      v_amount := null;
    end if;
    v_lead := null;
    if trim(coalesce(c ->> 'lead', '')) <> '' then
      select min(id::text)::uuid into v_lead from profiles where lower(trim(full_name)) = lower(trim(c ->> 'lead'))
      having count(*) = 1;
    end if;

    v_pos := v_pos + 1;
    insert into sponsor_cards (name, stage, position, season, car, kind, amount, priority, category, contacted_on, owner_id,
                               contact_name, contact_email, contact_phone, website, tags, description, playbook, follow_up, created_by)
    values (
      v_name, v_stage, v_pos, v_season, v_car, left(trim(coalesce(c ->> 'kind', '')), 60), v_amount::numeric,
      case when coalesce(c ->> 'priority', '') ~ '^[1-5]$' then (c ->> 'priority')::smallint end,
      left(trim(coalesce(c ->> 'category', '')), 80),
      case when coalesce(c ->> 'contacted_on', '') ~ '^\d{4}-\d{2}-\d{2}$' and (c ->> 'contacted_on')::date <= current_date then (c ->> 'contacted_on')::date end,
      v_lead,
      left(trim(coalesce(c ->> 'contact_name', '')), 200), v_email, left(trim(coalesce(c ->> 'contact_phone', '')), 200),
      left(trim(coalesce(c ->> 'website', '')), 500),
      coalesce((select array_agg(distinct left(trim(t), 40)) from jsonb_array_elements_text(coalesce(c -> 'tags', '[]')) t where trim(t) <> ''), '{}'),
      v_desc, left(coalesce(c ->> 'playbook', ''), 20000),
      case when coalesce(c ->> 'follow_up', '') ~ '^\d{4}-\d{2}-\d{2}$' then (c ->> 'follow_up')::date end,
      auth.uid())
    returning id into v_id;
    v_ids := array_append(v_ids, v_id);
    perform log_sponsor_activity(v_id, 'created', case when v_source <> '' then 'Imported from ' || v_source else 'Imported' end);
  end loop;

  return jsonb_build_object('added', cardinality(v_ids), 'skipped', to_jsonb(v_skip));
end;
$$;


-- ---------------------------------------------------------------------------
-- Cards imported by 026: "**Priority:** 1" and "**Date contacted:** 2026-09-24" become fields
-- ---------------------------------------------------------------------------
update sponsor_cards set priority = substring(description from '\*\*Priority:\*\* ([1-5])\s*(?:\n|$)')::smallint
where priority is null and description ~ '\*\*Priority:\*\* [1-5]\s*(\n|$)';
update sponsor_cards set contacted_on = substring(description from '\*\*Date contacted:\*\* (\d{4}-\d{2}-\d{2})')::date
where contacted_on is null and description ~ '\*\*Date contacted:\*\* \d{4}-\d{2}-\d{2}';
update sponsor_cards set description = btrim(regexp_replace(regexp_replace(description,
    '(^|\n)\*\*Priority:\*\* [1-5][ \t]*(?=\n|$)', '', 'g'),
    '(^|\n)\*\*Date contacted:\*\* \d{4}-\d{2}-\d{2}[ \t]*(?=\n|$)', '', 'g'), E'\n')
where description ~ '\*\*(Priority|Date contacted):\*\*';

revoke execute on function
  public.ask_sponsors_again(uuid[], text, text), public.set_sponsor_key(uuid[], text), public.claim_sponsor_card(uuid, boolean),
  public.log_sponsor_contact(uuid, date, text), public.rename_sponsor_tag(text, text)
from public, anon;
grant execute on function
  public.ask_sponsors_again(uuid[], text, text), public.set_sponsor_key(uuid[], text), public.claim_sponsor_card(uuid, boolean),
  public.log_sponsor_contact(uuid, date, text), public.rename_sponsor_tag(text, text)
to authenticated;

update app_settings set value = jsonb_set(value, '{schemaVersion}', '27') where key = 'general';
