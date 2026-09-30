-- =============================================================================
-- 006 — Seasons
--
--   * requests.season: every request belongs to a season (existing ones get
--     the current season, e.g. 2026-2027).
--   * Request numbers restart each season. The current season keeps its
--     numbering (SG-001, SG-002, …); after "Start new season" they look like
--     SG27-001, SG27-002, …
--   * start_new_season(): the only way to change the season, so numbering,
--     the Requests tab, and the Archive always agree.
--
-- Run once, after 005: Supabase → SQL Editor → New query → paste → Run.
-- =============================================================================

create or replace function public.current_season()
returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce((select value ->> 'season' from app_settings where key = 'general'), '');
$$;

alter table public.requests add column season text;
update public.requests set season = public.current_season() where season is null;
alter table public.requests alter column season set default public.current_season();
alter table public.requests alter column season set not null;
create index requests_season_idx on public.requests (season);


-- One counter per season. The current season continues from the old sequence.
create table public.request_counters (
  season  text primary key,
  last    int not null default 0
);
alter table public.request_counters enable row level security;
revoke all on public.request_counters from anon, authenticated;

insert into public.request_counters (season, last)
select public.current_season(), case when is_called then last_value::int else 0 end
from public.request_number_seq;

-- "SG-001" this season; "SG27-001" after starting 2027-2028. The prefix for the
-- current season is general.seasonPrefix (set by start_new_season), falling back
-- to general.requestIdPrefix.
create or replace function public.next_request_number()
returns text
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  v_general jsonb := (select value from app_settings where key = 'general');
  v_season  text := coalesce(v_general ->> 'season', '');
  v_prefix  text := coalesce(nullif(v_general ->> 'seasonPrefix', ''), nullif(v_general ->> 'requestIdPrefix', ''), 'SG');
  v_n       int;
begin
  insert into request_counters (season, last) values (v_season, 1)
  on conflict (season) do update set last = request_counters.last + 1
  returning last into v_n;
  return v_prefix || '-' || lpad(v_n::text, 3, '0');
end;
$$;


-- Start a new season, e.g. '2027-2028'. Returns the new ID prefix (e.g. 'SG27').
create or replace function public.start_new_season(p_season text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_general jsonb;
  v_current text;
  v_new     text := trim(coalesce(p_season, ''));
  v_start   int;
  v_prefix  text;
begin
  perform require_permission('settings.edit');
  if v_new !~ '^\d{4}-\d{4}$' or split_part(v_new, '-', 2)::int <> split_part(v_new, '-', 1)::int + 1 then
    raise exception 'Enter the season as YYYY-YYYY, e.g. 2027-2028.';
  end if;

  select value into v_general from app_settings where key = 'general' for update;
  v_current := coalesce(v_general ->> 'season', '');
  if v_current ~ '^\d{4}-\d{4}$' and split_part(v_new, '-', 1)::int <= split_part(v_current, '-', 1)::int then
    raise exception 'The new season must come after the current one (%).', v_current;
  end if;
  if exists (select 1 from requests where season = v_new) then
    raise exception 'There are already requests in %.', v_new;
  end if;

  v_start := split_part(v_new, '-', 1)::int;
  v_prefix := coalesce(nullif(v_general ->> 'requestIdPrefix', ''), 'SG') || right(v_start::text, 2);

  update app_settings
     set value = v_general || jsonb_build_object('season', v_new, 'seasonPrefix', v_prefix),
         updated_at = now(), updated_by = auth.uid()
   where key = 'general';
  insert into request_counters (season, last) values (v_new, 0) on conflict (season) do nothing;
  return v_prefix;
end;
$$;


-- update_settings: same as 002, but the season (and its prefix) can only be
-- changed by start_new_season, and the schema version only by migrations.
create or replace function public.update_settings(p_key text, p_value jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_locked jsonb;
begin
  perform require_permission('settings.edit');
  if p_key not in ('general', 'form') then
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


revoke execute on function public.current_season() from public, anon, authenticated;
revoke execute on function public.start_new_season(text) from public, anon;
grant execute on function public.start_new_season(text) to authenticated;

update public.app_settings set value = value || '{"schemaVersion": 6}' where key = 'general';
