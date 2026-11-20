

alter table memory_chunk
  add column if not exists context_text text;

alter table memory_chunk
  add column if not exists tsv tsvector
  generated always as (
    to_tsvector('english', coalesce(context_text, body, ''))
  ) stored;

create index if not exists memory_chunk_tsv_idx on memory_chunk using gin (tsv);

drop function if exists memory_search_hybrid(uuid, text, vector(1024), int);
drop function if exists memory_search_hybrid_v2(uuid, text, vector(1024), int);

create or replace function memory_search_hybrid(
  p_tenant_id uuid,
  p_query text,
  p_query_embedding vector(1024),
  p_limit int,
  p_agent_slug text default null
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
           row_number() over (order by ts_rank_cd(c.tsv, plainto_tsquery('english', p_query)) desc) as rnk
    from memory_chunk c
    join memory_note n on n.id = c.note_id and n.tenant_id = p_tenant_id
    where c.tenant_id = p_tenant_id
      and n.superseded_by is null
      and (n.note_type <> 'agent_experience' or p_agent_slug is null or n.agent_slug = p_agent_slug)
      and p_query is not null
      and length(p_query) > 0
      and c.tsv @@ plainto_tsquery('english', p_query)
    order by ts_rank_cd(c.tsv, plainto_tsquery('english', p_query)) desc
    limit (select k * 4 from k)
  ),
  vec as (
    select c.id as chunk_id, c.note_id, n.title, c.body,
           row_number() over (order by c.embedding <=> p_query_embedding) as rnk
    from memory_chunk c
    join memory_note n on n.id = c.note_id and n.tenant_id = p_tenant_id
    where c.tenant_id = p_tenant_id
      and n.superseded_by is null
      and (n.note_type <> 'agent_experience' or p_agent_slug is null or n.agent_slug = p_agent_slug)
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

revoke all on function memory_search_hybrid(uuid, text, vector(1024), int, text) from public;
grant execute on function memory_search_hybrid(uuid, text, vector(1024), int, text) to service_role;

create or replace function memory_search_hybrid_v2(
  p_tenant_id uuid,
  p_query text,
  p_query_embedding vector(1024),
  p_limit int,
  p_agent_slug text default null
) returns table (
  chunk_id uuid,
  note_id uuid,
  title text,
  body text,
  score numeric
)
language plpgsql stable as $$
#variable_conflict use_column
declare
  v_or tsquery;
begin
  begin
    v_or := replace(plainto_tsquery('english', coalesce(p_query, ''))::text, '&', '|')::tsquery;
  exception when others then
    v_or := null;
  end;

  return query
  with k as (select greatest(coalesce(p_limit, 8), 1) as k),
  kw as (
    select c.id as chunk_id, c.note_id, n.title, c.body,
           row_number() over (order by ts_rank_cd(c.tsv, v_or) desc) as rnk
    from memory_chunk c
    join memory_note n on n.id = c.note_id and n.tenant_id = p_tenant_id
    where c.tenant_id = p_tenant_id
      and n.superseded_by is null
      and (n.note_type <> 'agent_experience' or p_agent_slug is null or n.agent_slug = p_agent_slug)
      and v_or is not null
      and c.tsv @@ v_or
    order by ts_rank_cd(c.tsv, v_or) desc
    limit (select k * 4 from k)
  ),
  vec as (
    select c.id as chunk_id, c.note_id, n.title, c.body,
           row_number() over (order by c.embedding <=> p_query_embedding) as rnk
    from memory_chunk c
    join memory_note n on n.id = c.note_id and n.tenant_id = p_tenant_id
    where c.tenant_id = p_tenant_id
      and n.superseded_by is null
      and (n.note_type <> 'agent_experience' or p_agent_slug is null or n.agent_slug = p_agent_slug)
      and p_query_embedding is not null
      and c.embedding is not null
    order by c.embedding <=> p_query_embedding
    limit (select k * 4 from k)
  ),
  fused as (
    select u.chunk_id, u.note_id, u.title, u.body, sum(1.0 / (60 + u.rnk))::numeric as score
    from (
      select * from kw
      union all
      select * from vec
    ) u
    group by u.chunk_id, u.note_id, u.title, u.body
  )
  select f.chunk_id, f.note_id, f.title, f.body, f.score
  from fused f
  order by f.score desc
  limit (select k from k);
end;
$$;

revoke all on function memory_search_hybrid_v2(uuid, text, vector(1024), int, text) from public;
grant execute on function memory_search_hybrid_v2(uuid, text, vector(1024), int, text) to service_role;
