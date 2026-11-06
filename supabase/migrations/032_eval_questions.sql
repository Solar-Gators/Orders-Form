-- =============================================================================
-- 032: Solar Evals — self-evals are a few written questions, set by each CE
-- =============================================================================
-- Run once, after 031: Supabase → SQL Editor → New query → paste → Run.
--
--   * Instead of rating themselves on the rubric, a member answers their CE's
--     questions. Each CE keeps their own list (Solar Evals → Questions) and can
--     copy any other CE's questions. A CE who hasn't set any uses the default
--     questions below.
--   * A self-eval keeps its own copy of the questions: while it's a draft it
--     follows the CE's current list; once submitted it no longer changes.
--   * The member still picks their division; the CE's eval made from the
--     self-eval uses that division's rubric, as in 031.
--   * Everything else from 031 (who sees what, meeting, sharing, emails) is the same.
-- =============================================================================

create table public.eval_questions (
  owner_id    uuid primary key references public.profiles(id) on delete cascade,
  questions   jsonb not null default '[]',
  updated_at  timestamptz not null default now()
);
alter table public.eval_questions enable row level security;
-- Members read their CE's questions; CEs read each other's to copy them.
create policy "signed-in read" on public.eval_questions for select to authenticated using (true);
revoke all on public.eval_questions from anon, authenticated;
grant select on public.eval_questions to authenticated;

/** The questions used when a CE hasn't written their own. */
create or replace function public.eval_default_questions()
returns jsonb
language sql immutable set search_path = public, pg_temp
as $$
  select '[
    {"id": "worked-on", "text": "What did you work on this semester, and what are you most proud of?", "hint": ""},
    {"id": "blockers", "text": "What got in your way, and what would have helped?", "hint": ""},
    {"id": "team", "text": "How did working with your subsystem, your lead and the rest of the team go?", "hint": ""},
    {"id": "next", "text": "What do you want to learn or take on next semester?", "hint": ""},
    {"id": "else", "text": "Is there anything else your CE should know?", "hint": "Optional"}
  ]'::jsonb;
$$;

/** A CE's questions, or the defaults. */
create or replace function public.eval_questions_for(p_ce uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(
    (select questions from eval_questions where owner_id = p_ce and jsonb_array_length(questions) > 0),
    eval_default_questions());
$$;

/** Save your own questions (1 to 20). p: [{ id, text, hint }] */
create or replace function public.eval_questions_save(p jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v jsonb;
begin
  perform require_permission('evals.write');
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) not between 1 and 20 then
    raise exception 'Keep between 1 and 20 questions.';
  end if;
  if exists (select 1 from jsonb_array_elements(p) q
             where jsonb_typeof(q) <> 'object'
                or coalesce(q ->> 'id', '') !~ '^[a-z0-9][a-z0-9-]{0,39}$'
                or length(trim(coalesce(q ->> 'text', ''))) not between 1 and 500
                or length(coalesce(q ->> 'hint', '')) > 200) then
    raise exception 'Every question needs some text (up to 500 characters).';
  end if;
  if (select count(distinct q ->> 'id') from jsonb_array_elements(p) q) <> jsonb_array_length(p) then
    raise exception 'Two questions have the same id.';
  end if;
  select jsonb_agg(jsonb_build_object('id', q ->> 'id', 'text', trim(q ->> 'text'), 'hint', trim(coalesce(q ->> 'hint', ''))) order by n)
    into v from jsonb_array_elements(p) with ordinality as t(q, n);
  insert into eval_questions (owner_id, questions, updated_at) values (auth.uid(), v, now())
  on conflict (owner_id) do update set questions = excluded.questions, updated_at = now();
end;
$$;


-- ---------------------------------------------------------------------------
-- The member's self-eval: answers to the CE's questions
-- ---------------------------------------------------------------------------
/**
 * Start (p_id null) or update your own self-eval.
 *   p: { template_id (new only: your division's rubric, for the CE's eval),
 *        member_name, semester, division, subsystem, ce_id, lead_id, answers }
 * While it's a draft, its questions follow the picked CE's current list.
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
  if p ? 'answers' and (jsonb_typeof(p -> 'answers') <> 'object'
     or exists (select 1 from jsonb_each(p -> 'answers') a where jsonb_typeof(a.value) <> 'string' or length(a.value #>> '{}') > 4000)) then
    raise exception 'Each answer can be up to 4000 characters.';
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
    if t.id is null then raise exception 'Pick your division.'; end if;
    insert into evals (kind, template_id, template_label, rubric, evaluator_id, member_id, member_name, member_email)
    values ('self', t.id, (select name from eval_tracks where id = t.track_id) || ' · ' || t.label,
            jsonb_build_object('questions', eval_default_questions()), auth.uid(), auth.uid(),
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
    answers     = coalesce(p -> 'answers', answers),
    updated_at  = now()
  where id = v_id;
  update evals set rubric = jsonb_build_object('questions', eval_questions_for(ce_id)) where id = v_id;
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
    if e.ce_id is null then raise exception 'Pick your CE first.'; end if;
    if not user_has_permission(e.ce_id, 'evals.write') then raise exception 'The CE you picked no longer fills out evals. Pick your CE again.'; end if;
    if trim(e.member_name) = '' then raise exception 'Add your name first.'; end if;
    if not exists (select 1 from jsonb_each_text(e.answers) a where trim(a.value) <> '') then
      raise exception 'Answer at least one question first.';
    end if;
    update evals set status = 'final', finalized_at = now(), updated_at = now(),
                     rubric = jsonb_build_object('questions', eval_questions_for(e.ce_id))   -- the questions as they were answered
    where id = p_id;
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

/** The CE starts their eval from a self-eval sent to them: on the member's division rubric, header filled in. */
create or replace function public.eval_start_review(p_self uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare s evals; v_id uuid; v_rubric jsonb;
begin
  perform require_permission('evals.write');
  select * into s from evals where id = p_self;
  if s.id is null or s.kind <> 'self' or s.status = 'draft' or s.ce_id is distinct from auth.uid() then
    raise exception 'That self-eval isn''t waiting for you.';
  end if;
  select id into v_id from evals where self_eval_id = p_self;
  if v_id is not null then return v_id; end if;
  -- 031 self-evals carried the rubric itself; 032 ones carry questions, so take the division's rubric.
  v_rubric := case when s.rubric ? 'pages' then s.rubric
                   else coalesce((select rubric from eval_templates where id = s.template_id),
                                 (select rubric from eval_templates where id = '00000000-0000-4000-8000-0000000000a1')) end;
  insert into evals (kind, template_id, template_label, rubric, evaluator_id, self_eval_id,
                     member_name, member_email, semester, division, subsystem, lead_id)
  values ('ce', s.template_id, s.template_label, v_rubric, auth.uid(), s.id,
          s.member_name, s.member_email, s.semester, s.division, s.subsystem, s.lead_id)
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.eval_default_questions(), public.eval_questions_for(uuid), public.eval_questions_save(jsonb) from public, anon;
grant execute on function public.eval_default_questions(), public.eval_questions_for(uuid), public.eval_questions_save(jsonb) to authenticated;

update app_settings set value = jsonb_set(value, '{schemaVersion}', '32') where key = 'general';
