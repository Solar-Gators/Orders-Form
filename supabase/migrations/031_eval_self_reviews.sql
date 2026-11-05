-- =============================================================================
-- 031: Solar Evals — member self-evaluations and eval meetings
-- =============================================================================
-- Run once, after 030: Supabase → SQL Editor → New query → paste → Run.
--
--   The order of a semester review:
--     1. The member fills out a self-evaluation on their division's rubric and
--        picks their CE and subsystem lead. Only they can see it while it's a
--        draft. Submitting it emails the CE.
--     2. The CE starts their own eval from it (same rubric, same header), and
--        talks to the lead on their own time; the lead's input goes into the
--        CE's eval. The CE does NOT see the member's answers yet.
--     3. Once the CE marks their eval finished, the CE (and the lead, the
--        e-board and other CEs, as before) can read the self-eval next to it.
--        The CE schedules the eval meeting; the member is emailed the time.
--     4. After the meeting the CE shares their eval: the member then reads
--        both versions (their own and the CE's) and can add comments.
--
--   A member can take a submitted self-eval back until their CE starts theirs.
--   CEs can still write an eval without a self-eval, exactly as before.
--   Messages use the "Solar Evals" event in Admin → Notifications (on by
--   default once notifications are on); people can turn it off on My account.
-- =============================================================================

alter table public.evals
  add column kind          text not null default 'ce' check (kind in ('ce', 'self')),
  add column ce_id         uuid references public.profiles(id) on delete set null,   -- self-evals: the CE it goes to
  add column self_eval_id  uuid references public.evals(id) on delete set null,      -- CE evals: the self-eval it started from
  add column meeting_at    timestamptz,
  add column meeting_place text not null default '' check (length(meeting_place) <= 200);
create unique index evals_self_link_idx on public.evals (self_eval_id) where self_eval_id is not null;
create index evals_ce_idx on public.evals (ce_id);


-- ---------------------------------------------------------------------------
-- Who sees a self-eval: the member always; once the CE's eval made from it is
-- finished, also that CE, the lead on it, and everyone with "See all evals".
-- ---------------------------------------------------------------------------
create or replace function public.eval_self_visible(p_self uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from evals c
    where c.self_eval_id = p_self and c.kind = 'ce' and c.status <> 'draft'
      and (c.evaluator_id = auth.uid() or c.lead_id = auth.uid() or has_permission('evals.view'))
  );
$$;

drop policy if exists "eval readers" on public.evals;
create policy "eval readers" on public.evals for select to authenticated using (
  case when kind = 'self' then
    evaluator_id = auth.uid() or (status <> 'draft' and eval_self_visible(id))
  else
    evaluator_id = auth.uid()
    or (status <> 'draft' and (lead_id = auth.uid() or has_permission('evals.view')))
    or (status = 'shared' and member_id = auth.uid())
  end
);


-- ---------------------------------------------------------------------------
-- Messages (email / Teams), like the Sponsors board's
-- ---------------------------------------------------------------------------
/**
 * p_kind: 'self_submitted' (to the CE), 'meeting' (to the member), 'shared' (to the member).
 * Respects Admin → Notifications and each person's choices; never messages whoever did it.
 */
create or replace function public.notify_eval(p_eval uuid, p_kind text, p_recipients uuid[])
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_settings jsonb := (select value from app_settings where key = 'notifications');
  v_ev       jsonb := v_settings -> 'events' -> 'eval_update';
  e          evals;
  v_actor    text := coalesce(my_display_name(), 'Someone');
  v_when     text;
  v_what     text;
  v_details  text;
  v_payload  jsonb;
  v_person   profiles;
begin
  if v_settings is null or (v_settings -> 'enabled') is distinct from 'true'::jsonb or v_ev is null then return; end if;
  select * into e from evals where id = p_eval;
  if e.id is null then return; end if;
  v_when := to_char(e.meeting_at at time zone 'America/New_York', 'FMDay, FMMonth FMDD "at" FMHH12:MI AM');

  if p_kind = 'self_submitted' then
    v_what := e.member_name || '''s self-eval is in';
    v_details := e.member_name || ' submitted their self-evaluation for ' || coalesce(nullif(e.semester, ''), 'this semester')
      || '. Fill out your eval for them; you''ll see their answers once yours is finished.';
  elsif p_kind = 'meeting' then
    v_what := 'Eval meeting: ' || v_when;
    v_details := v_actor || ' scheduled your eval meeting for ' || v_when
      || case when e.meeting_place <> '' then ' (' || e.meeting_place || ')' else '' end || '.';
  elsif p_kind = 'shared' then
    v_what := 'Your evaluation is ready';
    v_details := v_actor || ' shared your ' || coalesce(nullif(e.semester, ''), '') || ' evaluation. You can read it next to your self-evaluation, and add your own comments.';
  else
    return;
  end if;

  v_payload := jsonb_build_object(
    'what', v_what, 'details', regexp_replace(v_details, '\s+', ' ', 'g'), 'actor', v_actor,
    'member', e.member_name, 'semester', e.semester,
    'app_path', '/Custom-Apps/solarevals#/evals' || case when p_kind = 'self_submitted' then '' else '/' || e.id end);

  for v_person in
    select * from profiles where id = any(p_recipients) and id is distinct from auth.uid()
  loop
    if (v_ev -> 'email') = 'true'::jsonb and v_person.notify_email
       and (v_person.notify_events -> 'eval_update' -> 'email') is distinct from 'false'::jsonb then
      insert into notification_outbox (event, recipient_id, email, channel, payload)
      values ('eval_update', v_person.id, v_person.email, 'email', v_payload || jsonb_build_object('recipient_name', v_person.full_name));
    end if;
    if (v_ev -> 'teams') = 'true'::jsonb and v_person.notify_teams
       and (v_person.notify_events -> 'eval_update' -> 'teams') is distinct from 'false'::jsonb then
      insert into notification_outbox (event, recipient_id, email, channel, payload)
      values ('eval_update', v_person.id, v_person.email, 'teams', v_payload || jsonb_build_object('recipient_name', v_person.full_name));
    end if;
  end loop;
end;
$$;


-- ---------------------------------------------------------------------------
-- The member's self-evaluation
-- ---------------------------------------------------------------------------
/**
 * Start (p_id null) or update your own self-eval. Anyone signed in can write one.
 *   p: { template_id (new only), member_name, semester, division, subsystem,
 *        ce_id, lead_id, fields, ratings, answers }
 */
create or replace function public.eval_self_save(p_id uuid, p jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id   uuid := p_id;
  e      evals;
  t      eval_templates;
  v_ce   uuid := nullif(p ->> 'ce_id', '')::uuid;
  v_lead uuid := nullif(p ->> 'lead_id', '')::uuid;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if exists (select 1 from jsonb_each(coalesce(p -> 'ratings', '{}')) r
             where r.value::text not in ('1', '2', '3', '4', '5', '"NO"')) then
    raise exception 'A rating must be 1 to 5 or N/O.';
  end if;
  if p ? 'ce_id' and v_ce is not null then
    if v_ce = auth.uid() then raise exception 'Pick your CE, not yourself.'; end if;
    if not user_has_permission(v_ce, 'evals.write') then raise exception 'That person doesn''t fill out evals. Pick your CE.'; end if;
  end if;
  if v_lead is not null and not exists (select 1 from profiles where id = v_lead) then
    raise exception 'That subsystem lead''s account no longer exists.';
  end if;

  if v_id is null then
    select * into t from eval_templates where id = (p ->> 'template_id')::uuid and removed_at is null;
    if t.id is null then raise exception 'Pick your division''s rubric.'; end if;
    insert into evals (kind, template_id, template_label, rubric, evaluator_id, member_id, member_name, member_email)
    values ('self', t.id, (select name from eval_tracks where id = t.track_id) || ' · ' || t.label, t.rubric, auth.uid(), auth.uid(),
            coalesce(my_name(), ''), coalesce((select lower(email) from profiles where id = auth.uid()), ''))
    returning id into v_id;
  else
    select * into e from evals where id = v_id;
    if e.id is null or e.kind <> 'self' or e.evaluator_id is distinct from auth.uid() then
      raise exception 'Only the member who wrote this self-eval can change it.';
    end if;
    if e.status <> 'draft' then raise exception 'You''ve submitted this self-eval. Take it back to change it.'; end if;
  end if;

  update evals set
    member_name = left(coalesce(nullif(trim(p ->> 'member_name'), ''), member_name), 120),
    semester    = left(coalesce(trim(p ->> 'semester'), semester), 40),
    division    = left(coalesce(trim(p ->> 'division'), division), 80),
    subsystem   = left(coalesce(trim(p ->> 'subsystem'), subsystem), 80),
    ce_id       = case when p ? 'ce_id' then v_ce else ce_id end,
    lead_id     = case when p ? 'lead_id' then v_lead else lead_id end,
    review_date = case when p ? 'review_date' then nullif(p ->> 'review_date', '')::date else review_date end,
    fields      = coalesce(p -> 'fields', fields),
    ratings     = coalesce(p -> 'ratings', ratings),
    answers     = coalesce(p -> 'answers', answers),
    updated_at  = now()
  where id = v_id;
  return v_id;
end;
$$;

/** Submit your self-eval to your CE (p_submit true), or take it back (false) until the CE starts theirs. */
create or replace function public.eval_self_submit(p_id uuid, p_submit boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare e evals;
begin
  select * into e from evals where id = p_id;
  if e.id is null or e.kind <> 'self' or e.evaluator_id is distinct from auth.uid() then
    raise exception 'Only the member who wrote this self-eval can do that.';
  end if;
  if p_submit then
    if e.status <> 'draft' then return; end if;
    if e.ce_id is null then raise exception 'Pick your CE (Evaluating CE) first.'; end if;
    if not user_has_permission(e.ce_id, 'evals.write') then raise exception 'The CE you picked no longer fills out evals. Pick your CE again.'; end if;
    if trim(e.member_name) = '' then raise exception 'Add your name first.'; end if;
    update evals set status = 'final', finalized_at = now(), updated_at = now() where id = p_id;
    perform notify_eval(p_id, 'self_submitted', array[e.ce_id]);
  else
    if e.status = 'draft' then return; end if;
    if exists (select 1 from evals where self_eval_id = p_id) then
      raise exception 'Your CE has already started their eval, so it can''t be taken back. Ask them if something needs to change.';
    end if;
    update evals set status = 'draft', finalized_at = null, updated_at = now() where id = p_id;
  end if;
end;
$$;

/** Submitted self-evals waiting for the signed-in CE: who and when, not the answers. */
create or replace function public.eval_inbox()
returns table (self_id uuid, member_id uuid, member_name text, semester text, division text, subsystem text,
               lead_id uuid, template_label text, submitted_at timestamptz, ce_eval_id uuid, ce_status text, meeting_at timestamptz)
language sql stable security definer set search_path = public, pg_temp
as $$
  select s.id, s.evaluator_id, s.member_name, s.semester, s.division, s.subsystem,
         s.lead_id, s.template_label, s.finalized_at, c.id, c.status, s.meeting_at
  from evals s
  left join evals c on c.self_eval_id = s.id
  where s.kind = 'self' and s.status <> 'draft' and s.ce_id = auth.uid() and has_permission('evals.write')
  order by s.finalized_at desc;
$$;

/** The CE starts their eval from a self-eval sent to them (same rubric and header). Returns the existing one if already started. */
create or replace function public.eval_start_review(p_self uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare s evals; v_id uuid;
begin
  perform require_permission('evals.write');
  select * into s from evals where id = p_self;
  if s.id is null or s.kind <> 'self' or s.status = 'draft' or s.ce_id is distinct from auth.uid() then
    raise exception 'That self-eval isn''t waiting for you.';
  end if;
  select id into v_id from evals where self_eval_id = p_self;
  if v_id is not null then return v_id; end if;
  insert into evals (kind, template_id, template_label, rubric, evaluator_id, self_eval_id,
                     member_name, member_email, semester, division, subsystem, lead_id, fields)
  values ('ce', s.template_id, s.template_label, s.rubric, auth.uid(), s.id,
          s.member_name, s.member_email, s.semester, s.division, s.subsystem, s.lead_id, s.fields)
  returning id into v_id;
  return v_id;
end;
$$;

/** The CE schedules (or clears, p_at null) the eval meeting, once their eval is finished. Emails the member. */
create or replace function public.eval_schedule_meeting(p_id uuid, p_at timestamptz, p_place text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare e evals; v_member uuid;
begin
  perform require_permission('evals.write');
  select * into e from evals where id = p_id;
  if e.id is null or e.kind <> 'ce' then raise exception 'That eval no longer exists.'; end if;
  if e.evaluator_id is distinct from auth.uid() then raise exception 'Only the CE who wrote this eval can do that.'; end if;
  if e.self_eval_id is null then raise exception 'Only evals started from a member''s self-eval have a meeting.'; end if;
  if e.status = 'draft' then raise exception 'Mark your eval finished first.'; end if;
  update evals set meeting_at = p_at, meeting_place = left(trim(coalesce(p_place, '')), 200), updated_at = now()
  where id in (p_id, e.self_eval_id);
  if p_at is not null then
    select evaluator_id into v_member from evals where id = e.self_eval_id;
    perform notify_eval(e.self_eval_id, 'meeting', array[v_member]);
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- The CE's eval: same as 028/030, but self-evals are changed only by their
-- member, and an eval made from a self-eval is shared with that member.
-- ---------------------------------------------------------------------------
create or replace function public.eval_save(p_id uuid, p jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id uuid := p_id;
  v_status text;
  v_owner uuid;
  v_kind text;
  t eval_templates;
  v_lead uuid := nullif(p ->> 'lead_id', '')::uuid;
begin
  perform require_permission('evals.write');
  if exists (select 1 from jsonb_each(coalesce(p -> 'ratings', '{}')) r
             where r.value::text not in ('1', '2', '3', '4', '5', '"NO"')) then
    raise exception 'A rating must be 1 to 5 or N/O.';
  end if;
  if v_lead is not null and not exists (select 1 from profiles where id = v_lead) then
    raise exception 'That subsystem lead''s account no longer exists.';
  end if;

  if v_id is null then
    select * into t from eval_templates where id = (p ->> 'template_id')::uuid and removed_at is null;
    if t.id is null then raise exception 'Pick a rubric to start from.'; end if;
    insert into evals (template_id, template_label, rubric, evaluator_id)
    values (t.id, (select name from eval_tracks where id = t.track_id) || ' · ' || t.label, t.rubric, auth.uid())
    returning id into v_id;
  else
    select status, evaluator_id, kind into v_status, v_owner, v_kind from evals where id = v_id;
    if v_owner is distinct from auth.uid() or v_kind <> 'ce' then raise exception 'Only the CE who wrote this eval can change it.'; end if;
    if v_status = 'shared' then raise exception 'This eval is shared with the member. Stop sharing it to make changes.'; end if;
  end if;

  update evals set
    member_name  = left(coalesce(trim(p ->> 'member_name'), member_name), 120),
    member_email = left(lower(coalesce(trim(p ->> 'member_email'), member_email)), 200),
    semester     = left(coalesce(trim(p ->> 'semester'), semester), 40),
    division     = left(coalesce(trim(p ->> 'division'), division), 80),
    subsystem    = left(coalesce(trim(p ->> 'subsystem'), subsystem), 80),
    lead_id      = case when p ? 'lead_id' then v_lead else lead_id end,
    review_date  = case when p ? 'review_date' then nullif(p ->> 'review_date', '')::date else review_date end,
    fields       = coalesce(p -> 'fields', fields),
    ratings      = coalesce(p -> 'ratings', ratings),
    answers      = coalesce(p -> 'answers', answers),
    updated_at   = now()
  where id = v_id;
  return v_id;
end;
$$;

/** Draft ⇄ Finished ⇄ Shared. Sharing goes to the self-eval's member, or else needs a OneSolar account with the member's email. */
create or replace function public.eval_set_status(p_id uuid, p_status text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare e evals; v_member uuid;
begin
  perform require_permission('evals.write');
  select * into e from evals where id = p_id;
  if e.id is null then raise exception 'That eval no longer exists.'; end if;
  if e.kind <> 'ce' then raise exception 'A self-eval is submitted by its member.'; end if;
  if e.evaluator_id is distinct from auth.uid() then raise exception 'Only the CE who wrote this eval can do that.'; end if;
  if p_status not in ('draft', 'final', 'shared') then raise exception 'Unknown status "%".', p_status; end if;

  if p_status = 'final' and trim(e.member_name) = '' then
    raise exception 'Add the member''s name first.';
  end if;
  if p_status = 'shared' then
    if e.status = 'draft' then raise exception 'Mark the eval finished before sharing it.'; end if;
    if e.self_eval_id is not null then
      select evaluator_id into v_member from evals where id = e.self_eval_id;
    else
      select id into v_member from profiles where lower(email) = e.member_email and e.member_email <> '' limit 1;
    end if;
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

  if p_status = 'shared' and e.status <> 'shared' then
    perform notify_eval(p_id, 'shared', array[v_member]);
  end if;
end;
$$;


revoke execute on function
  public.eval_self_visible(uuid), public.notify_eval(uuid, text, uuid[]),
  public.eval_self_save(uuid, jsonb), public.eval_self_submit(uuid, boolean), public.eval_inbox(),
  public.eval_start_review(uuid), public.eval_schedule_meeting(uuid, timestamptz, text)
from public, anon;
revoke execute on function public.notify_eval(uuid, text, uuid[]) from authenticated;
grant execute on function
  public.eval_self_visible(uuid),
  public.eval_self_save(uuid, jsonb), public.eval_self_submit(uuid, boolean), public.eval_inbox(),
  public.eval_start_review(uuid), public.eval_schedule_meeting(uuid, timestamptz, text)
to authenticated;

-- "Solar Evals" messages are on by default once notifications are turned on (Admin → Notifications).
update public.app_settings
set value = jsonb_set(
  jsonb_set(value, '{events,eval_update}', coalesce(value -> 'events' -> 'eval_update', '{"email": true, "teams": true}'), true),
  '{templates,eval_update}',
  coalesce(value -> 'templates' -> 'eval_update', '{"subject": "Solar Evals: {what}", "body": "Hi {first_name}, {details}"}'),
  true)
where key = 'notifications';

update app_settings set value = jsonb_set(value, '{schemaVersion}', '31') where key = 'general';
