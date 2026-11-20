
create or replace function memory_search_hybrid_v2(
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
language plpgsql stable as $$
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
           row_number() over (order by ts_rank_cd(n.tsv, v_or) desc) as rnk
    from memory_chunk c
    join memory_note n on n.id = c.note_id and n.tenant_id = p_tenant_id
    where c.tenant_id = p_tenant_id
      and n.superseded_by is null
      and v_or is not null
      and n.tsv @@ v_or
    order by ts_rank_cd(n.tsv, v_or) desc
    limit (select k * 4 from k)
  ),
  vec as (
    select c.id as chunk_id, c.note_id, n.title, c.body,
           row_number() over (order by c.embedding <=> p_query_embedding) as rnk
    from memory_chunk c
    join memory_note n on n.id = c.note_id and n.tenant_id = p_tenant_id
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
end;
$$;

revoke all on function memory_search_hybrid_v2(uuid, text, vector(1024), int) from public;
grant execute on function memory_search_hybrid_v2(uuid, text, vector(1024), int) to service_role;
