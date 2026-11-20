

alter table memory_note add column if not exists archived_at timestamptz;

comment on column memory_note.archived_at is
  'Soft-archive marker for the stale-note TTL sweep (workers/functions/memory-stale-note-archive.ts). When non-null, the note is EXCLUDED from recall by the `archived_at is null` filter in memory_search_hybrid / _v2 / _lex_or — the same idiom as superseded_by. REVERSIBLE: set back to null to restore the note to recall. Never set on anchors / operator_preference / correction / tier-0/1 / referenced notes.';

create or replace function memory_search_hybrid(
  p_tenant_id uuid,
  p_query text,
  p_query_embedding vector(1024),
  p_limit int,
  p_agent_slug text default null,
  p_connector_keys jsonb default null
) returns table (
  chunk_id uuid,
  note_id uuid,
  title text,
  body text,
  score numeric
)
language sql stable as $$
  with k as (select greatest(coalesce(p_limit, 8), 1) as k),
  keys as (
    select coalesce(
      (select array_agg(value) from jsonb_array_elements_text(p_connector_keys)),
      array[]::text[]
    ) as karr
  ),
  kw as (
    select c.id as chunk_id, c.note_id, n.title, c.body,
           row_number() over (order by ts_rank_cd(c.tsv, plainto_tsquery('english', p_query)) desc) as rnk
    from memory_chunk c
    join memory_note n on n.id = c.note_id and n.tenant_id = p_tenant_id
    where c.tenant_id = p_tenant_id
      and n.superseded_by is null
      and n.archived_at is null
      and (n.note_type <> 'agent_experience' or (p_agent_slug is not null and n.agent_slug = p_agent_slug))
      and (p_connector_keys is null or n.connector_object_keys ?| (select karr from keys))
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
      and n.archived_at is null
      and (n.note_type <> 'agent_experience' or (p_agent_slug is not null and n.agent_slug = p_agent_slug))
      and (p_connector_keys is null or n.connector_object_keys ?| (select karr from keys))
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

revoke all on function memory_search_hybrid(uuid, text, vector(1024), int, text, jsonb) from public;
grant execute on function memory_search_hybrid(uuid, text, vector(1024), int, text, jsonb) to service_role;

create or replace function memory_search_hybrid_v2(
  p_tenant_id uuid,
  p_query text,
  p_query_embedding vector(1024),
  p_limit int,
  p_agent_slug text default null,
  p_connector_keys jsonb default null
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
  v_keys text[];
begin
  begin
    v_or := replace(plainto_tsquery('english', coalesce(p_query, ''))::text, '&', '|')::tsquery;
  exception when others then
    v_or := null;
  end;

  v_keys := coalesce(
    (select array_agg(value) from jsonb_array_elements_text(p_connector_keys)),
    array[]::text[]
  );

  return query
  with k as (select greatest(coalesce(p_limit, 8), 1) as k),
  kw as (
    select c.id as chunk_id, c.note_id, n.title, c.body,
           row_number() over (order by ts_rank_cd(c.tsv, v_or) desc) as rnk
    from memory_chunk c
    join memory_note n on n.id = c.note_id and n.tenant_id = p_tenant_id
    where c.tenant_id = p_tenant_id
      and n.superseded_by is null
      and n.archived_at is null
      and (n.note_type <> 'agent_experience' or (p_agent_slug is not null and n.agent_slug = p_agent_slug))
      and (p_connector_keys is null or n.connector_object_keys ?| v_keys)
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
      and n.archived_at is null
      and (n.note_type <> 'agent_experience' or (p_agent_slug is not null and n.agent_slug = p_agent_slug))
      and (p_connector_keys is null or n.connector_object_keys ?| v_keys)
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

revoke all on function memory_search_hybrid_v2(uuid, text, vector(1024), int, text, jsonb) from public;
grant execute on function memory_search_hybrid_v2(uuid, text, vector(1024), int, text, jsonb) to service_role;

create or replace function memory_search_lex_or(
  p_tenant_id uuid,
  p_query text,
  p_limit int
) returns table (
  chunk_id uuid,
  note_id uuid,
  title text,
  body text,
  score numeric
)
language plpgsql stable as $$
declare
  v_or_query text;
begin
  select string_agg(lexeme, ' | ')
    into v_or_query
    from (
      select distinct regexp_replace(unnest, '[^a-z0-9]', '', 'g') as lexeme
      from regexp_split_to_table(lower(p_query), '\s+') as unnest
      where length(regexp_replace(unnest, '[^a-z0-9]', '', 'g')) >= 3
    ) t
    where lexeme is not null and length(lexeme) >= 3;

  if v_or_query is null or length(v_or_query) = 0 then
    return;
  end if;

  return query
    select c.id as chunk_id, c.note_id, n.title, c.body,
           ts_rank_cd(n.tsv, to_tsquery('english', v_or_query))::numeric as score
    from memory_chunk c
    join memory_note n on n.id = c.note_id and n.tenant_id = p_tenant_id
    where c.tenant_id = p_tenant_id
      and n.superseded_by is null
      and n.archived_at is null
      and n.note_type <> 'agent_experience'
      and n.tsv @@ to_tsquery('english', v_or_query)
    order by score desc
    limit greatest(coalesce(p_limit, 8), 1);
exception
  when others then
    return;
end;
$$;

revoke all on function memory_search_lex_or(uuid, text, int) from public;
grant execute on function memory_search_lex_or(uuid, text, int) to service_role;
