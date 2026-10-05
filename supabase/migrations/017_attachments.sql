-- =============================================================================
-- 017: Files & links on sponsor cards, requests and Finances rows.
--
--   * attachments: one row per file or link, belonging to exactly one sponsor
--     card, request or Finances row (deleted with it). Files live in a private
--     Supabase Storage bucket, "attachments", at <kind>/<owner id>/<random>-<name>.
--   * Who can see / add:
--       sponsor cards  — See sponsors / Edit sponsors
--       requests       — everyone signed in sees them; the requester and leads add
--       Finances rows  — See finances / Edit finances
--     Anyone who added a file can also remove it.
--   * Renewing a sponsor card for next season keeps its files (same file, linked
--     to both cards); the file is only removed from storage when the last link goes.
--
-- Run once, after 016: Supabase → SQL Editor → New query → paste → Run.
-- (It also creates the storage bucket and its rules; nothing to click in Storage.)
-- =============================================================================

create table public.attachments (
  id               uuid primary key default gen_random_uuid(),
  sponsor_card_id  uuid references public.sponsor_cards(id) on delete cascade,
  request_id       uuid references public.requests(id) on delete cascade,
  finance_row_id   uuid references public.finance_rows(id) on delete cascade,
  path             text,                       -- storage object name; null for a link
  url              text,                       -- for links (Drive folder, Canva…); null for a file
  file_name        text not null default '',
  size             bigint,
  mime             text not null default '',
  label            text not null default '',
  uploaded_by      uuid references public.profiles(id) on delete set null,
  uploaded_by_name text not null default '',
  created_at       timestamptz not null default now(),
  check (num_nonnulls(sponsor_card_id, request_id, finance_row_id) = 1),
  check ((path is null) <> (url is null)),
  check (url is null or url ~ '^https?://\S+$'),
  check (size is null or size <= 10485760)
);
create index attachments_sponsor_idx on public.attachments (sponsor_card_id) where sponsor_card_id is not null;
create index attachments_request_idx on public.attachments (request_id) where request_id is not null;
create index attachments_finance_idx on public.attachments (finance_row_id) where finance_row_id is not null;
create index attachments_path_idx on public.attachments (path) where path is not null;

/** Can the signed-in person see / change the files of this owner? kind: sponsor | request | finance */
create or replace function public.attachment_access(p_kind text, p_owner uuid, p_edit boolean)
returns boolean
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then return false; end if;
  if p_kind = 'sponsor' then
    return has_permission('sponsors.edit') or (not p_edit and has_permission('sponsors.view'));
  elsif p_kind = 'request' then
    return not p_edit
      or has_permission('request.review') or has_permission('request.order')
      or exists (select 1 from requests where id = p_owner and created_by = auth.uid());
  elsif p_kind = 'finance' then
    return has_permission('finances.edit') or (not p_edit and has_permission('finances.view'));
  end if;
  return false;
end;
$$;

create or replace function public.attachment_kind(a attachments)
returns text language sql immutable as $$
  select case when a.sponsor_card_id is not null then 'sponsor' when a.request_id is not null then 'request' else 'finance' end;
$$;

alter table public.attachments enable row level security;
create policy "attachment readers" on public.attachments for select to authenticated
  using (attachment_access(attachment_kind(attachments), coalesce(sponsor_card_id, request_id, finance_row_id), false));
revoke all on public.attachments from anon, authenticated;
grant select on public.attachments to authenticated;
grant execute on function public.attachment_kind(attachments) to authenticated;

-- Sponsor cards log their files in Notes & history.
alter table public.sponsor_activity drop constraint if exists sponsor_activity_kind_check;
alter table public.sponsor_activity add constraint sponsor_activity_kind_check
  check (kind in ('created', 'moved', 'edited', 'comment', 'income', 'renewed', 'file'));

/**
 * Record a file (already uploaded to storage at p_path) or a link (p_url).
 * p_kind: sponsor | request | finance. Returns the new attachment's id.
 */
create or replace function public.add_attachment(p_kind text, p_owner uuid, p_path text, p_url text, p_file_name text, p_size bigint, p_mime text, p_label text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_kind not in ('sponsor', 'request', 'finance') then raise exception 'Unknown kind of attachment.'; end if;
  if not attachment_access(p_kind, p_owner, true) then
    raise exception 'You can''t add files here.';
  end if;
  if p_path is not null and p_path not like p_kind || '/' || p_owner || '/%' then
    raise exception 'That file was uploaded to the wrong place.';
  end if;
  if p_url is not null and p_url !~ '^https?://\S+$' then
    raise exception 'Links must start with https://';
  end if;
  insert into attachments (sponsor_card_id, request_id, finance_row_id, path, url, file_name, size, mime, label, uploaded_by, uploaded_by_name)
  values (
    case when p_kind = 'sponsor' then p_owner end,
    case when p_kind = 'request' then p_owner end,
    case when p_kind = 'finance' then p_owner end,
    p_path, nullif(trim(coalesce(p_url, '')), ''), left(coalesce(p_file_name, ''), 200), p_size, left(coalesce(p_mime, ''), 100),
    left(trim(coalesce(p_label, '')), 120), auth.uid(), coalesce(my_display_name(), ''))
  returning id into v_id;
  if p_kind = 'sponsor' then
    perform log_sponsor_activity(p_owner, 'file', format('Added %s "%s".', case when p_url is null then 'the file' else 'the link' end,
      coalesce(nullif(trim(p_label), ''), nullif(p_file_name, ''), p_url)));
  end if;
  return v_id;
end;
$$;

/** Remove a file or link. Returns the storage path when nothing else uses that file (so the website deletes it), else null. */
create or replace function public.delete_attachment(p_id uuid)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_a attachments;
begin
  select * into v_a from attachments where id = p_id;
  if not found then return null; end if;
  if v_a.uploaded_by is distinct from auth.uid()
     and not attachment_access(attachment_kind(v_a), coalesce(v_a.sponsor_card_id, v_a.request_id, v_a.finance_row_id), true) then
    raise exception 'You can''t remove this file.';
  end if;
  delete from attachments where id = p_id;
  if v_a.sponsor_card_id is not null then
    perform log_sponsor_activity(v_a.sponsor_card_id, 'file', format('Removed "%s".', coalesce(nullif(v_a.label, ''), nullif(v_a.file_name, ''), v_a.url)));
  end if;
  if v_a.path is not null and not exists (select 1 from attachments where path = v_a.path) then return v_a.path; end if;
  return null;
end;
$$;

/** How many files each owner of a kind has, as { owner id: count } (for the 📎 badges). */
create or replace function public.attachment_counts(p_kind text)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(jsonb_object_agg(owner, n), '{}') from (
    select coalesce(sponsor_card_id, request_id, finance_row_id) as owner, count(*) as n
    from attachments a
    where attachment_kind(a) = p_kind and attachment_access(p_kind, coalesce(sponsor_card_id, request_id, finance_row_id), false)
    group by 1
  ) x;
$$;

revoke execute on function public.attachment_access(text, uuid, boolean) from public, anon;
revoke execute on function public.add_attachment(text, uuid, text, text, text, bigint, text, text) from public, anon;
revoke execute on function public.delete_attachment(uuid), public.attachment_counts(text) from public, anon;
grant execute on function public.attachment_access(text, uuid, boolean) to authenticated;
grant execute on function public.add_attachment(text, uuid, text, text, text, bigint, text, text), public.delete_attachment(uuid), public.attachment_counts(text) to authenticated;

-- Renewing a sponsor card keeps its files and links (same as 015, plus the last insert).
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
  insert into attachments (sponsor_card_id, path, url, file_name, size, mime, label, uploaded_by, uploaded_by_name, created_at)
  select v_new, path, url, file_name, size, mime, label, uploaded_by, uploaded_by_name, created_at from attachments where sponsor_card_id = p_id;
  perform log_sponsor_activity(v_new, 'renewed', format('Renewed from the %s season.', v_old.season));
  return v_new;
end;
$$;


-- ---------------------------------------------------------------------------
-- Storage: a private bucket and who can read / upload / delete in it.
-- (Skipped where there is no Supabase Storage, e.g. the local tests.)
-- ---------------------------------------------------------------------------
do $storage$
begin
  if to_regclass('storage.buckets') is null then return; end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('attachments', 'attachments', false, 10485760, array[
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'application/pdf', 'text/plain', 'text/csv',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/postscript', 'application/illustrator', 'application/zip'])
  on conflict (id) do nothing;

  execute $p$
    create policy "attachments: read" on storage.objects for select to authenticated using (
      bucket_id = 'attachments' and exists (
        select 1 from public.attachments a where a.path = name
          and public.attachment_access(public.attachment_kind(a), coalesce(a.sponsor_card_id, a.request_id, a.finance_row_id), false)))
  $p$;
  execute $p$
    create policy "attachments: upload" on storage.objects for insert to authenticated with check (
      bucket_id = 'attachments'
      and split_part(name, '/', 2) ~ '^[0-9a-f-]{36}$'
      and public.attachment_access(split_part(name, '/', 1), split_part(name, '/', 2)::uuid, true))
  $p$;
  execute $p$
    create policy "attachments: delete" on storage.objects for delete to authenticated using (
      bucket_id = 'attachments'
      and split_part(name, '/', 2) ~ '^[0-9a-f-]{36}$'
      and public.attachment_access(split_part(name, '/', 1), split_part(name, '/', 2)::uuid, true)
      and not exists (select 1 from public.attachments a where a.path = name))
  $p$;
end
$storage$;

update public.app_settings set value = value || '{"schemaVersion": 17}' where key = 'general';
