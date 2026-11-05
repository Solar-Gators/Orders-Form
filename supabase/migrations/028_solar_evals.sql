-- =============================================================================
-- 028: Solar Evals — semester review rubrics and filled-in evaluations
--
--   The Solar Evals page (solar-gators.github.io/Custom-Apps/solarevals) signs
--   in with Order Form accounts and keeps everything here.
--
--   * eval_tracks: the master template plus one row per CE division.
--   * eval_templates: every saved version of a rubric. Saving always adds a
--     row; nothing is overwritten. "Remove" only hides a version saved by
--     mistake.
--   * evals: one filled-in evaluation of a member. It keeps its own copy of
--     the rubric it was written on, so later template changes don't alter it.
--
--   Who sees what
--     - Drafts: only the CE writing them.
--     - Finished: that CE, everyone with "See all evals" (CEs, E-board, Admin),
--       and the subsystem lead picked on the eval.
--     - Shared: also the member, through the Order Form account that had the
--       member's email when the CE shared it.
--
--   Permissions: evals.templates (edit rubrics), evals.write (fill out evals),
--   evals.view (see all finished evals). New role: E-board.
--
-- Run once, after 027: Supabase → SQL Editor → New query → paste → Run.
-- =============================================================================

insert into public.permissions (key, label, description, sort) values
  ('evals.templates', 'Edit eval rubrics', 'Save new versions of the Solar Evals master template and CE division rubrics.', 12),
  ('evals.write', 'Fill out evals', 'Write semester evaluations for members on the Solar Evals page.', 13),
  ('evals.view', 'See all evals', 'Read every finished evaluation, not just ones you wrote or lead.', 14)
on conflict (key) do nothing;
update public.permissions set sort = 15 where key = 'users.manage';

insert into public.roles (key, label, sort) values ('eboard', 'E-board', 6) on conflict (key) do nothing;
insert into public.role_permissions (role, permission) values
  ('ce', 'evals.templates'), ('ce', 'evals.write'), ('ce', 'evals.view'),
  ('eboard', 'evals.templates'), ('eboard', 'evals.view'),
  ('admin', 'evals.templates'), ('admin', 'evals.write'), ('admin', 'evals.view')
on conflict do nothing;


-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.eval_tracks (
  id          text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  name        text not null check (length(trim(name)) between 1 and 60),
  kind        text not null default 'ce' check (kind in ('master', 'ce')),
  color       text not null default '#5d6d7e' check (color ~ '^#[0-9a-fA-F]{6}$'),
  sort        int  not null default 100,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

insert into public.eval_tracks (id, name, kind, color, sort) values
  ('master',     'Master template',      'master', '#0b2545', 0),
  ('aero',       'Aero / Structures CE', 'ce',     '#1F7A6B', 1),
  ('vd',         'Vehicle Dynamics CE',  'ce',     '#C2622A', 2),
  ('powertrain', 'Powertrain CE',        'ce',     '#8A3F7A', 3),
  ('electrical', 'Electrical CE',        'ce',     '#2F5FA8', 4)
on conflict (id) do nothing;

create table public.eval_templates (
  id           uuid primary key default gen_random_uuid(),
  track_id     text not null references public.eval_tracks(id) on delete restrict,
  label        text not null check (length(trim(label)) between 1 and 40),
  note         text not null default '' check (length(note) <= 600),
  based_on     uuid references public.eval_templates(id) on delete set null,
  rubric       jsonb not null,
  author_id    uuid references public.profiles(id) on delete set null,
  author_name  text not null default '',
  created_at   timestamptz not null default now(),
  removed_at   timestamptz,
  removed_by   uuid references public.profiles(id) on delete set null
);
create unique index eval_templates_label_idx on public.eval_templates (track_id, lower(label)) where removed_at is null;
create index eval_templates_track_idx on public.eval_templates (track_id, created_at);

create table public.evals (
  id                   uuid primary key default gen_random_uuid(),
  template_id          uuid references public.eval_templates(id) on delete set null,
  template_label       text not null default '',     -- e.g. "Electrical CE · Fall 2026", kept if the version is removed
  rubric               jsonb not null,                -- the rubric exactly as it was when the eval was started
  member_name          text not null default '' check (length(member_name) <= 120),
  member_email         text not null default '' check (length(member_email) <= 200),
  member_id            uuid references public.profiles(id) on delete set null,   -- set when shared
  semester             text not null default '' check (length(semester) <= 40),
  division             text not null default '' check (length(division) <= 80),
  subsystem            text not null default '' check (length(subsystem) <= 80),
  lead_id              uuid references public.profiles(id) on delete set null,
  evaluator_id         uuid references public.profiles(id) on delete set null,
  review_date          date,
  fields               jsonb not null default '{}',   -- any other header fields, by label
  ratings              jsonb not null default '{}',   -- { criterion id: 1-5 or "NO" }
  answers              jsonb not null default '{}',   -- { feedback box id: text }
  member_comments      text not null default '' check (length(member_comments) <= 4000),
  member_commented_at  timestamptz,
  status               text not null default 'draft' check (status in ('draft', 'final', 'shared')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  finalized_at         timestamptz,
  shared_at            timestamptz
);
create index evals_evaluator_idx on public.evals (evaluator_id);
create index evals_lead_idx on public.evals (lead_id);
create index evals_member_idx on public.evals (member_id);
create index evals_semester_idx on public.evals (semester, updated_at desc);

alter table public.eval_tracks    enable row level security;
alter table public.eval_templates enable row level security;
alter table public.evals          enable row level security;

create policy "signed-in read" on public.eval_tracks    for select to authenticated using (true);
create policy "signed-in read" on public.eval_templates for select to authenticated using (removed_at is null);
create policy "eval readers" on public.evals for select to authenticated using (
  evaluator_id = auth.uid()
  or (status <> 'draft' and (lead_id = auth.uid() or has_permission('evals.view')))
  or (status = 'shared' and member_id = auth.uid())
);

-- Everything is changed through the functions below.
revoke all on public.eval_tracks, public.eval_templates, public.evals from anon, authenticated;
grant select on public.eval_tracks, public.eval_templates, public.evals to authenticated;


-- ---------------------------------------------------------------------------
-- The original master rubric, v1.0 (from the master PDF)
-- ---------------------------------------------------------------------------
insert into public.eval_templates (id, track_id, label, note, rubric, author_name, created_at)
values ('00000000-0000-4000-8000-0000000000a1', 'master', 'v1.0', 'The original master rubric.',
        $rubric${"title":"Solar Evals","catHead":"Category","catSub":"Behavioral expectations","scale":["Unsatisfactory","Below expectations","Meets expectations","Exceeds expectations","Exceptional"],"pages":[{"id":"universal","name":"Universal rubric","subtitle":"Solar Gators  /  Semester performance review","fields":["Member","Semester","CE division","Subsystem","Subsystem lead","Evaluating CE"],"instruction":"Circle one rating in each row.  A 3 means the member fully meets expectations for their role and experience.","legend":"N/O = Not observed / not applicable","capsNames":true,"criteria":[{"id":"communication","tag":"","name":"Communication","sub":"Progress, blockers, coordination","writeIn":false,"levels":["Fails to share critical updates, repeatedly delaying others.","Gives sporadic updates; teammates must repeatedly request information.","Shares progress, blockers, and schedule changes promptly and clearly.","Anticipates information needs and coordinates before issues disrupt work.","Improves team communication practices and prevents recurring disconnects."]},{"id":"reliability","tag":"","name":"Reliability & accountability","sub":"Follow-through and accountability","writeIn":false,"levels":["Frequently leaves agreed work unfinished without accountability.","Misses commitments or needs repeated reminders to finish work.","Completes agreed work or flags risks and renegotiates deadlines early.","Dependably delivers, anticipates obstacles, and takes corrective action.","Sustains exceptional follow-through and strengthens critical team execution."]},{"id":"attendance","tag":"","name":"Attendance & participation","sub":"Agreed sessions and engagement","writeIn":false,"levels":["Regularly misses agreed sessions without timely notice.","Attendance or engagement often falls below agreed expectations.","Meets agreed participation expectations or communicates conflicts early.","Consistently engaged; makes valuable contributions during team activities.","Enables productive work sessions and helps others participate effectively."]},{"id":"technical","tag":"","name":"Technical ability & work quality","sub":"Judgment, execution, verification","writeIn":false,"levels":["Work often misses basic requirements or needs extensive correction.","Applies fundamentals unevenly; work often needs guidance or rework.","Uses role-appropriate skills and checks work against requirements.","Handles challenging work independently with consistently strong results.","Applies exceptional judgment and elevates team-wide technical quality."]},{"id":"initiative","tag":"","name":"Initiative & ownership","sub":"Self-direction and problem-solving","writeIn":false,"levels":["Rarely progresses work without repeated direction.","Waits for instructions to address routine next steps or blockers.","Advances assigned work independently and raises blockers when needed.","Identifies needed work and drives solutions beyond assigned scope.","Proactively leads high-impact improvements through to results."]},{"id":"learning","tag":"","name":"Learning & development","sub":"Feedback, curiosity, skill growth","writeIn":false,"levels":["Makes little effort to develop essential skills or act on feedback.","Learning is inconsistent; similar gaps persist after feedback.","Seeks help appropriately, uses feedback, and builds expected skills.","Pursues new skills independently and applies them effectively.","Shows exceptional growth and shares knowledge that lifts the team."]}],"boxes":[],"notesTitle":"Scoring principles","notes":["Use specific examples for 1, 2, 4, or 5. Evaluate agreed commitments, not raw hours or willingness to work excessive shifts.","Safety concerns are addressed separately; do not reduce them to a numerical performance rating."],"footer":"Solar Gators  •  Semester member development"},{"id":"specialized","name":"Specialized + feedback","subtitle":"Specialized expectations, evidence and next-semester development","fields":["Member","Semester","Review date"],"instruction":"CE and subsystem expectations should be agreed upon at the start of the semester; mark unused categories N/O.","legend":"","capsNames":false,"criteria":[{"id":"ce-1","tag":"CE-specific","name":"Criterion 1","sub":"","writeIn":true,"levels":["Does not meet core competency standards or progress expectations.","Partially meets standards; needs repeated intervention.","Meets the agreed competency and quality standards.","Exceeds standards through strong, independent execution.","Demonstrates exceptional competence and meaningfully improves division outcomes."]},{"id":"ce-2","tag":"CE-specific","name":"Criterion 2","sub":"","writeIn":true,"levels":["Does not meet core competency standards or progress expectations.","Partially meets standards; needs repeated intervention.","Meets the agreed competency and quality standards.","Exceeds standards through strong, independent execution.","Demonstrates exceptional competence and meaningfully improves division outcomes."]},{"id":"sub-1","tag":"Subsystem-specific","name":"Goal / skill 1","sub":"","writeIn":true,"levels":["Makes little usable progress on agreed deliverables.","Makes partial progress; important outcomes remain incomplete.","Completes agreed deliverables to the defined standard.","Exceeds deliverables or materially accelerates subsystem progress.","Delivers exceptional results with lasting subsystem impact."]},{"id":"sub-2","tag":"Subsystem-specific","name":"Goal / skill 2  (optional)","sub":"","writeIn":true,"levels":["Makes little usable progress on agreed deliverables.","Makes partial progress; important outcomes remain incomplete.","Completes agreed deliverables to the defined standard.","Exceeds deliverables or materially accelerates subsystem progress.","Delivers exceptional results with lasting subsystem impact."]}],"boxes":[{"id":"evidence","title":"Notable contributions / evidence","lines":4},{"id":"goals","title":"Agreed goals for next semester","lines":4},{"id":"improvement","title":"Areas for improvement","lines":2},{"id":"comments","title":"Member comments / context","lines":2}],"notesTitle":"","notes":["3 = Meets expectations.  Scores of 4 or 5 require specific evidence; no one needs to hold a leadership role to earn a 5.","N/O = insufficient evidence or criterion not assigned.  Serious safety issues require separate action."],"footer":"Solar Gators"}]}$rubric$::jsonb, 'Solar Gators', '2026-11-04T00:00:00Z')
on conflict (id) do nothing;


-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.my_name()
returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(nullif(trim(full_name), ''), email) from profiles where id = auth.uid();
$$;

/** A rubric must have pages with criteria, and five rating labels. */
create or replace function public.check_rubric(p jsonb)
returns void
language plpgsql immutable set search_path = public, pg_temp
as $$
begin
  if jsonb_typeof(p) <> 'object'
     or coalesce(jsonb_typeof(p -> 'pages'), '') <> 'array' or jsonb_array_length(p -> 'pages') = 0
     or coalesce(jsonb_typeof(p -> 'scale'), '') <> 'array' or jsonb_array_length(p -> 'scale') <> 5 then
    raise exception 'That rubric is missing its pages or its five rating labels.';
  end if;
  if exists (select 1 from jsonb_array_elements(p -> 'pages') pg
             where coalesce(jsonb_typeof(pg -> 'criteria'), '') <> 'array') then
    raise exception 'Every rubric page needs a list of criteria.';
  end if;
  if octet_length(p::text) > 200000 then
    raise exception 'That rubric is too large.';
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- Rubrics (Edit eval rubrics)
-- ---------------------------------------------------------------------------
create or replace function public.eval_template_save(p_track text, p_label text, p_note text, p_based_on uuid, p_rubric jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  perform require_permission('evals.templates');
  if not exists (select 1 from eval_tracks where id = p_track) then
    raise exception 'That division no longer exists.';
  end if;
  if coalesce(trim(p_label), '') = '' then
    raise exception 'Give the version a name, e.g. Spring 2027.';
  end if;
  perform check_rubric(p_rubric);
  if exists (select 1 from eval_templates where track_id = p_track and lower(label) = lower(trim(p_label)) and removed_at is null) then
    raise exception 'This division already has a version called "%". Pick another name.', trim(p_label);
  end if;
  insert into eval_templates (track_id, label, note, based_on, rubric, author_id, author_name)
  values (p_track, trim(p_label), coalesce(trim(p_note), ''), p_based_on, p_rubric, auth.uid(), coalesce(my_name(), ''))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.eval_template_remove(p_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_track text;
begin
  perform require_permission('evals.templates');
  select track_id into v_track from eval_templates where id = p_id and removed_at is null;
  if v_track is null then return; end if;
  if v_track = 'master' and (select count(*) from eval_templates where track_id = 'master' and removed_at is null) = 1 then
    raise exception 'The master template needs at least one version.';
  end if;
  update eval_templates set removed_at = now(), removed_by = auth.uid() where id = p_id;
end;
$$;

/** Add a division (p_id null) or rename / recolour one. */
create or replace function public.eval_track_save(p_id text, p_name text, p_color text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id text;
begin
  perform require_permission('evals.templates');
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the division a name.'; end if;
  if p_id is null then
    v_id := left(trim(both '-' from regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g')), 30);
    if v_id = '' then v_id := 'division'; end if;
    v_id := v_id || '-' || substr(md5(random()::text), 1, 4);
    insert into eval_tracks (id, name, color, created_by) values (v_id, trim(p_name), coalesce(p_color, '#5d6d7e'), auth.uid());
    return v_id;
  end if;
  if p_id = 'master' then raise exception 'The master template can''t be renamed.'; end if;
  update eval_tracks set name = trim(p_name), color = coalesce(p_color, color), updated_at = now() where id = p_id;
  return p_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- Evaluations (Fill out evals)
-- ---------------------------------------------------------------------------

/**
 * Start (p_id null) or update an eval you're writing.
 *   p: { template_id, member_name, member_email, semester, division, subsystem,
 *        lead_id, review_date, fields, ratings, answers }
 * A new eval copies its rubric from the template, so it can't be tampered with.
 */
create or replace function public.eval_save(p_id uuid, p jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id uuid := p_id;
  v_status text;
  v_owner uuid;
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
    select status, evaluator_id into v_status, v_owner from evals where id = v_id;
    if v_owner is distinct from auth.uid() then raise exception 'Only the CE who wrote this eval can change it.'; end if;
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

/** Draft ⇄ Finished ⇄ Shared. Sharing needs an Order Form account with the member's email. */
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
      raise exception 'Nobody has an Order Form account with the email "%" yet. Ask them to create one, then share again.', e.member_email;
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

/** Only drafts can be deleted, by the CE writing them. (A finished eval can be moved back to draft first.) */
create or replace function public.eval_delete(p_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare e evals;
begin
  select * into e from evals where id = p_id;
  if e.id is null then return; end if;
  if e.evaluator_id is distinct from auth.uid() then
    raise exception 'Only the CE who wrote this eval can delete it.';
  end if;
  if e.status <> 'draft' then
    raise exception 'Only drafts can be deleted. Move it back to draft first.';
  end if;
  delete from evals where id = p_id;
end;
$$;

/** The member's own comments on an eval shared with them. */
create or replace function public.eval_member_comment(p_id uuid, p_text text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update evals set member_comments = left(coalesce(p_text, ''), 4000), member_commented_at = now()
  where id = p_id and status = 'shared' and member_id = auth.uid();
  if not found then raise exception 'You can only comment on an eval that has been shared with you.'; end if;
end;
$$;


revoke execute on function
  public.my_name(), public.check_rubric(jsonb),
  public.eval_template_save(text, text, text, uuid, jsonb), public.eval_template_remove(uuid),
  public.eval_track_save(text, text, text),
  public.eval_save(uuid, jsonb), public.eval_set_status(uuid, text), public.eval_delete(uuid),
  public.eval_member_comment(uuid, text)
from public, anon;
grant execute on function
  public.eval_template_save(text, text, text, uuid, jsonb), public.eval_template_remove(uuid),
  public.eval_track_save(text, text, text),
  public.eval_save(uuid, jsonb), public.eval_set_status(uuid, text), public.eval_delete(uuid),
  public.eval_member_comment(uuid, text)
to authenticated;

update app_settings set value = jsonb_set(value, '{schemaVersion}', '28') where key = 'general';
