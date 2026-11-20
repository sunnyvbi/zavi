
begin;

alter table public.start_cards
  add column if not exists funding_kind text not null default 'public_budget',
  add column if not exists funding_tenant_id uuid,
  add column if not exists requested_by_run_id uuid,
  add column if not exists tool_call_id text,
  add column if not exists delivery_state text,
  add column if not exists delivery_target jsonb,
  add column if not exists funding_settled_at timestamptz;

alter table public.start_cards drop constraint if exists start_cards_funding_kind_chk;
alter table public.start_cards add constraint start_cards_funding_kind_chk
  check (funding_kind in ('public_budget', 'tenant_credits'));

alter table public.start_cards drop constraint if exists start_cards_delivery_state_chk;
alter table public.start_cards add constraint start_cards_delivery_state_chk
  check (delivery_state is null or delivery_state in ('waiting', 'returned', 'pending', 'delivered'));

alter table public.start_cards drop constraint if exists start_cards_funding_ref_chk;
alter table public.start_cards add constraint start_cards_funding_ref_chk check (
  (funding_kind = 'public_budget'
     and funding_tenant_id is null and requested_by_run_id is null
     and tool_call_id is null and delivery_state is null)
  or
  (funding_kind = 'tenant_credits'
     and funding_tenant_id is not null and requested_by_run_id is not null
     and tool_call_id is not null and length(tool_call_id) between 1 and 200
     and delivery_state is not null and budget_day is null)
);

create unique index if not exists start_cards_tool_call_uq
  on public.start_cards (requested_by_run_id, tool_call_id)
  where requested_by_run_id is not null;

create or replace function public.start_card_claim(
  p_domain           text,
  p_since            timestamptz,
  p_public_id        text,
  p_parts            jsonb,
  p_ip_hash          text,
  p_referrer_card_id uuid,
  p_budget_day       date,
  p_reserved_usd     numeric,
  p_funding_kind     text,
  p_tenant_id        uuid,
  p_run_id           uuid,
  p_tool_call_id     text,
  p_delivery_target  jsonb,
  p_run_cap          int
) returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_id     uuid;
  v_pub    text;
  v_status text;
  v_tenant uuid;
  v_run_st text;
  v_stop   boolean;
  v_count  int;
begin
  if nullif(p_domain, '') is null or p_since is null or nullif(p_public_id, '') is null
     or p_funding_kind not in ('public_budget', 'tenant_credits') then
    raise exception 'start_card_claim: domain, since, public_id and a known funding kind are required'
      using errcode = '22023';
  end if;

  if p_funding_kind = 'tenant_credits' then
    if p_tenant_id is null or p_run_id is null or nullif(p_tool_call_id, '') is null then
      raise exception 'start_card_claim: a tenant card needs tenant, run and tool call'
        using errcode = '22023';
    end if;
    select tenant_id, status, coalesce(stop_requested, false)
      into v_tenant, v_run_st, v_stop
      from agent_runs where id = p_run_id;
    if v_tenant is null then
      raise exception 'start_card_claim: no such run' using errcode = '22023';
    end if;
    if v_tenant is distinct from p_tenant_id then
      raise exception 'tenant_mismatch' using errcode = '42501';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('start_card_run:' || p_run_id::text, 0));
    select id, public_id, status into v_id, v_pub, v_status
      from start_cards
     where requested_by_run_id = p_run_id and tool_call_id = p_tool_call_id;
    if v_id is not null then
      return jsonb_build_object('outcome', 'same_call', 'id', v_id, 'public_id', v_pub, 'status', v_status);
    end if;
    if v_run_st is distinct from 'running' or v_stop then
      return jsonb_build_object('outcome', 'run_not_running');
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('start_card_domain:' || lower(p_domain), 0));

  select id, public_id, status into v_id, v_pub, v_status
    from start_cards
   where domain = p_domain
     and created_at >= p_since
     and status in ('running', 'done')
     and revoked_at is null
   order by created_at desc
   limit 1;
  if v_id is not null then
    return jsonb_build_object('outcome', 'reused', 'id', v_id, 'public_id', v_pub, 'status', v_status);
  end if;

  if p_funding_kind = 'tenant_credits' then
    select count(*) into v_count from start_cards where requested_by_run_id = p_run_id;
    if v_count >= least(coalesce(p_run_cap, 1), 1) then
      return jsonb_build_object('outcome', 'run_cap', 'count', v_count);
    end if;
  end if;

  insert into start_cards (
    public_id, domain, ip_hash, referrer_card_id, budget_day, reserved_usd, status, parts,
    funding_kind, funding_tenant_id, requested_by_run_id, tool_call_id, delivery_state, delivery_target
  ) values (
    p_public_id, p_domain, p_ip_hash, p_referrer_card_id,
    case when p_funding_kind = 'public_budget' then p_budget_day else null end,
    coalesce(p_reserved_usd, 0), 'running', coalesce(p_parts, '{}'::jsonb),
    p_funding_kind,
    case when p_funding_kind = 'tenant_credits' then p_tenant_id else null end,
    case when p_funding_kind = 'tenant_credits' then p_run_id else null end,
    case when p_funding_kind = 'tenant_credits' then p_tool_call_id else null end,
    case when p_funding_kind = 'tenant_credits' then 'waiting' else null end,
    case when p_funding_kind = 'tenant_credits' then p_delivery_target else null end
  )
  returning id, public_id into v_id, v_pub;

  return jsonb_build_object('outcome', 'created', 'id', v_id, 'public_id', v_pub, 'status', 'running');
end $$;

revoke all on function public.start_card_claim(text, timestamptz, text, jsonb, text, uuid, date, numeric, text, uuid, uuid, text, jsonb, int) from public, anon, authenticated;
grant execute on function public.start_card_claim(text, timestamptz, text, jsonb, text, uuid, date, numeric, text, uuid, uuid, text, jsonb, int) to service_role;

do $$
begin
  raise notice '20261007120000: start card funding columns + atomic domain claim';
end $$;

commit;
