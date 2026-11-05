-- =============================================================================
-- 029: OneSolar home screen — which cards show, and for whom
-- =============================================================================
-- Run once, after 028: Supabase → SQL Editor → New query → paste → Run.
--
--   * Settings key "onesolar" holds the home screen's card choices:
--       { "cards": { "<app id>": { "show": "default" | "everyone" | "signedIn" | "roles" | "hidden",
--                                  "roles": ["ce", "treasurer", …] } } }
--     "default" (or no entry) follows the home page's own list (js/apps.js).
--   * Saving needs "Customize the site" (site.customize), like Appearance.
--   * Anyone can read it, signed in or not, so the signed-out home screen
--     follows it too. It holds no private data.
-- =============================================================================

create or replace function public.validate_onesolar_settings(p_value jsonb)
returns void
language plpgsql immutable set search_path = public, pg_temp
as $$
declare
  v_id   text;
  v_card jsonb;
begin
  if coalesce(jsonb_typeof(p_value -> 'cards'), 'object') <> 'object' then
    raise exception 'OneSolar cards must be an object.';
  end if;
  for v_id, v_card in select * from jsonb_each(coalesce(p_value -> 'cards', '{}')) loop
    if v_id !~ '^[a-z0-9][a-z0-9_-]{0,39}$' then
      raise exception 'Bad app id "%".', v_id;
    end if;
    if jsonb_typeof(v_card) <> 'object' or coalesce(v_card ->> 'show', 'default') not in ('default', 'everyone', 'signedIn', 'roles', 'hidden') then
      raise exception 'Choose who sees the % card.', v_id;
    end if;
    if coalesce(jsonb_typeof(v_card -> 'roles'), 'array') <> 'array' then
      raise exception 'The roles for the % card must be a list.', v_id;
    end if;
    if v_card ->> 'show' = 'roles' and coalesce(jsonb_array_length(v_card -> 'roles'), 0) = 0 then
      raise exception 'Pick at least one position for the % card, or hide it.', v_id;
    end if;
  end loop;
end;
$$;

create or replace function public.update_settings(p_key text, p_value jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_locked jsonb;
begin
  if p_key in ('general', 'form') then
    perform require_permission('settings.edit');
  elsif p_key in ('lists', 'appearance', 'layout', 'exports', 'onesolar') then
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
  if p_key = 'onesolar' then
    perform validate_onesolar_settings(p_value);
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

drop policy if exists "public onesolar" on public.app_settings;
create policy "public onesolar" on public.app_settings for select to anon using (key = 'onesolar');

-- The home screen's Customize panel lists the positions; roles are only readable when signed in (001).
revoke execute on function public.validate_onesolar_settings(jsonb) from public, anon, authenticated;

update app_settings set value = jsonb_set(value, '{schemaVersion}', '29') where key = 'general';
