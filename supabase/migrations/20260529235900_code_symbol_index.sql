
begin;

create extension if not exists vector;

create table code_symbols (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  repo_full_name text not null,
  commit_sha    text,
  symbol_name   text not null,
  kind          text not null
                  check (kind in ('function','method','class','interface','type','const','var')),
  file_path     text not null,
  start_line    int,
  end_line      int,
  signature     text,
  embedding     vector(1024),
  indexed_at    timestamptz default now(),
  unique (tenant_id, repo_full_name, file_path, symbol_name, start_line)
);

create index code_symbols_lookup_idx
  on code_symbols (tenant_id, repo_full_name, symbol_name);
create index code_symbols_embedding_idx
  on code_symbols using ivfflat (embedding vector_cosine_ops) with (lists = 32);

create table code_symbol_refs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  repo_full_name text not null,
  symbol_name   text not null,
  ref_kind      text not null check (ref_kind in ('reference','call')),
  from_symbol   text,
  file_path     text not null,
  line          int,
  indexed_at    timestamptz default now()
);

create index code_symbol_refs_lookup_idx
  on code_symbol_refs (tenant_id, repo_full_name, symbol_name);

alter table code_symbols enable row level security;
alter table code_symbol_refs enable row level security;

create policy code_symbols_select on code_symbols for select to authenticated using (
  tenant_id in (select tenant_id from tenant_users where user_id = auth.uid())
);
create policy code_symbol_refs_select on code_symbol_refs for select to authenticated using (
  tenant_id in (select tenant_id from tenant_users where user_id = auth.uid())
);

create or replace function upsert_code_symbols(
  p_tenant_id uuid,
  p_repo      text,
  p_commit    text,
  p_symbols   jsonb,
  p_refs      jsonb
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_tenant_id is null or p_repo is null then
    raise exception 'upsert_code_symbols: tenant_id and repo are required'
      using errcode = '22023';
  end if;

  delete from code_symbols      where tenant_id = p_tenant_id and repo_full_name = p_repo;
  delete from code_symbol_refs  where tenant_id = p_tenant_id and repo_full_name = p_repo;

  insert into code_symbols (
    tenant_id, repo_full_name, commit_sha,
    symbol_name, kind, file_path, start_line, end_line, signature
  )
  select
    p_tenant_id, p_repo, p_commit,
    s->>'symbol_name',
    s->>'kind',
    s->>'file_path',
    nullif(s->>'start_line','')::int,
    nullif(s->>'end_line','')::int,
    s->>'signature'
  from jsonb_array_elements(coalesce(p_symbols, '[]'::jsonb)) as s;

  insert into code_symbol_refs (
    tenant_id, repo_full_name, symbol_name, ref_kind, from_symbol, file_path, line
  )
  select
    p_tenant_id, p_repo,
    r->>'symbol_name',
    r->>'ref_kind',
    r->>'from_symbol',
    r->>'file_path',
    nullif(r->>'line','')::int
  from jsonb_array_elements(coalesce(p_refs, '[]'::jsonb)) as r;
end $$;

revoke all on function upsert_code_symbols(uuid, text, text, jsonb, jsonb) from public;
grant execute on function upsert_code_symbols(uuid, text, text, jsonb, jsonb) to service_role;

create or replace function code_symbol_query(
  p_tenant_id       uuid,
  p_repo            text,
  p_symbol_name     text,
  p_query_embedding vector(1024),
  p_mode            text
) returns table (
  symbol_name text,
  kind        text,
  ref_kind    text,
  from_symbol text,
  file_path   text,
  start_line  int,
  end_line    int,
  line        int,
  signature   text,
  score       numeric
)
language sql stable as $$
  (
    select
      cs.symbol_name,
      cs.kind,
      null::text   as ref_kind,
      null::text   as from_symbol,
      cs.file_path,
      cs.start_line,
      cs.end_line,
      null::int    as line,
      cs.signature,
      case
        when p_query_embedding is not null and cs.embedding is not null
          then (1 - (cs.embedding <=> p_query_embedding))::numeric
        else null::numeric
      end as score
    from code_symbols cs
    where cs.tenant_id = p_tenant_id
      and cs.repo_full_name = p_repo
      and p_mode = 'def'
      and (p_symbol_name is null or cs.symbol_name = p_symbol_name)
    order by score desc nulls last, cs.symbol_name
    limit 200
  )

  union all

  (
    select
      cr.symbol_name,
      null::text   as kind,
      cr.ref_kind,
      cr.from_symbol,
      cr.file_path,
      null::int    as start_line,
      null::int    as end_line,
      cr.line,
      null::text   as signature,
      null::numeric as score
    from code_symbol_refs cr
    where cr.tenant_id = p_tenant_id
      and cr.repo_full_name = p_repo
      and (
        (p_mode = 'refs'    and cr.ref_kind = 'reference') or
        (p_mode = 'callers' and cr.ref_kind = 'call')
      )
      and (p_symbol_name is null or cr.symbol_name = p_symbol_name)
    order by cr.file_path, cr.line
    limit 200
  );
$$;

revoke all on function code_symbol_query(uuid, text, text, vector(1024), text) from public;
grant execute on function code_symbol_query(uuid, text, text, vector(1024), text) to service_role;

commit;
