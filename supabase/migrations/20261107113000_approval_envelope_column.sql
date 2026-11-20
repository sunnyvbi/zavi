begin;

alter table public.channel_actions add column if not exists approval_envelope jsonb
  check (approval_envelope is null or (jsonb_typeof(approval_envelope) = 'object' and octet_length(approval_envelope::text) <= 2048));
alter table public.decisions add column if not exists approval_envelope jsonb
  check (approval_envelope is null or (jsonb_typeof(approval_envelope) = 'object' and octet_length(approval_envelope::text) <= 2048));

create or replace function public._approval_envelope_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.approval_envelope is not null and coalesce(current_setting('zavi.approval_envelope_write', true), '') <> 'on' then
      raise exception 'approval_envelope is written only by set_approval_envelope';
    end if;
    return new;
  end if;
  if new.approval_envelope is distinct from old.approval_envelope then
    if coalesce(current_setting('zavi.approval_envelope_write', true), '') <> 'on' then
      raise exception 'approval_envelope is written only by set_approval_envelope';
    end if;
    if old.approval_envelope is not null then
      raise exception 'approval_envelope is write-once';
    end if;
  end if;
  return new;
end $$;
revoke all on function public._approval_envelope_guard() from public, anon, authenticated;

drop trigger if exists channel_actions_approval_envelope_guard on public.channel_actions;
create trigger channel_actions_approval_envelope_guard
  before insert or update on public.channel_actions
  for each row execute function public._approval_envelope_guard();
drop trigger if exists decisions_approval_envelope_guard on public.decisions;
create trigger decisions_approval_envelope_guard
  before insert or update on public.decisions
  for each row execute function public._approval_envelope_guard();

create or replace function public.set_approval_envelope(
  p_tenant_id uuid,
  p_table     text,
  p_row_id    uuid,
  p_envelope  jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_have   jsonb;
  v_status text;
  v_exec   text;
begin
  if p_tenant_id is null or p_row_id is null or p_table is null or p_table not in ('channel_actions', 'decisions') then
    raise exception 'set_approval_envelope: tenant, table and row are required';
  end if;
  if p_envelope is null or jsonb_typeof(p_envelope) <> 'object'
     or (p_envelope->>'v') is distinct from '1'
     or coalesce(p_envelope->>'envelope_id', '') = ''
     or coalesce(p_envelope->>'actor_user_id', '') = ''
     or (p_envelope->>'actor_role') not in ('owner', 'admin')
     or (p_envelope->>'surface') not in ('chat', 'email', 'slack', 'web_button', 'cgo_yes')
     or coalesce(p_envelope->>'channel', '') = ''
     or jsonb_typeof(p_envelope->'max_total_usd') <> 'number' or (p_envelope->>'max_total_usd')::numeric <= 0
     or coalesce(p_envelope->>'starts_on', '') !~ '^\d{4}-\d{2}-\d{2}$'
     or coalesce(p_envelope->>'ends_on', '') !~ '^\d{4}-\d{2}-\d{2}$'
     or (p_envelope->>'ends_on') <= (p_envelope->>'starts_on') then
    return jsonb_build_object('ok', false, 'code', 'invalid_envelope');
  end if;
  if (p_envelope->>'tenant_id') is distinct from p_tenant_id::text then
    return jsonb_build_object('ok', false, 'code', 'wrong_tenant');
  end if;

  if p_table = 'channel_actions' then
    select approval_envelope, status, exec_status into v_have, v_status, v_exec
      from channel_actions where id = p_row_id and tenant_id = p_tenant_id for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
    if v_have is not null then
      return case when v_have = p_envelope then jsonb_build_object('ok', true, 'replayed', true)
                  else jsonb_build_object('ok', false, 'code', 'already_set') end;
    end if;
    if v_status <> 'pending' or v_exec is not null then
      return jsonb_build_object('ok', false, 'code', 'not_pending');
    end if;
    perform set_config('zavi.approval_envelope_write', 'on', true);
    update channel_actions set approval_envelope = p_envelope where id = p_row_id and tenant_id = p_tenant_id;
  else
    select approval_envelope, status into v_have, v_status
      from decisions where id = p_row_id and tenant_id = p_tenant_id for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
    if v_have is not null then
      return case when v_have = p_envelope then jsonb_build_object('ok', true, 'replayed', true)
                  else jsonb_build_object('ok', false, 'code', 'already_set') end;
    end if;
    if v_status <> 'proposed' then
      return jsonb_build_object('ok', false, 'code', 'not_pending');
    end if;
    perform set_config('zavi.approval_envelope_write', 'on', true);
    update decisions set approval_envelope = p_envelope where id = p_row_id and tenant_id = p_tenant_id;
  end if;
  perform set_config('zavi.approval_envelope_write', 'off', true);
  return jsonb_build_object('ok', true);
end $$;

create table if not exists public.approval_envelope_claims (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  envelope_id text not null check (char_length(envelope_id) between 1 and 200),
  action_id   uuid not null,
  status      text not null default 'active' check (status in ('active', 'released')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, envelope_id)
);
create table if not exists public.approval_envelope_claim_history (
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  envelope_id   text not null,
  action_id     uuid not null,
  replaced_by   uuid not null,
  replaced_at   timestamptz not null default now()
);
alter table public.approval_envelope_claims enable row level security;
alter table public.approval_envelope_claim_history enable row level security;
revoke all on public.approval_envelope_claims from public, anon, authenticated;
revoke all on public.approval_envelope_claim_history from public, anon, authenticated;
grant all on public.approval_envelope_claims to service_role;
grant all on public.approval_envelope_claim_history to service_role;

create or replace function public.claim_approval_envelope(
  p_tenant_id     uuid,
  p_envelope_id   text,
  p_action_id     uuid,
  p_takeover_from uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_claim approval_envelope_claims%rowtype;
  v_dead  boolean;
begin
  if p_tenant_id is null or p_action_id is null or coalesce(p_envelope_id, '') = '' then
    raise exception 'claim_approval_envelope: tenant, envelope and action are required';
  end if;
  if not exists (select 1 from channel_actions where id = p_action_id and tenant_id = p_tenant_id) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  insert into approval_envelope_claims (tenant_id, envelope_id, action_id)
  values (p_tenant_id, p_envelope_id, p_action_id)
  on conflict (tenant_id, envelope_id) do nothing
  returning * into v_claim;
  if found then
    return jsonb_build_object('ok', true, 'holder', p_action_id);
  end if;
  select * into v_claim from approval_envelope_claims
   where tenant_id = p_tenant_id and envelope_id = p_envelope_id for update;
  if v_claim.action_id = p_action_id then
    return jsonb_build_object('ok', true, 'holder', p_action_id, 'replayed', true);
  end if;
  if p_takeover_from is null or v_claim.action_id <> p_takeover_from then
    return jsonb_build_object('ok', false, 'code', 'claimed', 'holder', v_claim.action_id);
  end if;
  select (a.exec_status = 'failed' or a.status = 'rejected')
         and coalesce(a.exec_result->'created', 'null'::jsonb) in ('null'::jsonb, '[]'::jsonb, '{}'::jsonb)
         and coalesce(a.exec_result->>'code', '') not in ('exec_outcome_unknown', 'exec_partial')
         and not exists (select 1 from ad_object_changes c
                          where c.tenant_id = p_tenant_id and c.action_table = 'channel_actions' and c.action_id = a.id)
    into v_dead
    from channel_actions a
   where a.id = v_claim.action_id and a.tenant_id = p_tenant_id
   for update;
  if not coalesce(v_dead, false) then
    return jsonb_build_object('ok', false, 'code', 'holder_live', 'holder', v_claim.action_id);
  end if;
  insert into approval_envelope_claim_history (tenant_id, envelope_id, action_id, replaced_by)
  values (p_tenant_id, p_envelope_id, v_claim.action_id, p_action_id);
  update approval_envelope_claims
     set action_id = p_action_id, status = 'active', updated_at = now()
   where tenant_id = p_tenant_id and envelope_id = p_envelope_id and action_id = p_takeover_from;
  return jsonb_build_object('ok', true, 'holder', p_action_id, 'took_over_from', p_takeover_from);
end $$;

revoke all on function public.set_approval_envelope(uuid, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.set_approval_envelope(uuid, text, uuid, jsonb) to service_role;
revoke all on function public.claim_approval_envelope(uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_approval_envelope(uuid, text, uuid, uuid) to service_role;

commit;
