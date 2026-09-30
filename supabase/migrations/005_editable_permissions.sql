-- =============================================================================
-- 005 — Editable permissions
--
--   * permissions: the list of abilities (with labels for the website).
--   * set_role_permissions(): users with `users.manage` can change what each
--     role is allowed to do from Admin → Users & roles.
--   * set_user_role(): you can now change your own role too.
--   * Lockout protection: any change is refused if afterwards nobody would be
--     able to manage users.
--
-- Run once, after 004: Supabase → SQL Editor → New query → paste → Run.
-- =============================================================================

create table public.permissions (
  key          text primary key,
  label        text not null,
  description  text not null default '',
  sort         int not null default 0
);

insert into public.permissions (key, label, description, sort) values
  ('request.review', 'Approve requests',     'Approve, reject, or request changes on submitted requests.', 1),
  ('request.order',  'Order & receive',      'Mark requests Ordered and Received, and adjust prices and shipping.', 2),
  ('settings.edit',  'Edit form & settings', 'Change form fields, subsystems, team settings, and import spreadsheets.', 3),
  ('users.manage',   'Manage people',        'Change anyone''s role, and what each role is allowed to do.', 4);

alter table public.role_permissions
  add constraint role_permissions_permission_fkey
  foreign key (permission) references public.permissions(key) on delete cascade;

alter table public.permissions enable row level security;
create policy "signed-in read" on public.permissions for select to authenticated using (true);
revoke all on public.permissions from anon, authenticated;
grant select on public.permissions to authenticated;


-- Refuse a change that would leave nobody able to manage users.
create or replace function public.assert_someone_can_manage_users()
returns void
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from profiles p join role_permissions rp on rp.role = p.role
    where rp.permission = 'users.manage'
  ) then
    raise exception 'At least one person must keep the "Manage people" permission, or nobody could change roles again.';
  end if;
end;
$$;


-- Change anyone's role, including your own (with lockout protection).
create or replace function public.set_user_role(p_user_id uuid, p_role text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('users.manage');
  if not exists (select 1 from roles where key = p_role) then
    raise exception 'Unknown role "%".', p_role;
  end if;
  update profiles set role = p_role where id = p_user_id;
  if not found then raise exception 'User not found.'; end if;
  perform assert_someone_can_manage_users();
end;
$$;


-- Replace what one role is allowed to do.
create or replace function public.set_role_permissions(p_role text, p_permissions text[])
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_unknown text;
begin
  perform require_permission('users.manage');
  if not exists (select 1 from roles where key = p_role) then
    raise exception 'Unknown role "%".', p_role;
  end if;
  select p into v_unknown from unnest(coalesce(p_permissions, '{}')) p
  where p not in (select key from permissions) limit 1;
  if v_unknown is not null then
    raise exception 'Unknown permission "%".', v_unknown;
  end if;

  delete from role_permissions where role = p_role;
  insert into role_permissions (role, permission)
  select distinct p_role, p from unnest(coalesce(p_permissions, '{}')) p;

  perform assert_someone_can_manage_users();
end;
$$;


-- Save the whole grid at once: { "ce": ["request.review", ...], "treasurer": [...] }.
-- All roles change together (or none do), and the lockout check runs on the end result,
-- so moving "Manage people" from one role to another works.
create or replace function public.set_permission_matrix(p_matrix jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_role  text;
  v_perms jsonb;
  v_unknown text;
begin
  perform require_permission('users.manage');
  if coalesce(jsonb_typeof(p_matrix), '') <> 'object' then raise exception 'Nothing to save.'; end if;

  for v_role, v_perms in select * from jsonb_each(p_matrix) loop
    if not exists (select 1 from roles where key = v_role) then raise exception 'Unknown role "%".', v_role; end if;
    if coalesce(jsonb_typeof(v_perms), '') <> 'array' then raise exception 'Permissions for "%" must be a list.', v_role; end if;
    select p into v_unknown from jsonb_array_elements_text(v_perms) p where p not in (select key from permissions) limit 1;
    if v_unknown is not null then raise exception 'Unknown permission "%".', v_unknown; end if;

    delete from role_permissions where role = v_role;
    insert into role_permissions (role, permission)
    select distinct v_role, p from jsonb_array_elements_text(v_perms) p;
  end loop;

  perform assert_someone_can_manage_users();
end;
$$;


revoke execute on function public.assert_someone_can_manage_users() from public, anon, authenticated;
revoke execute on function public.set_role_permissions(text, text[]), public.set_permission_matrix(jsonb) from public, anon;
grant execute on function public.set_role_permissions(text, text[]), public.set_permission_matrix(jsonb) to authenticated;

update public.app_settings set value = value || '{"schemaVersion": 5}' where key = 'general';
