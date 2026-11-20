
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
    join memory_note n on n.id = c.note_id
    where c.tenant_id = p_tenant_id
      and n.superseded_by is null
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

alter table memory_recall_eval_run
  add column if not exists run_kind text not null default 'eval',
  add column if not exists alert_threshold_top3_recall numeric not null default 0.85;
