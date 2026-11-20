

create extension if not exists vector;

create table memory_note (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  title text not null default '',
  body_markdown text not null default '',
  source text not null default 'human',
  source_ref text,
  tags text[] not null default array[]::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  tsv tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body_markdown, '')), 'B')
  ) stored
);
create index memory_note_tenant_idx on memory_note (tenant_id, updated_at desc);
create index memory_note_tsv_idx on memory_note using gin (tsv);
create index memory_note_tags_idx on memory_note using gin (tags);

create table memory_chunk (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  note_id uuid not null references memory_note(id) on delete cascade,
  chunk_index int not null default 0,
  body text not null,
  embedding vector(1024),
  created_at timestamptz not null default now()
);
create index memory_chunk_tenant_idx on memory_chunk (tenant_id);
create index memory_chunk_note_idx on memory_chunk (note_id);
create index memory_chunk_embedding_idx on memory_chunk
  using ivfflat (embedding vector_cosine_ops) with (lists = 32);

create table memory_entity (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  entity_type text not null,
  canonical_name text not null,
  attrs jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (tenant_id, entity_type, canonical_name)
);
create index memory_entity_tenant_type_idx on memory_entity (tenant_id, entity_type);

create table memory_relation (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  src_entity_id uuid not null references memory_entity(id) on delete cascade,
  dst_entity_id uuid not null references memory_entity(id) on delete cascade,
  relation_type text not null,
  confidence numeric not null default 0.5 check (confidence between 0 and 1),
  source_note_id uuid references memory_note(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, src_entity_id, dst_entity_id, relation_type)
);
create index memory_relation_tenant_idx on memory_relation (tenant_id);
create index memory_relation_src_idx on memory_relation (src_entity_id);
create index memory_relation_dst_idx on memory_relation (dst_entity_id);

alter table memory_note enable row level security;
alter table memory_chunk enable row level security;
alter table memory_entity enable row level security;
alter table memory_relation enable row level security;

create policy memory_note_select on memory_note for select to authenticated using (
  tenant_id in (select tenant_id from tenant_users where user_id = auth.uid())
);
create policy memory_chunk_select on memory_chunk for select to authenticated using (
  tenant_id in (select tenant_id from tenant_users where user_id = auth.uid())
);
create policy memory_entity_select on memory_entity for select to authenticated using (
  tenant_id in (select tenant_id from tenant_users where user_id = auth.uid())
);
create policy memory_relation_select on memory_relation for select to authenticated using (
  tenant_id in (select tenant_id from tenant_users where user_id = auth.uid())
);

create or replace function _assert_tenant_member(p_tenant_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'unauthenticated';
  end if;
  if not exists (
    select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
  ) then
    raise exception 'not a member of tenant %', p_tenant_id;
  end if;
end $$;
revoke all on function _assert_tenant_member(uuid) from public;
grant execute on function _assert_tenant_member(uuid) to authenticated;

create or replace function memory_note_upsert(
  p_tenant_id uuid,
  p_id uuid,
  p_title text,
  p_body_markdown text,
  p_source text,
  p_source_ref text,
  p_tags text[]
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  perform _assert_tenant_member(p_tenant_id);
  if p_id is null then
    insert into memory_note (tenant_id, title, body_markdown, source, source_ref, tags)
      values (p_tenant_id, coalesce(p_title, ''), coalesce(p_body_markdown, ''),
              coalesce(p_source, 'human'), p_source_ref, coalesce(p_tags, array[]::text[]))
      returning id into v_id;
  else
    update memory_note set
      title = coalesce(p_title, title),
      body_markdown = coalesce(p_body_markdown, body_markdown),
      source = coalesce(p_source, source),
      source_ref = coalesce(p_source_ref, source_ref),
      tags = coalesce(p_tags, tags),
      updated_at = now()
    where id = p_id and tenant_id = p_tenant_id
    returning id into v_id;
    if v_id is null then
      raise exception 'memory_note % not found in tenant %', p_id, p_tenant_id;
    end if;
    delete from memory_chunk where note_id = v_id;
  end if;
  return v_id;
end $$;
revoke all on function memory_note_upsert(uuid, uuid, text, text, text, text, text[]) from public;
grant execute on function memory_note_upsert(uuid, uuid, text, text, text, text, text[]) to authenticated;

create or replace function memory_note_delete(
  p_tenant_id uuid,
  p_id uuid
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _assert_tenant_member(p_tenant_id);
  delete from memory_note where id = p_id and tenant_id = p_tenant_id;
end $$;
revoke all on function memory_note_delete(uuid, uuid) from public;
grant execute on function memory_note_delete(uuid, uuid) to authenticated;

create or replace function memory_entity_upsert(
  p_tenant_id uuid,
  p_entity_type text,
  p_canonical_name text,
  p_attrs jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  perform _assert_tenant_member(p_tenant_id);
  insert into memory_entity (tenant_id, entity_type, canonical_name, attrs, last_seen_at)
    values (p_tenant_id, p_entity_type, p_canonical_name, coalesce(p_attrs, '{}'::jsonb), now())
  on conflict (tenant_id, entity_type, canonical_name) do update set
    attrs = memory_entity.attrs || coalesce(excluded.attrs, '{}'::jsonb),
    last_seen_at = now()
  returning id into v_id;
  return v_id;
end $$;
revoke all on function memory_entity_upsert(uuid, text, text, jsonb) from public;
grant execute on function memory_entity_upsert(uuid, text, text, jsonb) to authenticated;

create or replace function memory_relation_upsert(
  p_tenant_id uuid,
  p_src_entity_id uuid,
  p_dst_entity_id uuid,
  p_relation_type text,
  p_confidence numeric,
  p_source_note_id uuid
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  perform _assert_tenant_member(p_tenant_id);
  insert into memory_relation (tenant_id, src_entity_id, dst_entity_id, relation_type, confidence, source_note_id)
    values (p_tenant_id, p_src_entity_id, p_dst_entity_id, p_relation_type, coalesce(p_confidence, 0.5), p_source_note_id)
  on conflict (tenant_id, src_entity_id, dst_entity_id, relation_type) do update set
    confidence = greatest(memory_relation.confidence, excluded.confidence),
    source_note_id = coalesce(excluded.source_note_id, memory_relation.source_note_id)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function memory_relation_upsert(uuid, uuid, uuid, text, numeric, uuid) from public;
grant execute on function memory_relation_upsert(uuid, uuid, uuid, text, numeric, uuid) to authenticated;

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

