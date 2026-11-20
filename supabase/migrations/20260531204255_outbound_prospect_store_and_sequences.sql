
create table if not exists outbound_sequences (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null,
  name        text        not null,
  channel     text        not null check (channel in ('email', 'sms', 'slack_dm')),
  steps       jsonb       not null default '[]'::jsonb,
  active      boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table outbound_sequences enable row level security;
drop policy if exists outbound_sequences_select on outbound_sequences;
create policy outbound_sequences_select on outbound_sequences
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = outbound_sequences.tenant_id)
  );

create table if not exists outbound_prospects (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null,
  name                text,
  company             text,
  channel             text        not null check (channel in ('email', 'sms', 'slack_dm')),
  handle              text        not null,
  dedupe_key          text        not null,
  icp_fit_score       numeric     check (icp_fit_score is null or (icp_fit_score >= 0 and icp_fit_score <= 1)),
  qualification_state text        not null default 'new'
                      check (qualification_state in
                        ('new','qualified','contacted','engaged','replied','unsubscribed','disqualified')),
  source              text,
  sequence_id         uuid        references outbound_sequences(id) on delete set null,
  sequence_step       int         not null default 0,
  next_action_at      timestamptz,
  sequence_state      text        not null default 'idle'
                      check (sequence_state in ('idle','active','paused','stopped','completed')),
  last_contacted_at   timestamptz,
  meta                jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, dedupe_key)
);
alter table outbound_prospects enable row level security;
drop policy if exists outbound_prospects_select on outbound_prospects;
create policy outbound_prospects_select on outbound_prospects
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = outbound_prospects.tenant_id)
  );

create index if not exists outbound_prospects_due_idx
  on outbound_prospects (next_action_at)
  where sequence_state = 'active';

create or replace function upsert_outbound_prospect(
  p_tenant_id     uuid,
  p_channel       text,
  p_handle        text,
  p_name          text    default null,
  p_company       text    default null,
  p_icp_fit_score numeric default null,
  p_source        text    default null,
  p_meta          jsonb   default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_dedupe   text;
  v_id       uuid;
  v_inserted boolean := false;
begin
  if p_tenant_id is null or p_channel is null or p_handle is null then
    raise exception 'upsert_outbound_prospect: null argument' using errcode = '22023';
  end if;
  if p_channel not in ('email','sms','slack_dm') then
    raise exception 'upsert_outbound_prospect: invalid channel %', p_channel using errcode = '22023';
  end if;

  v_dedupe := p_channel || ':' || lower(trim(p_handle));

  insert into outbound_prospects
    (tenant_id, channel, handle, dedupe_key, name, company, icp_fit_score, source, meta)
  values
    (p_tenant_id, p_channel, p_handle, v_dedupe, p_name, p_company, p_icp_fit_score, p_source, p_meta)
  on conflict (tenant_id, dedupe_key) do update
    set name          = coalesce(excluded.name, outbound_prospects.name),
        company       = coalesce(excluded.company, outbound_prospects.company),
        icp_fit_score = coalesce(excluded.icp_fit_score, outbound_prospects.icp_fit_score),
        source        = coalesce(excluded.source, outbound_prospects.source),
        meta          = coalesce(excluded.meta, outbound_prospects.meta),
        updated_at    = now()
  returning id, (xmax = 0) into v_id, v_inserted;

  return jsonb_build_object('id', v_id, 'inserted', v_inserted, 'dedupe_key', v_dedupe);
end $$;
revoke all on function upsert_outbound_prospect(uuid,text,text,text,text,numeric,text,jsonb) from public;
grant execute on function upsert_outbound_prospect(uuid,text,text,text,text,numeric,text,jsonb) to service_role;

create or replace function enroll_outbound_prospect(
  p_tenant_id   uuid,
  p_prospect_id uuid,
  p_sequence_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_state text;
begin
  if p_tenant_id is null or p_prospect_id is null or p_sequence_id is null then
    raise exception 'enroll_outbound_prospect: null argument' using errcode = '22023';
  end if;

  if not exists (select 1 from outbound_sequences
                  where id = p_sequence_id and tenant_id = p_tenant_id) then
    return jsonb_build_object('ok', false, 'reason', 'sequence_not_found');
  end if;

  select qualification_state into v_state from outbound_prospects
    where id = p_prospect_id and tenant_id = p_tenant_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'prospect_not_found');
  end if;
  if v_state = 'unsubscribed' then
    return jsonb_build_object('ok', false, 'reason', 'unsubscribed');
  end if;

  update outbound_prospects
    set sequence_id     = p_sequence_id,
        sequence_step   = 0,
        next_action_at  = now(),
        sequence_state  = 'active',
        updated_at      = now()
    where id = p_prospect_id and tenant_id = p_tenant_id
      and sequence_state <> 'stopped';

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'stopped_or_missing');
  end if;

  return jsonb_build_object('ok', true);
end $$;
revoke all on function enroll_outbound_prospect(uuid,uuid,uuid) from public;
grant execute on function enroll_outbound_prospect(uuid,uuid,uuid) to service_role;

create or replace function claim_due_outbound_prospects(
  p_limit int default 100
) returns setof outbound_prospects
language sql security definer set search_path = public as $$
  select * from outbound_prospects
   where sequence_state = 'active'
     and next_action_at is not null
     and next_action_at <= now()
     and qualification_state not in ('unsubscribed','replied','disqualified')
   order by next_action_at asc
   limit p_limit;
$$;
revoke all on function claim_due_outbound_prospects(int) from public;
grant execute on function claim_due_outbound_prospects(int) to service_role;

create or replace function advance_outbound_prospect(
  p_tenant_id   uuid,
  p_prospect_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_prospect   outbound_prospects;
  v_steps      jsonb;
  v_total      int;
  v_next_step  int;
  v_wait_hours int;
begin
  if p_tenant_id is null or p_prospect_id is null then
    raise exception 'advance_outbound_prospect: null argument' using errcode = '22023';
  end if;

  select * into v_prospect from outbound_prospects
    where id = p_prospect_id and tenant_id = p_tenant_id
    for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'prospect_not_found');
  end if;

  if v_prospect.qualification_state in ('unsubscribed','replied','disqualified') then
    return jsonb_build_object('ok', false, 'reason', 'stopped:' || v_prospect.qualification_state);
  end if;

  select steps into v_steps from outbound_sequences
    where id = v_prospect.sequence_id and tenant_id = p_tenant_id;
  if v_steps is null then
    return jsonb_build_object('ok', false, 'reason', 'sequence_not_found');
  end if;

  v_total     := coalesce(jsonb_array_length(v_steps), 0);
  v_next_step := v_prospect.sequence_step + 1;

  update outbound_prospects
    set last_contacted_at = now(),
        qualification_state = case
          when qualification_state in ('new','qualified') then 'contacted'
          else qualification_state end,
        updated_at = now()
    where id = p_prospect_id;

  if v_next_step >= v_total then
    update outbound_prospects
      set sequence_state = 'completed',
          next_action_at = null,
          sequence_step  = v_next_step,
          updated_at     = now()
      where id = p_prospect_id;
    return jsonb_build_object('ok', true, 'completed', true, 'step', v_next_step);
  end if;

  v_wait_hours := coalesce((v_steps -> v_next_step ->> 'wait_hours')::int, 24);
  update outbound_prospects
    set sequence_step  = v_next_step,
        next_action_at = now() + (v_wait_hours || ' hours')::interval,
        updated_at     = now()
    where id = p_prospect_id;

  return jsonb_build_object('ok', true, 'completed', false, 'step', v_next_step, 'wait_hours', v_wait_hours);
end $$;
revoke all on function advance_outbound_prospect(uuid,uuid) from public;
grant execute on function advance_outbound_prospect(uuid,uuid) to service_role;

create or replace function stop_outbound_prospect(
  p_tenant_id   uuid,
  p_prospect_id uuid,
  p_reason      text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_prospect outbound_prospects;
  v_qual     text;
begin
  if p_tenant_id is null or p_prospect_id is null or p_reason is null then
    raise exception 'stop_outbound_prospect: null argument' using errcode = '22023';
  end if;
  if p_reason not in ('replied','unsubscribed','manual') then
    raise exception 'stop_outbound_prospect: invalid reason %', p_reason using errcode = '22023';
  end if;

  select * into v_prospect from outbound_prospects
    where id = p_prospect_id and tenant_id = p_tenant_id
    for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'prospect_not_found');
  end if;

  v_qual := case
    when p_reason = 'replied'      then 'replied'
    when p_reason = 'unsubscribed' then 'unsubscribed'
    else v_prospect.qualification_state
  end;

  update outbound_prospects
    set sequence_state      = 'stopped',
        next_action_at      = null,
        qualification_state = v_qual,
        updated_at          = now()
    where id = p_prospect_id;

  if p_reason = 'unsubscribed' then
    perform comms_unsubscribe(p_tenant_id, v_prospect.channel, lower(trim(v_prospect.handle)));
  end if;

  return jsonb_build_object('ok', true, 'reason', p_reason, 'qualification_state', v_qual);
end $$;
revoke all on function stop_outbound_prospect(uuid,uuid,text) from public;
grant execute on function stop_outbound_prospect(uuid,uuid,text) to service_role;
