
begin;

alter table code_symbols     add column if not exists build_id uuid;
alter table code_symbol_refs add column if not exists build_id uuid;

create index if not exists code_symbols_build_idx
  on code_symbols (tenant_id, repo_full_name, build_id);
create index if not exists code_symbol_refs_build_idx
  on code_symbol_refs (tenant_id, repo_full_name, build_id);

do $$
declare
  v_conname text;
begin
  select c.conname
    into v_conname
  from pg_constraint c
  where c.conrelid = 'public.code_symbols'::regclass
    and c.contype = 'u'
    and (
      select array_agg(a.attname::text order by a.attname::text)
      from unnest(c.conkey) as k(attnum)
      join pg_attribute a
        on a.attrelid = c.conrelid and a.attnum = k.attnum
    ) = array['file_path','repo_full_name','start_line','symbol_name','tenant_id']::text[]
  limit 1;

  if v_conname is not null then
    execute format('alter table code_symbols drop constraint %I', v_conname);
  end if;
end $$;

alter table code_symbols
  add constraint code_symbols_generation_key
  unique (tenant_id, repo_full_name, file_path, symbol_name, start_line, build_id);

create table if not exists code_index_state (
  tenant_id        uuid not null references tenants(id) on delete cascade,
  repo_full_name   text not null,
  current_build_id uuid,
  indexed_at       timestamptz default now(),
  primary key (tenant_id, repo_full_name)
);

alter table code_index_state enable row level security;

drop policy if exists code_index_state_select on code_index_state;
create policy code_index_state_select on code_index_state for select to authenticated using (
  tenant_id in (select tenant_id from tenant_users where user_id = auth.uid())
);

create table if not exists code_index_builds (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  repo_full_name text not null,
  built_at       timestamptz default now()
);

create index if not exists code_index_builds_tenant_built_idx
  on code_index_builds (tenant_id, built_at);

alter table code_index_builds enable row level security;

drop policy if exists code_index_builds_select on code_index_builds;
create policy code_index_builds_select on code_index_builds for select to authenticated using (
  tenant_id in (select tenant_id from tenant_users where user_id = auth.uid())
);

create or replace function code_index_insert_chunk(
  p_tenant_id  uuid,
  p_repo       text,
  p_build_id   uuid,
  p_commit     text,
  p_indexed_at timestamptz,
  p_symbols    jsonb,
  p_refs       jsonb
) returns void
language plpgsql security definer set search_path = public as $$
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
  from jsonb_array_elements(coalesce(p_symbols, '[]'::jsonb)) as s;

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

create or replace function code_index_commit(
  p_tenant_id uuid,
  p_repo      text,
  p_build_id  uuid,
  p_commit    text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_tenant_id is null or p_repo is null or p_build_id is null then
    raise exception 'code_index_commit: tenant_id, repo and build_id are required'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_repo, 0));

  insert into code_index_state (tenant_id, repo_full_name, current_build_id, indexed_at)
  values (p_tenant_id, p_repo, p_build_id, now())
  on conflict (tenant_id, repo_full_name) do update
    set current_build_id = excluded.current_build_id,
        indexed_at       = excluded.indexed_at;

  insert into code_index_builds (tenant_id, repo_full_name, built_at)
  values (p_tenant_id, p_repo, now());

  delete from code_symbols
    where tenant_id = p_tenant_id
      and repo_full_name = p_repo
      and (build_id is distinct from p_build_id);
  delete from code_symbol_refs
    where tenant_id = p_tenant_id
      and repo_full_name = p_repo
      and (build_id is distinct from p_build_id);
end $$;

revoke all on function code_index_commit(uuid, text, uuid, text) from public;
grant execute on function code_index_commit(uuid, text, uuid, text) to service_role;

drop function if exists code_symbol_query(uuid, text, text, vector(1024), text);

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
      and cs.build_id = (
        select s.current_build_id from code_index_state s
        where s.tenant_id = p_tenant_id and s.repo_full_name = p_repo
      )
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
      and cr.build_id = (
        select s.current_build_id from code_index_state s
        where s.tenant_id = p_tenant_id and s.repo_full_name = p_repo
      )
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

drop function if exists upsert_code_symbols(uuid, text, text, jsonb, jsonb);

commit;
