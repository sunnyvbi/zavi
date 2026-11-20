
begin;

create or replace function is_test_tenant_email(p_email text)
returns boolean
language sql immutable as $$
  select p_email is not null
     and position('@' in p_email) > 0
     and lower(trim(substring(p_email from '[^@]*$'))) = any (array[
       'thepraxis.ai',
       'example.com',
       'example-praxis-qa.test',
       'mailinator.com',
       'yopmail.com'
     ]);
$$;

revoke all on function is_test_tenant_email(text) from public, anon, authenticated;

comment on function is_test_tenant_email(text) is
  'True only when the email domain (after the last @) is exactly a Praxis-controlled throwaway domain. Keep in parity with TEST_TENANT_EMAIL_DOMAINS in apps/backend/src/services/tenants/classify-test-tenant.ts.';

create or replace function tenant_kind_for_owner(p_user_id uuid)
returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select case when is_test_tenant_email(u.email) then 'test' else 'real' end
       from auth.users u
      where u.id = p_user_id),
    'real'
  );
$$;

revoke all on function tenant_kind_for_owner(uuid) from public, anon, authenticated;

create or replace function activate_tenant_v2(
  p_slug text,
  p_display_name text,
  p_rar numeric,
  p_memory jsonb,
  p_primary_anchors jsonb default '[]'::jsonb
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
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
    insert into tenants (slug, display_name, rar_weekly_threshold, kind)
    values (p_slug, p_display_name, p_rar, tenant_kind_for_owner(v_caller))
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

revoke all on function activate_tenant_v2(text, text, numeric, jsonb, jsonb) from public, anon, authenticated;
grant execute on function activate_tenant_v2(text, text, numeric, jsonb, jsonb) to authenticated, service_role;

create or replace function activate_tenant_lite(
  p_user_id uuid,
  p_slug text,
  p_display_name text,
  p_allow_additional boolean default false,
  p_kind text default 'real'
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant_id uuid;
  v_existing_owner uuid;
  v_existing_active uuid;
  v_kind text;
begin
  if p_user_id is null then
    raise exception 'p_user_id required' using errcode = '22023';
  end if;
  if p_slug is null or length(trim(p_slug)) = 0 then
    raise exception 'p_slug required' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('real', 'test') then
    raise exception 'p_kind must be ''real'' or ''test'' (got %)', p_kind using errcode = '22023';
  end if;

  v_kind := case when p_kind = 'test' then 'test' else tenant_kind_for_owner(p_user_id) end;

  perform pg_advisory_xact_lock(hashtextextended('activate_tenant_lite:' || p_user_id::text, 0));

  if not p_allow_additional then
    select active_tenant_id into v_existing_active from profiles where user_id = p_user_id;
    if v_existing_active is not null then
      raise exception 'user % already has an active tenant', p_user_id using errcode = '45001';
    end if;
  end if;

  select id into v_tenant_id from tenants where slug = p_slug;

  if v_tenant_id is not null then
    select user_id into v_existing_owner
    from tenant_users
    where tenant_id = v_tenant_id and user_id = p_user_id;
    if v_existing_owner is null then
      raise exception 'tenant slug % is taken by another user; pick a different slug', p_slug
        using errcode = '23505';
    end if;
  else
    insert into tenants (slug, display_name, kind)
    values (p_slug, p_display_name, v_kind)
    returning id into v_tenant_id;
  end if;

  insert into tenant_users (user_id, tenant_id, role)
  values (p_user_id, v_tenant_id, 'owner')
  on conflict (user_id, tenant_id) do nothing;

  insert into profiles (user_id, active_tenant_id, onboarded_at)
  values (p_user_id, v_tenant_id, now())
  on conflict (user_id) do update
    set active_tenant_id = excluded.active_tenant_id,
        onboarded_at = coalesce(profiles.onboarded_at, excluded.onboarded_at);

  return v_tenant_id;
end $$;

revoke all on function activate_tenant_lite(uuid, text, text, boolean, text) from public, anon, authenticated;
grant execute on function activate_tenant_lite(uuid, text, text, boolean, text) to service_role;

commit;
