begin;
create function public.ads_wallet_finalize_campaign(p_tenant_id uuid, p_campaign_id text, p_final_spend_cents bigint)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare f ads_campaign_funding%rowtype; delta bigint;
begin
 if p_final_spend_cents < 0 then raise exception 'invalid spend'; end if;
 perform 1 from ads_wallets where tenant_id = p_tenant_id for update;
 select * into f from ads_campaign_funding where tenant_id = p_tenant_id and campaign_id = p_campaign_id for update;
 if not found then return; end if;
 delta := greatest(0, p_final_spend_cents - f.spent_cents);
 update ads_wallets set balance_cents = balance_cents - delta, updated_at = now() where tenant_id = p_tenant_id;
 update ads_campaign_funding set spent_cents = greatest(spent_cents, p_final_spend_cents), reserved_cents = 0, updated_at = now()
  where tenant_id = p_tenant_id and campaign_id = p_campaign_id;
end $$;
revoke all on function public.ads_wallet_finalize_campaign(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.ads_wallet_finalize_campaign(uuid, text, bigint) to service_role;
commit;
