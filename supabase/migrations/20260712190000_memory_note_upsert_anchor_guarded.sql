
create or replace function memory_note_upsert_anchor_guarded(
  p_tenant_id uuid,
  p_slug text,
  p_title text,
  p_body_markdown text,
  p_source text,
  p_metadata jsonb,
  p_allowed_existing_sources text[]
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  if p_tenant_id is null then
    raise exception 'p_tenant_id required' using errcode = '22023';
  end if;
  if p_slug is null or p_slug = '' then
    raise exception 'slug required for anchor upsert' using errcode = '22023';
  end if;
  if p_allowed_existing_sources is null or array_length(p_allowed_existing_sources, 1) is null then
    raise exception 'p_allowed_existing_sources required (an empty set would never write)'
      using errcode = '22023';
  end if;

  insert into memory_note (tenant_id, slug, title, body_markdown, source, note_type, metadata)
  values (
    p_tenant_id,
    p_slug,
    coalesce(p_title, p_slug || '.md'),
    coalesce(p_body_markdown, ''),
    coalesce(p_source, 'human'),
    'anchor',
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (tenant_id, slug) where slug is not null and superseded_by is null
  do update set
    body_markdown = excluded.body_markdown,
    title         = excluded.title,
    metadata      = excluded.metadata,
    source        = excluded.source,
    updated_at    = now()
  where memory_note.source = any (p_allowed_existing_sources)
  returning id into v_id;

  if v_id is null then
    return null;
  end if;

  delete from memory_chunk where note_id = v_id;
  return v_id;
end $$;

revoke execute on function memory_note_upsert_anchor_guarded(uuid, text, text, text, text, jsonb, text[])
  from public, anon, authenticated;
grant execute on function memory_note_upsert_anchor_guarded(uuid, text, text, text, text, jsonb, text[])
  to service_role;
