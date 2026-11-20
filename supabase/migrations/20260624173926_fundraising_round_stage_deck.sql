
alter table fundraising_round_config
  add column if not exists stage text
    check (stage in ('Angel', 'Pre-seed', 'Seed', 'Series A', 'Series B+'));

alter table fundraising_round_config
  add column if not exists deck_url text;

drop function if exists fundraising_set_round_config(uuid, text, text, text, text, text);

create or replace function fundraising_set_round_config(
  p_tenant_id  uuid,
  p_ask        text,
  p_instrument text,
  p_thesis     text,
  p_proof      text,
  p_send_mode  text default 'off',
  p_stage      text default null,
  p_deck_url   text default null
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_send_mode text := coalesce(nullif(p_send_mode, ''), 'off');
  v_stage     text := nullif(p_stage, '');
begin
  if p_tenant_id is null then
    raise exception 'fundraising_set_round_config: tenant_id required' using errcode = '22023';
  end if;
  if v_send_mode not in ('off', 'test', 'live') then
    raise exception 'fundraising_set_round_config: invalid send_mode %', v_send_mode using errcode = '22023';
  end if;
  if v_stage is not null and v_stage not in ('Angel', 'Pre-seed', 'Seed', 'Series A', 'Series B+') then
    raise exception 'fundraising_set_round_config: invalid stage %', v_stage using errcode = '22023';
  end if;
  if auth.uid() is not null then
    if not exists (
      select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  insert into fundraising_round_config
    (tenant_id, ask, instrument, thesis, proof, send_mode, stage, deck_url, updated_by, updated_at)
  values
    (p_tenant_id, p_ask, p_instrument, p_thesis, p_proof, v_send_mode, v_stage, p_deck_url, auth.uid(), now())
  on conflict (tenant_id) do update set
    ask        = excluded.ask,
    instrument = excluded.instrument,
    thesis     = excluded.thesis,
    proof      = excluded.proof,
    send_mode  = excluded.send_mode,
    stage      = excluded.stage,
    deck_url   = excluded.deck_url,
    updated_by = excluded.updated_by,
    updated_at = now();
end $$;

revoke all on function fundraising_set_round_config(uuid, text, text, text, text, text, text, text) from public;
grant execute on function fundraising_set_round_config(uuid, text, text, text, text, text, text, text) to authenticated;
grant execute on function fundraising_set_round_config(uuid, text, text, text, text, text, text, text) to service_role;

create or replace function fundraising_set_round_stage(
  p_tenant_id uuid,
  p_stage     text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null then
    raise exception 'fundraising_set_round_stage: tenant_id required' using errcode = '22023';
  end if;
  if p_stage is not null and p_stage not in ('Angel','Pre-seed','Seed','Series A','Series B+') then
    raise exception 'fundraising_set_round_stage: invalid stage %', p_stage using errcode = '22023';
  end if;
  if auth.uid() is not null then
    if not exists (
      select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  insert into fundraising_round_config (tenant_id, stage, updated_by, updated_at)
  values (p_tenant_id, p_stage, auth.uid(), now())
  on conflict (tenant_id) do update set
    stage      = excluded.stage,
    updated_by = excluded.updated_by,
    updated_at = now();
end $$;

revoke all on function fundraising_set_round_stage(uuid, text) from public;
grant execute on function fundraising_set_round_stage(uuid, text) to authenticated;
grant execute on function fundraising_set_round_stage(uuid, text) to service_role;
