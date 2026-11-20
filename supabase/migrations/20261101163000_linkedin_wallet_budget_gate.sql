begin;
do $$
declare r record; original text; seen integer:=0;
begin
 for r in select oid from pg_proc where pronamespace='public'::regnamespace and proname in ('reserve_ad_spend','rebase_ad_spend_for_object') loop
  original:=pg_get_functiondef(r.oid);
  if position('not in (''meta'', ''google'', ''x'', ''reddit'', ''chatgpt'', ''tiktok'')' in original)=0 then
   raise exception 'LinkedIn budget migration: unexpected function body %',r.oid::regproc;
  end if;
  execute replace(original,'not in (''meta'', ''google'', ''x'', ''reddit'', ''chatgpt'', ''tiktok'')','not in (''meta'', ''google'', ''x'', ''reddit'', ''chatgpt'', ''tiktok'', ''linkedin'')');
  seen:=seen+1;
 end loop;
 select oid into r from pg_proc where pronamespace='public'::regnamespace and proname='shrink_underdelivering_ad_holds';
 original:=pg_get_functiondef(r.oid);
 if position('r.platform not in (''chatgpt'', ''x'', ''tiktok'')' in original)=0 then raise exception 'LinkedIn shrink guard requires expected function'; end if;
 execute replace(original,'r.platform not in (''chatgpt'', ''x'', ''tiktok'')','r.platform not in (''chatgpt'', ''x'', ''tiktok'', ''linkedin'')');
 if seen<>2 then raise exception 'LinkedIn budget migration requires both existing budget functions'; end if;
 for r in select conname,pg_get_constraintdef(oid) as definition from pg_constraint
 where contype='c' and conrelid='public.ad_budget_reservations'::regclass and pg_get_constraintdef(oid) like '%platform%' loop
  if position('''tiktok''::text' in r.definition)=0 then raise exception 'LinkedIn budget migration: unexpected platform constraint'; end if;
  execute format('alter table public.ad_budget_reservations drop constraint %I',r.conname);
  execute format('alter table public.ad_budget_reservations add constraint %I %s',r.conname,replace(r.definition,'''tiktok''::text','''tiktok''::text, ''linkedin''::text'));
 end loop;
 if not found then raise exception 'LinkedIn budget platform constraint missing'; end if;
end $$;

create function public.ads_linkedin_ledger_identity() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare a ads_provider_accounts%rowtype;
begin
 select * into strict a from ads_provider_accounts where id=new.account_id;
 if a.platform='linkedin' then
  update ad_campaigns set object_id=new.id::text,campaign_id=new.id::text
   where tenant_id=new.tenant_id and platform='linkedin' and account_id=a.provider_account_id and object_id=new.provider_campaign_id;
  update ad_spend_daily set object_id=new.id::text
   where tenant_id=new.tenant_id and platform='linkedin' and account_id=a.provider_account_id and object_id=new.provider_campaign_id;
 end if;
 return new;
end $$;
create trigger ads_linkedin_ledger_identity after insert on public.ads_campaign_bindings for each row execute function public.ads_linkedin_ledger_identity();
revoke all on function public.ads_linkedin_ledger_identity() from public,anon,authenticated;
commit;
