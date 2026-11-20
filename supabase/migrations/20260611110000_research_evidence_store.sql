
begin;

create table if not exists research_evidence (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references tenants(id) on delete cascade,
  run_id         uuid        not null,
  topic_key      text,
  url            text        not null,
  normalized_url text        not null,
  capture_status text        not null,
  http_status    int,
  content_hash   text,
  excerpt        text,
  excerpt_bytes  int,
  as_of_date     date,
  accessed_at    timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  unique (run_id, normalized_url)
);

create index if not exists research_evidence_tenant_url_idx
  on research_evidence (tenant_id, normalized_url);
create index if not exists research_evidence_tenant_recent_idx
  on research_evidence (tenant_id, accessed_at desc);
create index if not exists research_evidence_tenant_topic_idx
  on research_evidence (tenant_id, topic_key);

alter table research_evidence enable row level security;
drop policy if exists research_evidence_select on research_evidence;
create policy research_evidence_select on research_evidence
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = research_evidence.tenant_id)
  );
revoke insert, update, delete on research_evidence from authenticated, anon;

create or replace function insert_research_evidence(
  p_tenant_id uuid,
  p_run_id    uuid,
  p_topic_key text,
  p_rows      jsonb
) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_count int := 0;
  v_row   jsonb;
begin
  if p_tenant_id is null then
    raise exception 'insert_research_evidence: null tenant_id' using errcode = '22023';
  end if;
  if p_run_id is null then
    raise exception 'insert_research_evidence: null run_id' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return 0;
  end if;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    if coalesce(v_row->>'url', '') = ''
       or coalesce(v_row->>'normalized_url', '') = ''
       or coalesce(v_row->>'capture_status', '') = '' then
      continue;
    end if;

    insert into research_evidence (
      tenant_id, run_id, topic_key, url, normalized_url, capture_status,
      http_status, content_hash, excerpt, excerpt_bytes, as_of_date, accessed_at
    )
    values (
      p_tenant_id,
      p_run_id,
      p_topic_key,
      v_row->>'url',
      v_row->>'normalized_url',
      v_row->>'capture_status',
      nullif(v_row->>'http_status', '')::int,
      nullif(v_row->>'content_hash', ''),
      nullif(v_row->>'excerpt', ''),
      nullif(v_row->>'excerpt_bytes', '')::int,
      nullif(v_row->>'as_of_date', '')::date,
      coalesce(nullif(v_row->>'accessed_at', '')::timestamptz, now())
    )
    on conflict (run_id, normalized_url) do nothing;

    if found then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

revoke all on function insert_research_evidence(uuid, uuid, text, jsonb) from public;
revoke execute on function insert_research_evidence(uuid, uuid, text, jsonb) from authenticated, anon;
grant execute on function insert_research_evidence(uuid, uuid, text, jsonb) to service_role;

commit;
