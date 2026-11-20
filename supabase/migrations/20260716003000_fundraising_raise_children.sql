
create table if not exists fundraising_raise_intro (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references tenants(id) on delete cascade,
  target_firm   text        not null,
  target_person text,
  path          text,
  status        text        not null default 'drafted'
                  check (status in ('drafted','sent')),
  draft_text    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table fundraising_raise_intro enable row level security;

create index if not exists fundraising_raise_intro_tenant_idx
  on fundraising_raise_intro (tenant_id);

create policy fundraising_raise_intro_select on fundraising_raise_intro
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid()
              and tenant_id = fundraising_raise_intro.tenant_id)
  );

create table if not exists fundraising_raise_meeting (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references tenants(id) on delete cascade,
  investor_ref  text        not null,
  investor_id   uuid        references fundraising_investor(id) on delete set null,
  scheduled_for timestamptz,
  status        text        not null default 'upcoming'
                  check (status in ('upcoming','done')),
  outcome       text        check (outcome in ('soft_yes','maybe','pass')),
  prep          jsonb,
  debrief       jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table fundraising_raise_meeting enable row level security;

create index if not exists fundraising_raise_meeting_tenant_idx
  on fundraising_raise_meeting (tenant_id);

create policy fundraising_raise_meeting_select on fundraising_raise_meeting
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid()
              and tenant_id = fundraising_raise_meeting.tenant_id)
  );

create or replace function fundraising_create_raise_intro(
  p_tenant_id     uuid,
  p_target_firm   text,
  p_target_person text,
  p_path          text,
  p_draft_text    text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if p_tenant_id is null then
    raise exception 'fundraising_create_raise_intro: tenant_id required' using errcode = '22023';
  end if;
  if p_target_firm is null or length(trim(p_target_firm)) = 0 then
    raise exception 'fundraising_create_raise_intro: target_firm required' using errcode = '22023';
  end if;
  if auth.uid() is not null then
    if not exists (
      select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  insert into fundraising_raise_intro (tenant_id, target_firm, target_person, path, draft_text)
  values (p_tenant_id, p_target_firm, p_target_person, p_path, p_draft_text)
  returning id into v_id;
  return v_id;
end $$;

revoke all on function fundraising_create_raise_intro(uuid, text, text, text, text) from public, anon;
grant execute on function fundraising_create_raise_intro(uuid, text, text, text, text) to authenticated;
grant execute on function fundraising_create_raise_intro(uuid, text, text, text, text) to service_role;

create or replace function fundraising_mark_intro_sent(
  p_tenant_id uuid,
  p_id        uuid
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null or p_id is null then
    raise exception 'fundraising_mark_intro_sent: tenant_id and id required' using errcode = '22023';
  end if;
  if auth.uid() is not null then
    if not exists (
      select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  update fundraising_raise_intro
     set status = 'sent', updated_at = now()
   where id = p_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'fundraising_mark_intro_sent: intro % not found for tenant %', p_id, p_tenant_id
      using errcode = '22023';
  end if;
end $$;

revoke all on function fundraising_mark_intro_sent(uuid, uuid) from public, anon;
grant execute on function fundraising_mark_intro_sent(uuid, uuid) to authenticated;
grant execute on function fundraising_mark_intro_sent(uuid, uuid) to service_role;

create or replace function fundraising_create_raise_meeting(
  p_tenant_id     uuid,
  p_investor_ref  text,
  p_investor_id   uuid,
  p_scheduled_for timestamptz
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id         uuid;
  v_row_tenant uuid;
begin
  if p_tenant_id is null then
    raise exception 'fundraising_create_raise_meeting: tenant_id required' using errcode = '22023';
  end if;
  if p_investor_ref is null or length(trim(p_investor_ref)) = 0 then
    raise exception 'fundraising_create_raise_meeting: investor_ref required' using errcode = '22023';
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
    if v_row_tenant is null or v_row_tenant <> p_tenant_id then
      raise exception 'fundraising_create_raise_meeting: investor % does not belong to tenant %',
        p_investor_id, p_tenant_id using errcode = '42501';
    end if;
  end if;

  insert into fundraising_raise_meeting (tenant_id, investor_ref, investor_id, scheduled_for)
  values (p_tenant_id, p_investor_ref, p_investor_id, p_scheduled_for)
  returning id into v_id;
  return v_id;
end $$;

revoke all on function fundraising_create_raise_meeting(uuid, text, uuid, timestamptz) from public, anon;
grant execute on function fundraising_create_raise_meeting(uuid, text, uuid, timestamptz) to authenticated;
grant execute on function fundraising_create_raise_meeting(uuid, text, uuid, timestamptz) to service_role;

create or replace function fundraising_set_meeting_prep(
  p_tenant_id uuid,
  p_id        uuid,
  p_prep      jsonb
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null or p_id is null then
    raise exception 'fundraising_set_meeting_prep: tenant_id and id required' using errcode = '22023';
  end if;
  if auth.uid() is not null then
    if not exists (
      select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  update fundraising_raise_meeting
     set prep = p_prep, updated_at = now()
   where id = p_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'fundraising_set_meeting_prep: meeting % not found for tenant %', p_id, p_tenant_id
      using errcode = '22023';
  end if;
end $$;

revoke all on function fundraising_set_meeting_prep(uuid, uuid, jsonb) from public, anon;
grant execute on function fundraising_set_meeting_prep(uuid, uuid, jsonb) to authenticated;
grant execute on function fundraising_set_meeting_prep(uuid, uuid, jsonb) to service_role;

create or replace function fundraising_debrief_raise_meeting(
  p_tenant_id uuid,
  p_id        uuid,
  p_outcome   text,
  p_debrief   jsonb
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_investor_id uuid;
begin
  if p_tenant_id is null or p_id is null then
    raise exception 'fundraising_debrief_raise_meeting: tenant_id and id required' using errcode = '22023';
  end if;
  if p_outcome is null or p_outcome not in ('soft_yes','maybe','pass') then
    raise exception 'fundraising_debrief_raise_meeting: invalid outcome %', p_outcome using errcode = '22023';
  end if;
  if auth.uid() is not null then
    if not exists (
      select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  update fundraising_raise_meeting
     set status = 'done', outcome = p_outcome, debrief = p_debrief, updated_at = now()
   where id = p_id and tenant_id = p_tenant_id
   returning investor_id into v_investor_id;
  if not found then
    raise exception 'fundraising_debrief_raise_meeting: meeting % not found for tenant %', p_id, p_tenant_id
      using errcode = '22023';
  end if;

  if p_outcome = 'soft_yes' and v_investor_id is not null then
    begin
      perform fundraising_advance_stage(p_tenant_id, v_investor_id, 'diligence');
    exception when others then
      null;
    end;
  end if;
end $$;

revoke all on function fundraising_debrief_raise_meeting(uuid, uuid, text, jsonb) from public, anon;
grant execute on function fundraising_debrief_raise_meeting(uuid, uuid, text, jsonb) to authenticated;
grant execute on function fundraising_debrief_raise_meeting(uuid, uuid, text, jsonb) to service_role;
