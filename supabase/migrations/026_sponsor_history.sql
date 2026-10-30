-- =============================================================================
-- 026: Sponsor history — which car, and importing old sponsor spreadsheets
-- =============================================================================
-- Run once, after 025: Supabase → SQL Editor → New query → paste → Run.
--
--   * Sponsor cards get a Car (e.g. "Sunrider", "Flare", "Blaze"), so the
--     sponsors of earlier cars can be kept next to the current ones and found
--     by car in All sponsors. Renewing a card keeps its car.
--   * import_sponsor_cards adds many cards at once from a spreadsheet (Sponsors
--     › Import from spreadsheet…). Imported cards have no watchers (nobody gets
--     messages about old sponsors), skip sponsors already on the board with the
--     same name, car and season, and say which file they came from.
-- =============================================================================

alter table public.sponsor_cards add column if not exists car text not null default '';


-- ---------------------------------------------------------------------------
-- Saving a card: same as 015, plus car
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
    car           = case when p_fields ? 'car' then left(trim(p_fields ->> 'car'), 40) else car end,
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
    if v_new.car is distinct from v_old.car then v_changed := array_append(v_changed, 'car'); end if;
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
-- Renewing keeps the car (same as 017 otherwise)
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
  insert into sponsor_cards (name, stage, position, season, car, kind, amount, owner_id, contact_name, contact_email, contact_phone,
                             website, tags, description, playbook, renewed_from, created_by)
  select name, (select value -> 'stages' -> 0 ->> 'key' from app_settings where key = 'sponsors'),
         (select coalesce(max(position), 0) + 1 from sponsor_cards), trim(p_season), car, kind, amount, owner_id,
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
-- Importing many cards at once
-- ---------------------------------------------------------------------------
/**
 * p_cards: [{ name, stage, season, car, kind, amount, contact_name, contact_email,
 * contact_phone, website, tags, description, playbook, follow_up, lead }], where
 * lead is a person's name: it becomes the card's lead if exactly one person on the
 * site has that name. Bad emails and amounts are kept in the description instead
 * of failing the whole import. Returns { added, skipped: [names already there] }.
 */
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
    -- Already on the board from before this import (the same sponsor twice in one file is kept: e.g. two gifts).
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
    insert into sponsor_cards (name, stage, position, season, car, kind, amount, owner_id, contact_name, contact_email, contact_phone,
                               website, tags, description, playbook, follow_up, created_by)
    values (
      v_name, v_stage, v_pos, v_season, v_car, left(trim(coalesce(c ->> 'kind', '')), 60), v_amount::numeric, v_lead,
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

revoke execute on function public.import_sponsor_cards(jsonb, text) from public, anon;
grant execute on function public.import_sponsor_cards(jsonb, text) to authenticated;

update app_settings set value = jsonb_set(value, '{schemaVersion}', '26') where key = 'general';
