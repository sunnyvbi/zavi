

create or replace function activate_tenant_v2(
  p_slug text,
  p_display_name text,
  p_rar numeric,
  p_memory jsonb,
  p_primary_anchors jsonb default '[]'::jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant_id uuid;
  v_existing_owner uuid;
  v_memory_key text;
  v_memory_body text;
  v_anchor jsonb;
  v_anchor_slug text;
  v_anchor_title text;
  v_anchor_body text;
  v_anchor_candidate_id text;
  v_canonical_meta jsonb := '{"tier":"canonical","source":"onboarding_default"}'::jsonb;
  v_primary_meta jsonb;
  v_caller uuid := auth.uid();
begin
  if v_caller is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select id into v_tenant_id from tenants where slug = p_slug;

  if v_tenant_id is not null then
    select user_id into v_existing_owner
    from tenant_users
    where tenant_id = v_tenant_id and user_id = v_caller;
    if v_existing_owner is null then
      raise exception 'tenant slug % is taken by another user; pick a different slug', p_slug
        using errcode = '23505';
    end if;
  else
    insert into tenants (slug, display_name, rar_weekly_threshold)
    values (p_slug, p_display_name, p_rar)
    returning id into v_tenant_id;
  end if;

  insert into tenant_users (user_id, tenant_id, role)
  values (v_caller, v_tenant_id, 'owner')
  on conflict (user_id, tenant_id) do nothing;

  insert into profiles (user_id, active_tenant_id, onboarded_at)
  values (v_caller, v_tenant_id, now())
  on conflict (user_id) do update
    set active_tenant_id = excluded.active_tenant_id,
        onboarded_at = coalesce(profiles.onboarded_at, excluded.onboarded_at);

  for v_memory_key, v_memory_body in
    select * from jsonb_each_text(p_memory)
  loop
    insert into memory_note (tenant_id, slug, title, body_markdown, source, note_type, metadata)
    values (
      v_tenant_id,
      v_memory_key,
      v_memory_key || '.md',
      coalesce(v_memory_body, ''),
      'human',
      'anchor',
      v_canonical_meta
    )
    on conflict (tenant_id, slug) where slug is not null and superseded_by is null
    do update set
      body_markdown = excluded.body_markdown,
      title = excluded.title,
      source = excluded.source,
      metadata = coalesce(memory_note.metadata, '{}'::jsonb) || v_canonical_meta,
      updated_at = now();
  end loop;

  if p_primary_anchors is not null and jsonb_typeof(p_primary_anchors) = 'array' then
    for v_anchor in select * from jsonb_array_elements(p_primary_anchors)
    loop
      v_anchor_slug := v_anchor->>'slug';
      v_anchor_title := coalesce(v_anchor->>'title', v_anchor_slug);
      v_anchor_body := coalesce(v_anchor->>'body_markdown', '');
      v_anchor_candidate_id := coalesce(v_anchor->>'candidate_id', '');

      if v_anchor_slug is null or v_anchor_slug = '' then
        continue;
      end if;
      if v_anchor_slug in ('company','ops','policies','disputes','support') then
        continue;
      end if;

      v_primary_meta := jsonb_build_object(
        'tier', 'primary',
        'source', 'onboarding_selection',
        'candidate_id', v_anchor_candidate_id
      );

      insert into memory_note (tenant_id, slug, title, body_markdown, source, note_type, metadata)
      values (
        v_tenant_id,
        v_anchor_slug,
        v_anchor_title,
        v_anchor_body,
        'human',
        'anchor',
        v_primary_meta
      )
      on conflict (tenant_id, slug) where slug is not null and superseded_by is null
      do update set
        body_markdown = excluded.body_markdown,
        title = excluded.title,
        source = excluded.source,
        metadata = coalesce(memory_note.metadata, '{}'::jsonb) || v_primary_meta,
        updated_at = now();
    end loop;
  end if;

  return v_tenant_id;
end $$;
revoke all on function activate_tenant_v2(text, text, numeric, jsonb, jsonb) from public;
grant execute on function activate_tenant_v2(text, text, numeric, jsonb, jsonb) to authenticated;
