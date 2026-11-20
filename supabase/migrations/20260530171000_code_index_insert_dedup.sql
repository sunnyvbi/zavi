
begin;

create or replace function code_index_insert_chunk(
  p_tenant_id  uuid,
  p_repo       text,
  p_build_id   uuid,
  p_commit     text,
  p_indexed_at timestamptz,
  p_symbols    jsonb,
  p_refs       jsonb
) returns void
language plpgsql security definer set search_path = public set statement_timeout = '180s' as $$
begin
  if p_tenant_id is null or p_repo is null or p_build_id is null then
    raise exception 'code_index_insert_chunk: tenant_id, repo and build_id are required'
      using errcode = '22023';
  end if;

  insert into code_symbols (
    tenant_id, repo_full_name, build_id, commit_sha,
    symbol_name, kind, file_path, start_line, end_line, signature, embedding, indexed_at
  )
  select
    p_tenant_id, p_repo, p_build_id, p_commit,
    s->>'symbol_name',
    s->>'kind',
    s->>'file_path',
    nullif(s->>'start_line','')::int,
    nullif(s->>'end_line','')::int,
    s->>'signature',
    case
      when s->'embedding' is null or jsonb_typeof(s->'embedding') = 'null'
        then null::vector(1024)
      else (s->>'embedding')::vector(1024)
    end,
    p_indexed_at
  from jsonb_array_elements(coalesce(p_symbols, '[]'::jsonb)) as s
  on conflict (tenant_id, repo_full_name, file_path, symbol_name, start_line, build_id) do nothing;

  insert into code_symbol_refs (
    tenant_id, repo_full_name, build_id,
    symbol_name, ref_kind, from_symbol, file_path, line, indexed_at
  )
  select
    p_tenant_id, p_repo, p_build_id,
    r->>'symbol_name',
    r->>'ref_kind',
    r->>'from_symbol',
    r->>'file_path',
    nullif(r->>'line','')::int,
    p_indexed_at
  from jsonb_array_elements(coalesce(p_refs, '[]'::jsonb)) as r;
end $$;

revoke all on function code_index_insert_chunk(uuid, text, uuid, text, timestamptz, jsonb, jsonb) from public;
grant execute on function code_index_insert_chunk(uuid, text, uuid, text, timestamptz, jsonb, jsonb) to service_role;

commit;
