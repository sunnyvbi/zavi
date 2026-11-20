
set lock_timeout = '5s';

alter table public.memory_note
  add column if not exists subject text
    check (subject is null or length(subject) between 1 and 120),
  add column if not exists attribute text
    check (attribute is null or length(attribute) between 1 and 120),
  add column if not exists value_kind text
    check (value_kind is null or value_kind in ('id', 'money', 'rate', 'other')),
  add column if not exists source_class text
    check (source_class is null or source_class in ('user_stated', 'agent_inferred', 'fetched_web', 'connector')),
  add column if not exists enrichment_state text not null default 'done'
    check (enrichment_state in ('pending', 'done', 'failed')),
  add column if not exists enrichment_attempts smallint not null default 0,
  add column if not exists archive_reason text
    check (archive_reason is null or length(archive_reason) <= 64),
  add column if not exists forgotten_at timestamptz;

comment on column public.memory_note.subject is
  'Normalized subject key emitted by the distill write gate (e.g. "meta pixel"). With attribute, the key an automatic update must match exactly.';
comment on column public.memory_note.attribute is
  'Normalized attribute key (e.g. "id", "take rate"). Auto-replace happens only on an exact (subject, attribute) match.';
comment on column public.memory_note.value_kind is
  'id | money | rate | other. id/money/rate facts are never auto-replaced: a second value opens a memory_conflict_pair instead.';
comment on column public.memory_note.source_class is
  'Provenance of the fact: user_stated | agent_inferred | fetched_web | connector. fetched_web and connector are written at trust_tier 3.';
comment on column public.memory_note.enrichment_state is
  'pending until chunks + embeddings land. The memory-enrichment-retry worker finishes pending notes; failed after 5 attempts.';
comment on column public.memory_note.archive_reason is
  'Why archived_at was set. task_card_retired = the retired per-run task card, hard-deleted 30 days after archival.';
comment on column public.memory_note.forgotten_at is
  'Set when the user pressed Forget. The note is out of recall at once and hard-deleted after the undo window.';

create index if not exists memory_note_fact_key_idx
  on public.memory_note (tenant_id, subject, attribute)
  where subject is not null and superseded_by is null and archived_at is null;

create index if not exists memory_note_enrichment_pending_idx
  on public.memory_note (updated_at)
  where enrichment_state = 'pending';

create index if not exists memory_note_retired_task_card_idx
  on public.memory_note (archived_at)
  where archive_reason = 'task_card_retired';

create table if not exists public.memory_write_log (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  run_id            uuid,
  thread_id         uuid,
  thread_message_id uuid,
  source            text not null check (length(source) between 1 and 64),
  action            text not null check (action in (
                      'added', 'duplicate', 'updated', 'conflict', 'rejected', 'junk', 'cleanup_superseded')),
  note_id           uuid references public.memory_note(id) on delete set null,
  matched_note_id   uuid references public.memory_note(id) on delete set null,
  candidate_title   text check (candidate_title is null or length(candidate_title) <= 300),
  candidate_body    text check (candidate_body is null or length(candidate_body) <= 8000),
  candidate_note_type text check (candidate_note_type is null or length(candidate_note_type) <= 64),
  reason            text check (reason is null or length(reason) <= 500),
  restored_at       timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists memory_write_log_run_idx
  on public.memory_write_log (tenant_id, run_id) where run_id is not null;
create index if not exists memory_write_log_message_idx
  on public.memory_write_log (tenant_id, thread_message_id) where thread_message_id is not null;
create index if not exists memory_write_log_tenant_created_idx
  on public.memory_write_log (tenant_id, created_at desc);
create index if not exists memory_write_log_created_idx
  on public.memory_write_log (created_at);
create index if not exists memory_write_log_note_idx
  on public.memory_write_log (note_id) where note_id is not null;
create index if not exists memory_write_log_matched_idx
  on public.memory_write_log (matched_note_id) where matched_note_id is not null;

alter table public.memory_write_log enable row level security;
alter table public.memory_write_log force row level security;
revoke all on table public.memory_write_log from public, anon, authenticated;
grant select, insert, update, delete on table public.memory_write_log to service_role;

create table if not exists public.memory_conflict_pair (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  existing_note_id uuid not null references public.memory_note(id) on delete cascade,
  new_note_id      uuid not null references public.memory_note(id) on delete cascade,
  subject          text check (subject is null or length(subject) <= 120),
  attribute        text check (attribute is null or length(attribute) <= 120),
  reason           text check (reason is null or length(reason) <= 200),
  run_id           uuid,
  status           text not null default 'open' check (status in ('open', 'resolved')),
  kept_note_id     uuid,
  resolved_by      uuid,
  resolved_at      timestamptz,
  created_at       timestamptz not null default now(),
  check (existing_note_id <> new_note_id)
);

create unique index if not exists memory_conflict_pair_uq
  on public.memory_conflict_pair (tenant_id, existing_note_id, new_note_id);
create index if not exists memory_conflict_pair_open_idx
  on public.memory_conflict_pair (tenant_id, created_at desc) where status = 'open';
create index if not exists memory_conflict_pair_existing_idx
  on public.memory_conflict_pair (existing_note_id);
create index if not exists memory_conflict_pair_new_idx
  on public.memory_conflict_pair (new_note_id);

alter table public.memory_conflict_pair enable row level security;
alter table public.memory_conflict_pair force row level security;
revoke all on table public.memory_conflict_pair from public, anon, authenticated;
grant select, insert, update, delete on table public.memory_conflict_pair to service_role;

create table if not exists public.memory_forget_request (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  note_id         uuid not null,
  requested_by    uuid,
  state           text not null default 'pending' check (state in ('pending', 'undone', 'purged', 'failed')),
  undo_expires_at timestamptz not null,
  purge_after     timestamptz not null,
  attempts        smallint not null default 0,
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz
);

create index if not exists memory_forget_request_due_idx
  on public.memory_forget_request (purge_after) where state = 'pending';
create index if not exists memory_forget_request_note_idx
  on public.memory_forget_request (tenant_id, note_id);

alter table public.memory_forget_request enable row level security;
alter table public.memory_forget_request force row level security;
revoke all on table public.memory_forget_request from public, anon, authenticated;
grant select, insert, update, delete on table public.memory_forget_request to service_role;

alter table public.dream_cycle_runs
  add column if not exists cursor_created_at timestamptz,
  add column if not exists cursor_note_id uuid;

update public.dream_cycle_runs
   set cursor_created_at = last_completed_at
 where cursor_created_at is null and last_completed_at is not null;

alter table public.dream_candidates drop constraint if exists dream_candidates_label_check;
alter table public.dream_candidates
  add constraint dream_candidates_label_check
  check (label in ('pending', 'approved', 'rejected', 'closed'));

update public.dream_candidates
   set label = 'closed',
       decided_at = now(),
       decision_reason = 'closed: staff review queue retired by the memory write path rebuild'
 where label = 'pending';

update public.memory_note
   set archived_at = now(),
       archive_reason = 'task_card_retired'
 where tags @> array['task_card']::text[]
   and source = 'auto_distill_agent_run'
   and slug is null
   and archived_at is null;

create or replace function memory_nearest_neighbors(
  p_tenant_id uuid,
  p_query_embedding vector(1024),
  p_limit int,
  p_min_cosine numeric default 0.75,
  p_note_type text default null,
  p_exclude_note_id uuid default null
) returns table (
  note_id uuid,
  title text,
  body_markdown text,
  note_type text,
  cosine numeric,
  created_at timestamptz
)
language sql stable as $$
  select
    n.id as note_id,
    n.title,
    n.body_markdown,
    n.note_type,
    (1 - (c.embedding <=> p_query_embedding))::numeric as cosine,
    n.created_at
  from memory_chunk c
  join memory_note n on n.id = c.note_id
  where c.tenant_id = p_tenant_id
    and n.superseded_by is null
    and n.archived_at is null
    and c.embedding is not null
    and (p_note_type is null or n.note_type = p_note_type)
    and (p_exclude_note_id is null or n.id <> p_exclude_note_id)
    and (1 - (c.embedding <=> p_query_embedding)) >= coalesce(p_min_cosine, 0)
  order by c.embedding <=> p_query_embedding
  limit greatest(coalesce(p_limit, 5), 1);
$$;

revoke all on function memory_nearest_neighbors(uuid, vector(1024), int, numeric, text, uuid) from public, anon, authenticated;
grant execute on function memory_nearest_neighbors(uuid, vector(1024), int, numeric, text, uuid) to service_role;

create or replace function public.memory_fact_neighbors(
  p_tenant_id uuid,
  p_query_embedding vector(1024),
  p_limit int default 8,
  p_min_cosine numeric default 0.5
) returns table (
  note_id uuid,
  title text,
  body_excerpt text,
  note_type text,
  subject text,
  attribute text,
  value_kind text,
  source_class text,
  trust_tier int,
  cosine numeric
)
language plpgsql volatile as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 8), 1), 20);
begin
  begin
    perform set_config('hnsw.iterative_scan', 'relaxed_order', true);
  exception when others then
    null;
  end;
  return query
  with hits as (
    select c.note_id as nid, (1 - (c.embedding <=> p_query_embedding))::numeric as cos
    from memory_chunk c
    where c.tenant_id = p_tenant_id
      and c.embedding is not null
    order by c.embedding <=> p_query_embedding
    limit v_limit * 4
  ),
  best as (
    select h.nid, max(h.cos) as cos from hits h group by h.nid
  )
  select n.id, n.title, left(n.body_markdown, 1200), n.note_type, n.subject, n.attribute,
         n.value_kind, n.source_class, n.trust_tier::int, b.cos
  from best b
  join memory_note n on n.id = b.nid and n.tenant_id = p_tenant_id
  where n.superseded_by is null
    and n.archived_at is null
    and n.slug is null
    and n.note_type not in ('agent_experience', 'agent_procedural')
    and n.source <> 'agent_discovery_inferred'
    and b.cos >= coalesce(p_min_cosine, 0)
  order by b.cos desc
  limit v_limit;
end $$;

revoke all on function public.memory_fact_neighbors(uuid, vector(1024), int, numeric) from public, anon, authenticated;
grant execute on function public.memory_fact_neighbors(uuid, vector(1024), int, numeric) to service_role;

create or replace function public.memory_undo_update(
  p_tenant_id uuid,
  p_new_note_id uuid
) returns uuid
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_old uuid;
begin
  perform 1 from memory_note
    where id = p_new_note_id and tenant_id = p_tenant_id and superseded_by is null
    for update;
  if not found then
    return null;
  end if;

  select id into v_old from memory_note
    where tenant_id = p_tenant_id
      and superseded_by = p_new_note_id
      and supersession_rationale like 'memory-write: updated%'
    order by superseded_at desc
    limit 1
    for update;
  if v_old is null then
    return null;
  end if;

  update memory_note
     set superseded_by = null, superseded_at = null, supersession_rationale = null
   where id = v_old and tenant_id = p_tenant_id;
  update memory_note
     set superseded_by = v_old, superseded_at = now(),
         supersession_rationale = 'memory-write: update undone by the user'
   where id = p_new_note_id and tenant_id = p_tenant_id;
  update memory_write_log
     set restored_at = now()
   where tenant_id = p_tenant_id and note_id = p_new_note_id
     and action = 'updated' and restored_at is null;
  return v_old;
end $$;

revoke all on function public.memory_undo_update(uuid, uuid) from public, anon, authenticated;
grant execute on function public.memory_undo_update(uuid, uuid) to service_role;

create or replace function public.memory_undo_forget(
  p_tenant_id uuid,
  p_request_id uuid,
  p_grace_seconds int default 5
) returns boolean
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_note uuid;
begin
  select note_id into v_note from memory_forget_request
   where id = p_request_id
     and tenant_id = p_tenant_id
     and state = 'pending'
     and undo_expires_at >= now() - make_interval(secs => greatest(coalesce(p_grace_seconds, 0), 0))
   for update;
  if v_note is null then
    return false;
  end if;
  update memory_note
     set archived_at = null, archive_reason = null, forgotten_at = null
   where id = v_note and tenant_id = p_tenant_id and forgotten_at is not null;
  if not found then
    return false;
  end if;
  update memory_forget_request
     set state = 'undone', resolved_at = now()
   where id = p_request_id and tenant_id = p_tenant_id;
  return true;
end $$;

revoke all on function public.memory_undo_forget(uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.memory_undo_forget(uuid, uuid, int) to service_role;

create or replace function public.memory_keep_conflict_value(
  p_tenant_id uuid,
  p_pair_id uuid,
  p_keep_note_id uuid,
  p_user_id uuid
) returns boolean
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_pair memory_conflict_pair;
  v_other uuid;
begin
  select * into v_pair from memory_conflict_pair
    where id = p_pair_id and tenant_id = p_tenant_id
    for update;
  if v_pair.id is null or v_pair.status <> 'open' then
    return false;
  end if;
  if p_keep_note_id = v_pair.existing_note_id then
    v_other := v_pair.new_note_id;
  elsif p_keep_note_id = v_pair.new_note_id then
    v_other := v_pair.existing_note_id;
  else
    raise exception 'note_not_in_pair' using errcode = '22023';
  end if;

  perform 1 from memory_note
    where id = p_keep_note_id and tenant_id = p_tenant_id and superseded_by is null
    for update;
  if not found then
    raise exception 'kept_note_not_live' using errcode = '22023';
  end if;

  update memory_note
     set superseded_by = p_keep_note_id, superseded_at = now(),
         supersession_rationale = 'memory-write: the user kept the other value'
   where id = v_other and tenant_id = p_tenant_id and superseded_by is null;
  update memory_note
     set trust_tier = 0, source_class = 'user_stated', updated_at = now()
   where id = p_keep_note_id and tenant_id = p_tenant_id;
  update memory_conflict_pair
     set status = 'resolved', kept_note_id = p_keep_note_id,
         resolved_by = p_user_id, resolved_at = now()
   where id = p_pair_id;
  return true;
end $$;

revoke all on function public.memory_keep_conflict_value(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.memory_keep_conflict_value(uuid, uuid, uuid, uuid) to service_role;

create or replace function public.memory_write_metrics(p_since timestamptz)
returns table (
  tenant_id uuid,
  added bigint,
  duplicate bigint,
  updated bigint,
  conflict bigint,
  rejected bigint,
  junk bigint,
  cleanup_superseded bigint,
  restored bigint,
  update_undone bigint,
  forgets bigint,
  forget_undone bigint
)
language sql stable
set search_path = public, pg_temp
as $$
  with w as (
    select l.tenant_id,
           count(*) filter (where l.action = 'added') as added,
           count(*) filter (where l.action = 'duplicate') as duplicate,
           count(*) filter (where l.action = 'updated') as updated,
           count(*) filter (where l.action = 'conflict') as conflict,
           count(*) filter (where l.action = 'rejected') as rejected,
           count(*) filter (where l.action = 'junk') as junk,
           count(*) filter (where l.action = 'cleanup_superseded') as cleanup_superseded,
           count(*) filter (where l.restored_at is not null and l.action <> 'updated') as restored,
           count(*) filter (where l.restored_at is not null and l.action = 'updated') as update_undone
    from memory_write_log l
    where l.created_at >= p_since
    group by l.tenant_id
  ),
  f as (
    select r.tenant_id,
           count(*) as forgets,
           count(*) filter (where r.state = 'undone') as forget_undone
    from memory_forget_request r
    where r.created_at >= p_since
    group by r.tenant_id
  )
  select coalesce(w.tenant_id, f.tenant_id),
         coalesce(w.added, 0), coalesce(w.duplicate, 0), coalesce(w.updated, 0),
         coalesce(w.conflict, 0), coalesce(w.rejected, 0), coalesce(w.junk, 0),
         coalesce(w.cleanup_superseded, 0), coalesce(w.restored, 0), coalesce(w.update_undone, 0),
         coalesce(f.forgets, 0), coalesce(f.forget_undone, 0)
  from w full outer join f on f.tenant_id = w.tenant_id;
$$;

revoke all on function public.memory_write_metrics(timestamptz) from public, anon, authenticated;
grant execute on function public.memory_write_metrics(timestamptz) to service_role;
