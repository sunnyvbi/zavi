

alter table memory_note
  add column superseded_by uuid references memory_note(id) on delete set null,
  add column superseded_at timestamptz,
  add column supersession_rationale text;

create index memory_note_active_idx
  on memory_note (tenant_id, updated_at desc)
  where superseded_by is null;

create or replace function memory_search_hybrid(
  p_tenant_id uuid,
  p_query text,
  p_query_embedding vector(1024),
  p_limit int
) returns table (
  chunk_id uuid,
  note_id uuid,
  title text,
  body text,
  score numeric
)
language sql stable as $$
  with k as (select greatest(coalesce(p_limit, 8), 1) as k),
  kw as (
    select c.id as chunk_id, c.note_id, n.title, c.body,
           row_number() over (order by ts_rank_cd(n.tsv, plainto_tsquery('english', p_query)) desc) as rnk
    from memory_chunk c
    join memory_note n on n.id = c.note_id
    where c.tenant_id = p_tenant_id
      and n.superseded_by is null
      and p_query is not null
      and length(p_query) > 0
      and n.tsv @@ plainto_tsquery('english', p_query)
    order by ts_rank_cd(n.tsv, plainto_tsquery('english', p_query)) desc
    limit (select k * 4 from k)
  ),
  vec as (
    select c.id as chunk_id, c.note_id, n.title, c.body,
           row_number() over (order by c.embedding <=> p_query_embedding) as rnk
    from memory_chunk c
    join memory_note n on n.id = c.note_id
    where c.tenant_id = p_tenant_id
      and n.superseded_by is null
      and p_query_embedding is not null
      and c.embedding is not null
    order by c.embedding <=> p_query_embedding
    limit (select k * 4 from k)
  ),
  fused as (
    select chunk_id, note_id, title, body, sum(1.0 / (60 + rnk))::numeric as score
    from (
      select * from kw
      union all
      select * from vec
    ) u
    group by chunk_id, note_id, title, body
  )
  select chunk_id, note_id, title, body, score
  from fused
  order by score desc
  limit (select k from k);
$$;

revoke all on function memory_search_hybrid(uuid, text, vector(1024), int) from public;

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
    and c.embedding is not null
    and (p_note_type is null or n.note_type = p_note_type)
    and (p_exclude_note_id is null or n.id <> p_exclude_note_id)
    and (1 - (c.embedding <=> p_query_embedding)) >= coalesce(p_min_cosine, 0)
  order by c.embedding <=> p_query_embedding
  limit greatest(coalesce(p_limit, 5), 1);
$$;

revoke all on function memory_nearest_neighbors(uuid, vector(1024), int, numeric, text, uuid) from public;

create table dream_cycle_verdicts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  new_note_id uuid not null,
  existing_note_id uuid not null,
  verdict text not null check (verdict in (
    'NO_CONFLICT', 'KEEP_NEW', 'KEEP_OLD', 'MERGE', 'MERGE_DEFERRED', 'SKIPPED'
  )),
  rationale text,
  cost_tokens int,
  created_at timestamptz not null default now(),
  unique (tenant_id, new_note_id, existing_note_id)
);

create index dream_cycle_verdicts_by_tenant
  on dream_cycle_verdicts (tenant_id, created_at desc);

alter table dream_cycle_verdicts enable row level security;

create policy dream_cycle_verdicts_member_select on dream_cycle_verdicts
  for select using (
    exists (select 1 from tenant_users tu
              where tu.user_id = auth.uid()
                and tu.tenant_id = dream_cycle_verdicts.tenant_id)
  );

create table dream_cycle_runs (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  last_completed_at timestamptz,
  last_pairs_judged int,
  last_cost_usd numeric default 0,
  updated_at timestamptz not null default now()
);

alter table dream_cycle_runs enable row level security;

create policy dream_cycle_runs_member_select on dream_cycle_runs
  for select using (
    exists (select 1 from tenant_users tu
              where tu.user_id = auth.uid()
                and tu.tenant_id = dream_cycle_runs.tenant_id)
  );

create or replace function apply_dream_verdict(
  p_tenant_id uuid,
  p_new_id uuid,
  p_existing_id uuid,
  p_verdict text,
  p_rationale text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  new_row memory_note;
  existing_row memory_note;
begin
  if p_new_id < p_existing_id then
    select * into new_row from memory_note
      where id = p_new_id and tenant_id = p_tenant_id for update;
    select * into existing_row from memory_note
      where id = p_existing_id and tenant_id = p_tenant_id for update;
  else
    select * into existing_row from memory_note
      where id = p_existing_id and tenant_id = p_tenant_id for update;
    select * into new_row from memory_note
      where id = p_new_id and tenant_id = p_tenant_id for update;
  end if;

  if new_row is null or existing_row is null then
    return;
  end if;
  if new_row.superseded_by is not null or existing_row.superseded_by is not null then
    return;
  end if;

  if p_verdict = 'KEEP_NEW' then
    update memory_note
       set superseded_by = p_new_id,
           superseded_at = now(),
           supersession_rationale = p_rationale
     where id = p_existing_id;
  elsif p_verdict = 'KEEP_OLD' then
    update memory_note
       set superseded_by = p_existing_id,
           superseded_at = now(),
           supersession_rationale = p_rationale
     where id = p_new_id;
  elsif p_verdict = 'MERGE' then
    update memory_note
       set superseded_by = p_new_id,
           superseded_at = now(),
           supersession_rationale = p_rationale
     where id = p_existing_id;
  end if;
end $$;

revoke all on function apply_dream_verdict(uuid, uuid, uuid, text, text) from public;

create or replace function unsupersede_memory_note(
  p_tenant_id uuid,
  p_note_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update memory_note
     set superseded_by = null,
         superseded_at = null,
         supersession_rationale = null
   where id = p_note_id
     and tenant_id = p_tenant_id;
end $$;

grant execute on function unsupersede_memory_note(uuid, uuid) to authenticated;
