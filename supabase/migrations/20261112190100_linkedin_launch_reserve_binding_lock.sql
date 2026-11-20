
create or replace function public.ads_reserve_linkedin_launch(p_tenant_id uuid,p_campaign_binding_id uuid,p_lifetime_cents bigint,p_observed_spend_cents bigint) returns bigint
language plpgsql security definer set search_path=public,pg_temp as $$
declare f ads_campaign_reservations%rowtype; prior bigint:=0;
begin
 perform 1 from ads_campaign_binding_details where id=p_campaign_binding_id and tenant_id=p_tenant_id and platform='linkedin' and funding_source='wallet';
 if not found then raise exception 'wallet-funded LinkedIn binding required'; end if;
 perform 1 from ads_campaign_bindings where id=p_campaign_binding_id and tenant_id=p_tenant_id for no key update;
 if not found then raise exception 'wallet-funded LinkedIn binding required'; end if;
 perform 1 from ads_wallets where tenant_id=p_tenant_id for update;
 select * into f from ads_campaign_reservations where tenant_id=p_tenant_id and campaign_binding_id=p_campaign_binding_id;
 if found then prior:=greatest(0,f.reserved_cents-greatest(0,p_observed_spend_cents-f.spent_cents)); end if;
 perform ads_wallet_reserve_bound(p_tenant_id,p_campaign_binding_id,p_lifetime_cents,p_observed_spend_cents);
 update ads_campaign_lifecycle set activation_attempted_at=clock_timestamp() where tenant_id=p_tenant_id and campaign_binding_id=p_campaign_binding_id;
 if not found then raise exception 'launch inventory required'; end if;
 delete from ads_campaign_spend_stability where tenant_id=p_tenant_id and campaign_binding_id=p_campaign_binding_id;
 return prior;
end $$;
revoke all on function public.ads_reserve_linkedin_launch(uuid,uuid,bigint,bigint) from public,anon,authenticated;
grant execute on function public.ads_reserve_linkedin_launch(uuid,uuid,bigint,bigint) to service_role;
