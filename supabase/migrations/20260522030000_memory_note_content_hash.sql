
create extension if not exists pgcrypto;

create or replace function normalize_for_hash(p_body text)
returns text
language sql
immutable
as $$
  select lower(btrim(regexp_replace(coalesce(p_body, ''), '\s+', ' ', 'g')))
$$;

create or replace function memory_note_content_hash(p_tenant uuid, p_note_type text, p_body text)
returns text
language sql
immutable
as $$
  select encode(
    digest(
      'v1' || chr(31) || p_tenant::text || chr(31) || coalesce(p_note_type, 'untyped') || chr(31) || normalize_for_hash(p_body),
      'sha256'
    ),
    'hex'
  )
$$;

alter table memory_note add column if not exists content_hash text;

update memory_note
set content_hash = memory_note_content_hash(tenant_id, note_type, body_markdown)
where slug is null
  and content_hash is null;

create index if not exists memory_note_content_hash_idx
  on memory_note (tenant_id, content_hash)
  where slug is null and superseded_by is null;
