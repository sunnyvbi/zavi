
begin;

create table if not exists fundraising_investor (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references tenants(id) on delete cascade,
  firm             text,
  name             text,
  email            text,
  normalized_email text,
  stage            text        not null default 'targeted'
                     check (stage in ('targeted','contacted','meeting','diligence','committed')),
  source           text,
  notes            text,
  draft_subject    text,
  draft_body       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists fundraising_investor_tenant_email_uniq
  on fundraising_investor (tenant_id, normalized_email)
  where normalized_email is not null;

create index if not exists fundraising_investor_tenant_idx
  on fundraising_investor (tenant_id);

alter table fundraising_investor enable row level security;
drop policy if exists fundraising_investor_select on fundraising_investor;
create policy fundraising_investor_select on fundraising_investor
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = fundraising_investor.tenant_id)
  );
revoke insert, update, delete on fundraising_investor from authenticated, anon;

create table if not exists fundraising_outreach_state (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references tenants(id) on delete cascade,
  investor_id  uuid        not null references fundraising_investor(id) on delete cascade,
  state        text        not null default 'queued'
                 check (state in ('queued','sent','opened','replied','bounced','unsubscribed','paused','completed')),
  last_sent_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, investor_id)
);

create index if not exists fundraising_outreach_state_tenant_idx
  on fundraising_outreach_state (tenant_id);

alter table fundraising_outreach_state enable row level security;
drop policy if exists fundraising_outreach_state_select on fundraising_outreach_state;
create policy fundraising_outreach_state_select on fundraising_outreach_state
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = fundraising_outreach_state.tenant_id)
  );
revoke insert, update, delete on fundraising_outreach_state from authenticated, anon;

create table if not exists fundraising_document (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references tenants(id) on delete cascade,
  investor_id  uuid        references fundraising_investor(id) on delete set null,
  kind         text,
  artifact_id  text,
  title        text,
  created_at   timestamptz not null default now()
);

create index if not exists fundraising_document_tenant_idx
  on fundraising_document (tenant_id);

alter table fundraising_document enable row level security;
drop policy if exists fundraising_document_select on fundraising_document;
create policy fundraising_document_select on fundraising_document
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = fundraising_document.tenant_id)
  );
revoke insert, update, delete on fundraising_document from authenticated, anon;

create or replace function fundraising_upsert_investor(
  p_tenant_id     uuid,
  p_firm          text,
  p_name          text,
  p_email         text,
  p_source        text,
  p_notes         text,
  p_draft_subject text default null,
  p_draft_body    text default null
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
    insert into fundraising_investor (tenant_id, firm, name, email, normalized_email, source, notes, draft_subject, draft_body)
    values (p_tenant_id, p_firm, p_name, p_email, v_norm, p_source, p_notes,
            nullif(trim(coalesce(p_draft_subject, '')), ''),
            nullif(trim(coalesce(p_draft_body, '')), ''))
    on conflict (tenant_id, normalized_email) where normalized_email is not null
    do update set
      firm          = coalesce(excluded.firm, fundraising_investor.firm),
      name          = coalesce(excluded.name, fundraising_investor.name),
      email         = coalesce(excluded.email, fundraising_investor.email),
      source        = coalesce(excluded.source, fundraising_investor.source),
      notes         = coalesce(excluded.notes, fundraising_investor.notes),
      draft_subject = coalesce(excluded.draft_subject, fundraising_investor.draft_subject),
      draft_body    = coalesce(excluded.draft_body, fundraising_investor.draft_body),
      updated_at    = now()
    returning id into v_id;
  else
    insert into fundraising_investor (tenant_id, firm, name, email, normalized_email, source, notes, draft_subject, draft_body)
    values (p_tenant_id, p_firm, p_name, p_email, null, p_source, p_notes,
            nullif(trim(coalesce(p_draft_subject, '')), ''),
            nullif(trim(coalesce(p_draft_body, '')), ''))
    returning id into v_id;
  end if;

  insert into fundraising_outreach_state (tenant_id, investor_id, state)
  values (p_tenant_id, v_id, 'queued')
  on conflict (tenant_id, investor_id) do nothing;

  return v_id;
end $$;
revoke all on function fundraising_upsert_investor(uuid, text, text, text, text, text, text, text) from public;
grant execute on function fundraising_upsert_investor(uuid, text, text, text, text, text, text, text) to authenticated;
grant execute on function fundraising_upsert_investor(uuid, text, text, text, text, text, text, text) to service_role;

create or replace function fundraising_advance_stage(
  p_tenant_id   uuid,
  p_investor_id uuid,
  p_new_stage   text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_cur_stage  text;
  v_row_tenant uuid;
  v_stages     text[] := array['targeted','contacted','meeting','diligence','committed'];
  v_cur_idx    int;
  v_new_idx    int;
begin
  if p_tenant_id is null or p_investor_id is null then
    raise exception 'fundraising_advance_stage: tenant_id and investor_id required' using errcode = '22023';
  end if;
  if auth.uid() is not null then
    if not exists (
      select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  v_new_idx := array_position(v_stages, p_new_stage);
  if v_new_idx is null then
    raise exception 'fundraising_advance_stage: unknown stage %', p_new_stage using errcode = '22023';
  end if;

  select stage, tenant_id into v_cur_stage, v_row_tenant
    from fundraising_investor where id = p_investor_id;
  if v_row_tenant is null then
    raise exception 'fundraising_advance_stage: investor % not found', p_investor_id using errcode = '22023';
  end if;
  if v_row_tenant <> p_tenant_id then
    raise exception 'fundraising_advance_stage: investor % does not belong to tenant %',
      p_investor_id, p_tenant_id using errcode = '42501';
  end if;

  v_cur_idx := array_position(v_stages, v_cur_stage);
  if v_new_idx < v_cur_idx then
    raise exception 'fundraising_advance_stage: cannot move backward from % to %',
      v_cur_stage, p_new_stage using errcode = '22023';
  end if;

  update fundraising_investor
     set stage = p_new_stage, updated_at = now()
   where id = p_investor_id and tenant_id = p_tenant_id;
end $$;
revoke all on function fundraising_advance_stage(uuid, uuid, text) from public;
grant execute on function fundraising_advance_stage(uuid, uuid, text) to authenticated;
grant execute on function fundraising_advance_stage(uuid, uuid, text) to service_role;

create or replace function fundraising_set_outreach_state(
  p_tenant_id   uuid,
  p_investor_id uuid,
  p_state       text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row_tenant uuid;
  v_states     text[] := array['queued','sent','opened','replied','bounced','unsubscribed','paused','completed'];
begin
  if p_tenant_id is null or p_investor_id is null then
    raise exception 'fundraising_set_outreach_state: tenant_id and investor_id required' using errcode = '22023';
  end if;
  if auth.uid() is not null then
    if not exists (
      select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  if array_position(v_states, p_state) is null then
    raise exception 'fundraising_set_outreach_state: unknown state %', p_state using errcode = '22023';
  end if;

  select tenant_id into v_row_tenant from fundraising_investor where id = p_investor_id;
  if v_row_tenant is null then
    raise exception 'fundraising_set_outreach_state: investor % not found', p_investor_id using errcode = '22023';
  end if;
  if v_row_tenant <> p_tenant_id then
    raise exception 'fundraising_set_outreach_state: investor % does not belong to tenant %',
      p_investor_id, p_tenant_id using errcode = '42501';
  end if;

  insert into fundraising_outreach_state (tenant_id, investor_id, state, last_sent_at, updated_at)
  values (
    p_tenant_id, p_investor_id, p_state,
    case when p_state = 'sent' then now() else null end,
    now()
  )
  on conflict (tenant_id, investor_id) do update set
    state        = excluded.state,
    last_sent_at = case when excluded.state = 'sent' then now()
                        else fundraising_outreach_state.last_sent_at end,
    updated_at   = now();
end $$;
revoke all on function fundraising_set_outreach_state(uuid, uuid, text) from public;
revoke execute on function fundraising_set_outreach_state(uuid, uuid, text) from authenticated;
grant execute on function fundraising_set_outreach_state(uuid, uuid, text) to service_role;

create or replace function fundraising_list_investors(
  p_tenant_id uuid
) returns table (
  id              uuid,
  firm            text,
  name            text,
  email           text,
  stage           text,
  source          text,
  notes           text,
  draft_subject   text,
  draft_body      text,
  outreach_state  text,
  last_sent_at    timestamptz,
  created_at      timestamptz,
  updated_at      timestamptz
)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null then
    raise exception 'fundraising_list_investors: null tenant_id' using errcode = '22023';
  end if;
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (
    select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
  ) then
    raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
  end if;

  return query
    select
      fi.id, fi.firm, fi.name, fi.email, fi.stage, fi.source, fi.notes,
      fi.draft_subject, fi.draft_body,
      coalesce(os.state, 'queued') as outreach_state,
      os.last_sent_at,
      fi.created_at, fi.updated_at
    from fundraising_investor fi
    left join fundraising_outreach_state os
      on os.investor_id = fi.id and os.tenant_id = fi.tenant_id
    where fi.tenant_id = p_tenant_id
    order by fi.created_at desc;
end $$;
revoke all on function fundraising_list_investors(uuid) from public;
grant execute on function fundraising_list_investors(uuid) to authenticated;

create or replace function fundraising_insert_document(
  p_tenant_id   uuid,
  p_investor_id uuid,
  p_kind        text,
  p_artifact_id text,
  p_title       text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id         uuid;
  v_row_tenant uuid;
begin
  if p_tenant_id is null then
    raise exception 'fundraising_insert_document: null tenant_id' using errcode = '22023';
  end if;
  if auth.uid() is not null then
    if not exists (
      select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  if p_investor_id is not null then
    select tenant_id into v_row_tenant from fundraising_investor where id = p_investor_id;
    if v_row_tenant is null then
      raise exception 'fundraising_insert_document: investor % not found', p_investor_id using errcode = '22023';
    end if;
    if v_row_tenant <> p_tenant_id then
      raise exception 'fundraising_insert_document: investor % does not belong to tenant %',
        p_investor_id, p_tenant_id using errcode = '42501';
    end if;
  end if;

  insert into fundraising_document (tenant_id, investor_id, kind, artifact_id, title)
  values (p_tenant_id, p_investor_id, p_kind, p_artifact_id, p_title)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function fundraising_insert_document(uuid, uuid, text, text, text) from public;
revoke execute on function fundraising_insert_document(uuid, uuid, text, text, text) from authenticated;
grant execute on function fundraising_insert_document(uuid, uuid, text, text, text) to service_role;

update system_config
set blob = jsonb_set(
      blob,
      '{disabled_agent_slugs}',
      (
        select coalesce(jsonb_agg(distinct elem), '[]'::jsonb)
        from jsonb_array_elements_text(
          coalesce(blob->'disabled_agent_slugs', '[]'::jsonb)
          || '["fundraising"]'::jsonb
        ) as elem
      )
    ),
    updated_at = now(),
    updated_by = null
where id = 1;

insert into tenant_agent_kill_switch (tenant_id, agent_slug, override_state, source, reason)
select '73db45ff-457e-4541-bc8f-bdb625390204'::uuid, 'fundraising', 'visible', 'staff',
       'fundraising P0a dogfood-first: visible for upcar-ai only'
where exists (
  select 1 from tenants where id = '73db45ff-457e-4541-bc8f-bdb625390204'::uuid
)
on conflict (tenant_id, agent_slug) do update set
  override_state = 'visible',
  source         = 'staff',
  reason         = excluded.reason,
  killed_at      = now();

commit;
