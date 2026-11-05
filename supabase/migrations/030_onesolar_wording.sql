-- =============================================================================
-- 030: OneSolar wording — "OneSolar account" instead of "Order Form account"
-- =============================================================================
-- Run once, after 029: Supabase → SQL Editor → New query → paste → Run.
--
--   * The Order Form's accounts are now called OneSolar accounts (one account
--     for every Solar Gators app). Solar Evals' sharing message says so too.
--     Same as 028 otherwise.
-- =============================================================================

/** Draft ⇄ Finished ⇄ Shared. Sharing needs a OneSolar account with the member's email. */
create or replace function public.eval_set_status(p_id uuid, p_status text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare e evals; v_member uuid;
begin
  perform require_permission('evals.write');
  select * into e from evals where id = p_id;
  if e.id is null then raise exception 'That eval no longer exists.'; end if;
  if e.evaluator_id is distinct from auth.uid() then raise exception 'Only the CE who wrote this eval can do that.'; end if;
  if p_status not in ('draft', 'final', 'shared') then raise exception 'Unknown status "%".', p_status; end if;

  if p_status = 'final' and trim(e.member_name) = '' then
    raise exception 'Add the member''s name first.';
  end if;
  if p_status = 'shared' then
    if e.status = 'draft' then raise exception 'Mark the eval finished before sharing it.'; end if;
    select id into v_member from profiles where lower(email) = e.member_email and e.member_email <> '' limit 1;
    if v_member is null then
      raise exception 'Nobody has a OneSolar account with the email "%" yet. Ask them to create one, then share again.', e.member_email;
    end if;
  end if;

  update evals set
    status       = p_status,
    finalized_at = case when p_status = 'draft' then null when e.finalized_at is null then now() else e.finalized_at end,
    shared_at    = case when p_status = 'shared' then now() else null end,
    member_id    = case when p_status = 'shared' then v_member else null end,
    updated_at   = now()
  where id = p_id;
end;
$$;

update app_settings set value = jsonb_set(value, '{schemaVersion}', '30') where key = 'general';
