-- =============================================================================
-- 012 — Link imported requests to people's accounts by name
--
-- Requests imported from an Excel sheet only have the requester's name, so
-- they didn't show under "My requests" and their requester got no
-- notifications. Now a request with no account attached is linked to the
-- person whose profile name matches its Requester name (ignoring case, extra
-- spaces and punctuation): full name, first + last, "Bella N" = "Bella Nguyen",
-- or "Josh" = the only Josh. Only when exactly one person matches, so shared
-- names are left alone.
-- It happens now, whenever someone signs up or changes their name on
-- My account, and whenever requests are imported.
--
-- Run once, after 011: Supabase → SQL Editor → New query → paste → Run.
-- =============================================================================

-- Set when a lead picks the account by hand; automatic matching then leaves it alone.
alter table public.requests add column owner_set_by_hand boolean not null default false;

-- "Austin  J. Stang" → "austin j stang"
create or replace function public.name_key(p_name text)
returns text
language sql immutable set search_path = public, pg_temp
as $$
  select trim(regexp_replace(regexp_replace(lower(coalesce(p_name, '')), '[^a-z ]', ' ', 'g'), '\s+', ' ', 'g'));
$$;

-- "austin j stang" → "austin stang"
create or replace function public.first_last_key(p_name text)
returns text
language sql immutable set search_path = public, pg_temp
as $$
  select case when position(' ' in name_key(p_name)) > 0
    then split_part(name_key(p_name), ' ', 1) || ' ' || regexp_replace(name_key(p_name), '^.* ', '')
    else name_key(p_name) end;
$$;

/**
 * The one profile whose name matches, or null. Tries, in order, stopping at the
 * first step that finds anyone (and giving up if that step finds several):
 *   1. same full name           "Austin Stang"   = "Austin Stang"
 *   2. same first + last name   "Austin J Stang" = "Austin Stang"
 *   3. first name + initial     "Bella N"        = "Bella Nguyen"
 *   4. first name only          "Josh"           = "Josh Weiss"
 */
create or replace function public.profile_for_name(p_name text)
returns uuid
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_key   text := name_key(p_name);
  v_first text := split_part(name_key(p_name), ' ', 1);
  v_rest  text := case when position(' ' in name_key(p_name)) > 0 then regexp_replace(name_key(p_name), '^.* ', '') else '' end;
  v_ids   uuid[];
  v_step  int;
begin
  if v_key = '' then return null; end if;
  for v_step in 1..4 loop
    select array_agg(p.id) into v_ids
    from profiles p, lateral (select name_key(p.full_name) k) n
    where n.k <> '' and case v_step
      when 1 then n.k = v_key
      when 2 then v_rest <> '' and position(' ' in n.k) > 0 and first_last_key(p.full_name) = first_last_key(p_name)
      when 3 then length(v_rest) = 1 and split_part(n.k, ' ', 1) = v_first and position(' ' in n.k) > 0
                  and left(regexp_replace(n.k, '^.* ', ''), 1) = v_rest
      else v_rest = '' and split_part(n.k, ' ', 1) = v_first
    end;
    if cardinality(v_ids) = 1 then return v_ids[1]; end if;
    if cardinality(v_ids) > 1 then return null; end if; -- ambiguous: don't guess
  end loop;
  return null;
end;
$$;

/** Link unowned requests to their requester's account. Returns how many were linked. */
create or replace function public.link_requests_by_name()
returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  update requests r set created_by = profile_for_name(r.requester)
  where r.created_by is null and not r.owner_set_by_hand and profile_for_name(r.requester) is not null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- A request's page (leads): choose whose account a request belongs to, or none.
-- Fixes a wrong or missing automatic match; it's never changed automatically again.
create or replace function public.set_request_owner(p_id uuid, p_user_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not (has_permission('request.review') or has_permission('request.order') or has_permission('settings.edit')) then
    raise exception 'Your role does not allow changing whose request this is.';
  end if;
  if p_user_id is not null and not exists (select 1 from profiles where id = p_user_id) then
    raise exception 'That person no longer has an account.';
  end if;
  update requests set created_by = p_user_id, owner_set_by_hand = true, updated_at = now() where id = p_id;
  if not found then raise exception 'Request not found.'; end if;
end;
$$;

-- New request without an account (i.e. imported): link it right away.
create or replace function public.link_new_request()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.created_by is null then new.created_by := profile_for_name(new.requester); end if;
  return new;
end;
$$;
create trigger requests_link_by_name
  before insert on public.requests
  for each row execute function public.link_new_request();

-- Someone signs up or fixes their name: pick up their old requests.
create or replace function public.link_after_profile_change()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform link_requests_by_name();
  return null;
end;
$$;
create trigger profiles_link_requests
  after insert or update of full_name on public.profiles
  for each row execute function public.link_after_profile_change();

revoke execute on function
  public.profile_for_name(text),
  public.link_requests_by_name(),
  public.link_new_request(),
  public.link_after_profile_change()
from public, anon, authenticated;
revoke execute on function public.set_request_owner(uuid, uuid) from public, anon;
grant execute on function public.set_request_owner(uuid, uuid) to authenticated;

select public.link_requests_by_name();

update public.app_settings set value = value || '{"schemaVersion": 12}' where key = 'general';
