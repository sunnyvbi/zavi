
alter table public.seed_run_items add column if not exists contact_checked_at timestamptz;

create index if not exists seed_notices_pending_idx on public.seed_notices (created_at) where state = 'pending';
create index if not exists seed_notices_claimed_at_idx on public.seed_notices (claimed_at) where claimed_at is not null;
create index if not exists seed_notices_card_idx on public.seed_notices (card_id) where card_id is not null;
create index if not exists seed_run_items_run_state_idx on public.seed_run_items (run_id, state, domain);
create index if not exists seed_run_items_unchecked_idx on public.seed_run_items (run_id, domain)
  where state = 'done' and contact_checked_at is null and card_id is not null;
create index if not exists start_cards_revoked_domain_idx on public.start_cards (domain) where revoked_at is not null;

create or replace function public.seed_notice_claim_capped(p_domain text, p_per_day int)
returns jsonb language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_today timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  v_count int;
begin
  if p_per_day is null or p_per_day < 1 then
    raise exception 'seed_notice_claim_capped: a positive daily cap is required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('seed_notice_daily_cap', 0));
  select count(*) into v_count from seed_notices where claimed_at >= v_today;
  if v_count >= p_per_day then
    return jsonb_build_object('outcome', 'day_cap', 'claimed_today', v_count);
  end if;
  return seed_notice_claim(p_domain);
end $$;

create or replace function public.seed_notice_unsubscribe(p_key text)
returns jsonb language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_domain text;
  v_card   uuid;
begin
  if nullif(btrim(p_key), '') is null or length(p_key) > 100 then
    return jsonb_build_object('outcome', 'unknown');
  end if;
  select domain, card_id into v_domain, v_card from seed_notices where idempotency_key = p_key;
  if v_domain is null then return jsonb_build_object('outcome', 'unknown'); end if;
  if v_card is not null then
    update start_cards set revoked_at = now(), updated_at = now() where id = v_card and revoked_at is null;
  end if;
  insert into seed_suppressions (domain, reason) values (v_domain, 'owner_removed') on conflict (domain) do nothing;
  return jsonb_build_object('outcome', 'removed', 'domain', v_domain);
end $$;

revoke all on function public.seed_notice_claim_capped(text, int) from public, anon, authenticated;
revoke all on function public.seed_notice_unsubscribe(text) from public, anon, authenticated;
grant execute on function public.seed_notice_claim_capped(text, int) to service_role;
grant execute on function public.seed_notice_unsubscribe(text) to service_role;
