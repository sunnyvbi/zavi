
begin;

alter table fundraising_investor add column if not exists identity_key text;

create unique index if not exists fundraising_investor_identity_uniq
  on fundraising_investor (tenant_id, identity_key)
  where normalized_email is null;

drop function if exists fundraising_upsert_investor(uuid, text, text, text, text, text, text, text);

create or replace function fundraising_upsert_investor(
  p_tenant_id     uuid,
  p_firm          text,
  p_name          text,
  p_email         text,
  p_source        text,
  p_notes         text,
  p_draft_subject text default null,
  p_draft_body    text default null,
  p_identity_key  text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_norm text;
  v_id   uuid;
begin
  if p_tenant_id is null then
    raise exception 'fundraising_upsert_investor: null tenant_id' using errcode = '22023';
  end if;
  if auth.uid() is not null then
    if not exists (
      select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  v_norm := nullif(lower(trim(coalesce(p_email, ''))), '');

  if v_norm is not null then
    insert into fundraising_investor (tenant_id, firm, name, email, normalized_email, identity_key, source, notes, draft_subject, draft_body)
    values (p_tenant_id, p_firm, p_name, p_email, v_norm,
            nullif(trim(coalesce(p_identity_key, '')), ''),
            p_source, p_notes,
            nullif(trim(coalesce(p_draft_subject, '')), ''),
            nullif(trim(coalesce(p_draft_body, '')), ''))
    on conflict (tenant_id, normalized_email) where normalized_email is not null
    do update set
      firm          = coalesce(excluded.firm, fundraising_investor.firm),
      name          = coalesce(excluded.name, fundraising_investor.name),
      email         = coalesce(excluded.email, fundraising_investor.email),
      identity_key  = coalesce(fundraising_investor.identity_key, excluded.identity_key),
      source        = coalesce(excluded.source, fundraising_investor.source),
      notes         = coalesce(excluded.notes, fundraising_investor.notes),
      draft_subject = coalesce(excluded.draft_subject, fundraising_investor.draft_subject),
      draft_body    = coalesce(excluded.draft_body, fundraising_investor.draft_body),
      updated_at    = now()
    returning id into v_id;
  elsif nullif(trim(coalesce(p_identity_key, '')), '') is not null then
    insert into fundraising_investor (tenant_id, firm, name, email, normalized_email, identity_key, source, notes, draft_subject, draft_body)
    values (p_tenant_id, p_firm, p_name, p_email, null,
            nullif(trim(coalesce(p_identity_key, '')), ''),
            p_source, p_notes,
            nullif(trim(coalesce(p_draft_subject, '')), ''),
            nullif(trim(coalesce(p_draft_body, '')), ''))
    on conflict (tenant_id, identity_key) where normalized_email is null
    do update set
      firm          = coalesce(excluded.firm, fundraising_investor.firm),
      name          = coalesce(excluded.name, fundraising_investor.name),
      source        = coalesce(excluded.source, fundraising_investor.source),
      notes         = coalesce(excluded.notes, fundraising_investor.notes),
      draft_subject = coalesce(excluded.draft_subject, fundraising_investor.draft_subject),
      draft_body    = coalesce(excluded.draft_body, fundraising_investor.draft_body),
      updated_at    = now()
    returning id into v_id;
  else
    insert into fundraising_investor (tenant_id, firm, name, email, normalized_email, identity_key, source, notes, draft_subject, draft_body)
    values (p_tenant_id, p_firm, p_name, p_email, null, null, p_source, p_notes,
            nullif(trim(coalesce(p_draft_subject, '')), ''),
            nullif(trim(coalesce(p_draft_body, '')), ''))
    returning id into v_id;
  end if;

  insert into fundraising_outreach_state (tenant_id, investor_id, state)
  values (p_tenant_id, v_id, 'queued')
  on conflict (tenant_id, investor_id) do nothing;

  return v_id;
end $$;
revoke all on function fundraising_upsert_investor(uuid, text, text, text, text, text, text, text, text) from public;
grant execute on function fundraising_upsert_investor(uuid, text, text, text, text, text, text, text, text) to authenticated;
grant execute on function fundraising_upsert_investor(uuid, text, text, text, text, text, text, text, text) to service_role;

update system_config
set blob = jsonb_set(blob, '{fundraising_pipeline}', 'false'::jsonb, true)
where id = 1 and not (blob ? 'fundraising_pipeline');

commit;
