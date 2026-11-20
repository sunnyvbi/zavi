begin;
create table public.ads_provider_accounts (
 id uuid primary key default gen_random_uuid(),
 platform text not null check (platform ~ '^[a-z][a-z0-9_]*$'),
 provider_account_id text check (length(provider_account_id) between 1 and 200),
 credential_source text not null check (credential_source in ('platform','tenant_connector')),
 credential_ref text not null check (length(credential_ref) between 1 and 200),
 credential_tenant_id uuid references public.tenants(id) on delete cascade,
 currency text check (currency ~ '^[A-Z]{3}$'),
 legacy_key text unique check (legacy_key is null or legacy_key = 'chatgpt_platform'),
 verified_at timestamptz,
 unique(platform,provider_account_id),
 check ((credential_source='platform' and credential_tenant_id is null) or
        (credential_source='tenant_connector' and credential_tenant_id is not null)),
 check ((provider_account_id is not null and currency is not null and verified_at is not null) or
        (legacy_key is not null and legacy_key='chatgpt_platform' and provider_account_id is null and currency is null and verified_at is null)),
 check (legacy_key is null or (platform='chatgpt' and credential_source='platform' and credential_ref='chatgpt_ads_api_key'))
);
insert into public.ads_provider_accounts(platform,credential_source,credential_ref,legacy_key)
 values('chatgpt','platform','chatgpt_ads_api_key','chatgpt_platform');

create table public.ads_account_bindings (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 account_id uuid not null references public.ads_provider_accounts(id),
 funding_source text not null check (funding_source in ('wallet','provider')),
 created_at timestamptz not null default now(),
 unique(tenant_id,account_id), unique(id,tenant_id,account_id), unique(id,tenant_id)
);
create table public.ads_account_selections (
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 platform text not null,
 account_binding_id uuid not null,
 primary key(tenant_id,platform),
 foreign key(account_binding_id,tenant_id) references public.ads_account_bindings(id,tenant_id)
);
create table public.ads_campaign_bindings (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 account_binding_id uuid not null,
 account_id uuid not null,
 provider_campaign_id text not null check (length(provider_campaign_id) between 1 and 200),
 created_at timestamptz not null default now(),
 unique(account_id,provider_campaign_id), unique(id,tenant_id),
 foreign key(account_binding_id,tenant_id,account_id) references public.ads_account_bindings(id,tenant_id,account_id)
);
create table public.ads_campaign_create_requests (
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 platform text not null,
 request_id uuid not null,
 account_binding_id uuid not null,
 created_at timestamptz not null default now(),
 primary key(tenant_id,platform,request_id),
 foreign key(account_binding_id,tenant_id) references public.ads_account_bindings(id,tenant_id)
);
create index on public.ads_account_bindings(tenant_id);
create index on public.ads_campaign_bindings(tenant_id);

create function public.ads_legacy_account_binding(p_tenant_id uuid) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare a uuid; b uuid;
begin
 select id into strict a from ads_provider_accounts where legacy_key='chatgpt_platform';
 insert into ads_account_bindings(tenant_id,account_id,funding_source) values(p_tenant_id,a,'wallet') on conflict(tenant_id,account_id) do nothing;
 select id into strict b from ads_account_bindings where tenant_id=p_tenant_id and account_id=a;
 return b;
end $$;

create function public.ads_legacy_campaign_binding(p_tenant_id uuid,p_campaign_id text) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare b uuid; a uuid; c ads_campaign_bindings%rowtype;
begin
 b:=ads_legacy_account_binding(p_tenant_id);
 select account_id into strict a from ads_account_bindings where id=b and tenant_id=p_tenant_id;
 insert into ads_campaign_bindings(tenant_id,account_binding_id,account_id,provider_campaign_id)
 values(p_tenant_id,b,a,p_campaign_id) on conflict(account_id,provider_campaign_id) do nothing;
 select * into strict c from ads_campaign_bindings where account_id=a and provider_campaign_id=p_campaign_id;
 if c.tenant_id<>p_tenant_id then raise exception 'campaign ownership conflict'; end if;
 return c.id;
end $$;

alter table public.ads_campaign_funding rename to ads_campaign_reservations;
alter table public.ads_campaign_reservations add column campaign_binding_id uuid;
update public.ads_campaign_reservations set campaign_binding_id=public.ads_legacy_campaign_binding(tenant_id,campaign_id);
alter table public.ads_campaign_reservations drop constraint ads_campaign_funding_pkey;
alter table public.ads_campaign_reservations alter column campaign_binding_id set not null;
alter table public.ads_campaign_reservations add primary key(campaign_binding_id);
alter table public.ads_campaign_reservations add foreign key(campaign_binding_id,tenant_id) references public.ads_campaign_bindings(id,tenant_id) on delete cascade;

create view public.ads_account_binding_details as
 select b.id,b.tenant_id,b.account_id,b.funding_source,a.platform,a.provider_account_id,
 a.credential_source,a.credential_ref,a.credential_tenant_id,a.currency,a.verified_at,a.legacy_key
 from public.ads_account_bindings b join public.ads_provider_accounts a on a.id=b.account_id;
create view public.ads_campaign_binding_details as
 select c.id,c.tenant_id,c.account_binding_id,c.account_id,c.provider_campaign_id,a.platform,b.funding_source
 from public.ads_campaign_bindings c join public.ads_provider_accounts a on a.id=c.account_id
 join public.ads_account_bindings b on b.id=c.account_binding_id;
create view public.ads_campaign_funding as
 select r.campaign_id,r.tenant_id,r.reserved_cents,r.spent_cents,r.baseline_cents,r.updated_at,
 r.daily_max_micros,r.coverage_start,r.coverage_end
 from public.ads_campaign_reservations r join public.ads_campaign_bindings c on c.id=r.campaign_binding_id
 join public.ads_provider_accounts a on a.id=c.account_id where a.legacy_key='chatgpt_platform';

create function public.ads_account_binding_owner() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare a ads_provider_accounts%rowtype;
begin
 select * into strict a from ads_provider_accounts where id=new.account_id;
 if a.credential_tenant_id is not null and a.credential_tenant_id<>new.tenant_id then raise exception 'credential tenant mismatch'; end if;
 if new.funding_source='wallet' and a.currency is not null and a.currency<>'USD' then raise exception 'ads currency unsupported'; end if;
 return new;
end $$;
create trigger ads_account_binding_owner before insert on public.ads_account_bindings for each row execute function public.ads_account_binding_owner();

create function public.ads_binding_immutable() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if to_jsonb(new) is distinct from to_jsonb(old) then raise exception 'ads binding is immutable'; end if;
 return new;
end $$;
create trigger ads_account_binding_immutable before update on public.ads_account_bindings for each row execute function public.ads_binding_immutable();
create trigger ads_campaign_binding_immutable before update on public.ads_campaign_bindings for each row execute function public.ads_binding_immutable();
create trigger ads_create_request_immutable before update on public.ads_campaign_create_requests for each row execute function public.ads_binding_immutable();
create function public.ads_provider_identity_immutable() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if (new.id,new.platform,new.credential_source,new.credential_ref,new.credential_tenant_id,new.legacy_key)
 is distinct from (old.id,old.platform,old.credential_source,old.credential_ref,old.credential_tenant_id,old.legacy_key)
 or (old.provider_account_id is not null and (new.provider_account_id,new.currency) is distinct from (old.provider_account_id,old.currency))
 then raise exception 'ads account identity is immutable'; end if;
 return new;
end $$;
create trigger ads_provider_identity_immutable before update on public.ads_provider_accounts for each row execute function public.ads_provider_identity_immutable();

create function public.ads_verify_account_binding(p_tenant_id uuid,p_binding_id uuid,p_provider_account_id text,p_currency text) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare a ads_provider_accounts%rowtype;
begin
 select a0.* into a from ads_provider_accounts a0 join ads_account_bindings b on b.account_id=a0.id
 where b.id=p_binding_id and b.tenant_id=p_tenant_id for update of a0;
 if not found then raise exception 'account binding not found'; end if;
 if p_provider_account_id is null or length(p_provider_account_id) not between 1 and 200 or p_currency is null or p_currency !~ '^[A-Z]{3}$' then raise exception 'invalid provider account'; end if;
 if a.provider_account_id is not null and (a.provider_account_id<>p_provider_account_id or a.currency<>p_currency) then raise exception 'ads account identity changed'; end if;
 update ads_provider_accounts set provider_account_id=p_provider_account_id,currency=p_currency,verified_at=now() where id=a.id;
end $$;

create function public.ads_bind_campaign(p_tenant_id uuid,p_account_binding_id uuid,p_provider_campaign_id text) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare a uuid; c ads_campaign_bindings%rowtype;
begin
 select b.account_id into a from ads_account_bindings b join ads_provider_accounts p on p.id=b.account_id
 where b.id=p_account_binding_id and b.tenant_id=p_tenant_id and p.verified_at is not null
 and (p.credential_tenant_id is null or p.credential_tenant_id=p_tenant_id);
 if not found then raise exception 'verified account binding required'; end if;
 insert into ads_campaign_bindings(tenant_id,account_binding_id,account_id,provider_campaign_id)
 values(p_tenant_id,p_account_binding_id,a,p_provider_campaign_id) on conflict(account_id,provider_campaign_id) do nothing;
 select * into strict c from ads_campaign_bindings where account_id=a and provider_campaign_id=p_provider_campaign_id;
 if c.tenant_id<>p_tenant_id or c.account_binding_id<>p_account_binding_id then raise exception 'campaign ownership conflict'; end if;
 return c.id;
end $$;

create function public.ads_select_account_binding(p_tenant_id uuid,p_binding_id uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare p text;
begin
 select a.platform into p from ads_account_bindings b join ads_provider_accounts a on a.id=b.account_id
 where b.id=p_binding_id and b.tenant_id=p_tenant_id and a.verified_at is not null
 and (a.credential_tenant_id is null or a.credential_tenant_id=p_tenant_id);
 if not found then raise exception 'verified account binding required'; end if;
 insert into ads_account_selections(tenant_id,platform,account_binding_id) values(p_tenant_id,p,p_binding_id)
 on conflict(tenant_id,platform) do update set account_binding_id=excluded.account_binding_id;
end $$;

create function public.ads_claim_campaign_account(p_tenant_id uuid,p_platform text,p_request_id uuid) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare b uuid;
begin
 select account_binding_id into b from ads_campaign_create_requests where tenant_id=p_tenant_id and platform=p_platform and request_id=p_request_id;
 if found then return b; end if;
 select account_binding_id into b from ads_account_selections where tenant_id=p_tenant_id and platform=p_platform;
 if b is null and p_platform='chatgpt' then b:=ads_legacy_account_binding(p_tenant_id); end if;
 if b is null then raise exception 'account selection required'; end if;
 insert into ads_campaign_create_requests(tenant_id,platform,request_id,account_binding_id) values(p_tenant_id,p_platform,p_request_id,b)
 on conflict(tenant_id,platform,request_id) do nothing;
 select account_binding_id into strict b from ads_campaign_create_requests where tenant_id=p_tenant_id and platform=p_platform and request_id=p_request_id;
 return b;
end $$;

create function public.ads_reservation_identity() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare raw_id text;
begin
 if tg_op='UPDATE' and (new.campaign_binding_id,new.tenant_id,new.campaign_id) is distinct from (old.campaign_binding_id,old.tenant_id,old.campaign_id) then raise exception 'reservation identity is immutable'; end if;
 select c.provider_campaign_id into raw_id from ads_campaign_bindings c join ads_account_bindings b on b.id=c.account_binding_id
 where c.id=new.campaign_binding_id and c.tenant_id=new.tenant_id and b.funding_source='wallet';
 if not found then raise exception 'wallet-funded campaign binding required'; end if;
 new.campaign_id:=raw_id;
 return new;
end $$;
create trigger ads_reservation_identity before insert or update on public.ads_campaign_reservations for each row execute function public.ads_reservation_identity();
create function public.ads_wallet_reserve_bound(p_tenant_id uuid,p_campaign_binding_id uuid,p_lifetime_cents bigint,p_observed_spend_cents bigint)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare w ads_wallets%rowtype; f ads_campaign_reservations%rowtype; other_reserved bigint; need bigint;
begin
 if p_lifetime_cents is null or p_observed_spend_cents is null or p_lifetime_cents<0 or p_observed_spend_cents<0 then raise exception 'invalid ads reservation'; end if;
 perform 1 from ads_campaign_bindings c join ads_account_bindings b on b.id=c.account_binding_id
 where c.id=p_campaign_binding_id and c.tenant_id=p_tenant_id and b.funding_source='wallet';
 if not found then raise exception 'wallet-funded campaign binding required'; end if;
 select * into w from ads_wallets where tenant_id=p_tenant_id for update;
 if not found then raise exception 'ads_balance_insufficient'; end if;
 select * into f from ads_campaign_reservations where campaign_binding_id=p_campaign_binding_id;
 if found and f.tenant_id<>p_tenant_id then raise exception 'campaign ownership conflict'; end if;
 if f.campaign_binding_id is null then
  insert into ads_campaign_reservations(campaign_binding_id,tenant_id,spent_cents,baseline_cents) values(p_campaign_binding_id,p_tenant_id,p_observed_spend_cents,p_observed_spend_cents);
  f.spent_cents:=p_observed_spend_cents; f.reserved_cents:=0;
 end if;
 if p_observed_spend_cents>f.spent_cents then
  w.balance_cents:=w.balance_cents-(p_observed_spend_cents-f.spent_cents);
  f.reserved_cents:=greatest(0,f.reserved_cents-(p_observed_spend_cents-f.spent_cents));
  f.spent_cents:=p_observed_spend_cents;
 end if;
 select coalesce(sum(reserved_cents),0) into other_reserved from ads_campaign_reservations where tenant_id=p_tenant_id and campaign_binding_id<>p_campaign_binding_id;
 need:=greatest(f.reserved_cents,p_lifetime_cents-f.spent_cents,0);
 if w.balance_cents-other_reserved<need then raise exception 'ads_balance_insufficient'; end if;
 update ads_wallets set balance_cents=w.balance_cents,updated_at=now() where tenant_id=p_tenant_id;
 update ads_campaign_reservations set reserved_cents=need,spent_cents=f.spent_cents,updated_at=now() where campaign_binding_id=p_campaign_binding_id;
end $$;

create function public.ads_wallet_settle_bound(p_tenant_id uuid,p_campaign_binding_id uuid,p_spend_cents bigint)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare f ads_campaign_reservations%rowtype; delta bigint;
begin
 if p_spend_cents is null or p_spend_cents<0 then raise exception 'invalid spend'; end if;
 perform 1 from ads_wallets where tenant_id=p_tenant_id for update;
 select * into f from ads_campaign_reservations where tenant_id=p_tenant_id and campaign_binding_id=p_campaign_binding_id for update;
 if not found then return; end if;
 delta:=greatest(0,p_spend_cents-f.spent_cents);
 update ads_wallets set balance_cents=balance_cents-delta,updated_at=now() where tenant_id=p_tenant_id;
 update ads_campaign_reservations set spent_cents=greatest(spent_cents,p_spend_cents), reserved_cents=greatest(0,reserved_cents-delta),updated_at=now() where campaign_binding_id=p_campaign_binding_id;
end $$;

create function public.ads_wallet_reserve_chatgpt_daily_bound(p_tenant_id uuid,p_campaign_binding_id uuid,p_daily_micros bigint,p_start bigint,p_end bigint,p_observed_spend_cents bigint)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare f ads_campaign_reservations%rowtype; daily bigint; first_time bigint; last_time bigint; cap bigint;
begin
 perform 1 from ads_campaign_bindings c join ads_provider_accounts a on a.id=c.account_id
 where c.id=p_campaign_binding_id and c.tenant_id=p_tenant_id and a.platform='chatgpt';
 if not found then raise exception 'ChatGPT campaign binding required'; end if;
 if p_daily_micros is null or p_start is null or p_end is null or p_observed_spend_cents is null or p_daily_micros < 25000000 or p_daily_micros > 1000000000000 or p_start < 946684800 or p_end > 4102444800 or p_end <= p_start or p_end-p_start > 31622400 then
  raise exception 'invalid daily coverage';
 end if;
 perform 1 from ads_wallets where tenant_id=p_tenant_id for update;
 if not found then raise exception 'ads_balance_insufficient'; end if;
 select * into f from ads_campaign_reservations where campaign_binding_id=p_campaign_binding_id;
 if found and f.tenant_id<>p_tenant_id then raise exception 'campaign ownership conflict'; end if;
 daily:=greatest(coalesce(f.daily_max_micros,0),p_daily_micros);
 first_time:=least(coalesce(f.coverage_start,p_start),p_start);
 last_time:=greatest(coalesce(f.coverage_end,p_end),p_end);
 if last_time-first_time>31622400 then raise exception 'invalid daily coverage'; end if;
 cap:=ceil((daily::numeric*2*(ceil((last_time-first_time)::numeric/86400)+2))/10000)::bigint;
 perform ads_wallet_reserve_bound(p_tenant_id,p_campaign_binding_id,cap,p_observed_spend_cents);
 update ads_campaign_reservations set daily_max_micros=daily,coverage_start=first_time,coverage_end=last_time where campaign_binding_id=p_campaign_binding_id and tenant_id=p_tenant_id;
end $$;
create function public.ads_wallet_finalize_bound(p_tenant_id uuid, p_campaign_binding_id uuid, p_final_spend_cents bigint)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare f ads_campaign_reservations%rowtype; delta bigint;
begin
 if p_final_spend_cents is null or p_final_spend_cents < 0 then raise exception 'invalid spend'; end if;
 perform 1 from ads_wallets where tenant_id = p_tenant_id for update;
 select * into f from ads_campaign_reservations where tenant_id = p_tenant_id and campaign_binding_id = p_campaign_binding_id for update;
 if not found then return; end if;
 delta := greatest(0, p_final_spend_cents - f.spent_cents);
 update ads_wallets set balance_cents = balance_cents - delta, updated_at = now() where tenant_id = p_tenant_id;
 update ads_campaign_reservations set spent_cents = greatest(spent_cents, p_final_spend_cents), reserved_cents = 0, updated_at = now()
  where tenant_id = p_tenant_id and campaign_binding_id = p_campaign_binding_id;
end $$;

create or replace function public.ads_wallet_reserve(p_tenant_id uuid,p_campaign_id text,p_lifetime_cents bigint,p_observed_spend_cents bigint) returns void
language plpgsql security definer set search_path=public,pg_temp as $$ begin
 perform ads_wallet_reserve_bound(p_tenant_id,ads_legacy_campaign_binding(p_tenant_id,p_campaign_id),p_lifetime_cents,p_observed_spend_cents);
end $$;
create or replace function public.ads_wallet_reserve_daily(p_tenant_id uuid,p_campaign_id text,p_daily_micros bigint,p_start bigint,p_end bigint,p_observed_spend_cents bigint) returns void
language plpgsql security definer set search_path=public,pg_temp as $$ begin
 perform ads_wallet_reserve_chatgpt_daily_bound(p_tenant_id,ads_legacy_campaign_binding(p_tenant_id,p_campaign_id),p_daily_micros,p_start,p_end,p_observed_spend_cents);
end $$;
create or replace function public.ads_wallet_settle_spend(p_tenant_id uuid,p_campaign_id text,p_spend_cents bigint) returns void
language plpgsql security definer set search_path=public,pg_temp as $$ declare c uuid; begin
 select b.id into c from ads_campaign_bindings b join ads_provider_accounts a on a.id=b.account_id
 where b.tenant_id=p_tenant_id and b.provider_campaign_id=p_campaign_id and a.legacy_key='chatgpt_platform';
 if c is not null then perform ads_wallet_settle_bound(p_tenant_id,c,p_spend_cents); end if;
end $$;
create or replace function public.ads_wallet_finalize_campaign(p_tenant_id uuid,p_campaign_id text,p_final_spend_cents bigint) returns void
language plpgsql security definer set search_path=public,pg_temp as $$ declare c uuid; begin
 select b.id into c from ads_campaign_bindings b join ads_provider_accounts a on a.id=b.account_id
 where b.tenant_id=p_tenant_id and b.provider_campaign_id=p_campaign_id and a.legacy_key='chatgpt_platform';
 if c is not null then perform ads_wallet_finalize_bound(p_tenant_id,c,p_final_spend_cents); end if;
end $$;
alter table public.ads_provider_accounts enable row level security;
alter table public.ads_account_bindings enable row level security;
alter table public.ads_account_selections enable row level security;
alter table public.ads_campaign_bindings enable row level security;
alter table public.ads_campaign_create_requests enable row level security;
revoke all on public.ads_provider_accounts from public,anon,authenticated;
grant all on public.ads_provider_accounts to service_role;
revoke all on public.ads_account_bindings from public,anon,authenticated;
grant all on public.ads_account_bindings to service_role;
revoke all on public.ads_account_selections from public,anon,authenticated;
grant all on public.ads_account_selections to service_role;
revoke all on public.ads_campaign_bindings from public,anon,authenticated;
grant all on public.ads_campaign_bindings to service_role;
revoke all on public.ads_campaign_create_requests from public,anon,authenticated;
grant all on public.ads_campaign_create_requests to service_role;
revoke all on public.ads_account_binding_details from public,anon,authenticated;
grant all on public.ads_account_binding_details to service_role;
revoke all on public.ads_campaign_binding_details from public,anon,authenticated;
grant all on public.ads_campaign_binding_details to service_role;
revoke all on public.ads_campaign_funding from public,anon,authenticated;
grant all on public.ads_campaign_funding to service_role;
revoke all on function public.ads_legacy_account_binding(uuid) from public,anon,authenticated;
grant execute on function public.ads_legacy_account_binding(uuid) to service_role;
revoke all on function public.ads_legacy_campaign_binding(uuid,text) from public,anon,authenticated;
grant execute on function public.ads_legacy_campaign_binding(uuid,text) to service_role;
revoke all on function public.ads_verify_account_binding(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.ads_verify_account_binding(uuid,uuid,text,text) to service_role;
revoke all on function public.ads_bind_campaign(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.ads_bind_campaign(uuid,uuid,text) to service_role;
revoke all on function public.ads_select_account_binding(uuid,uuid) from public,anon,authenticated;
grant execute on function public.ads_select_account_binding(uuid,uuid) to service_role;
revoke all on function public.ads_claim_campaign_account(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.ads_claim_campaign_account(uuid,text,uuid) to service_role;
revoke all on function public.ads_wallet_reserve_bound(uuid,uuid,bigint,bigint) from public,anon,authenticated;
grant execute on function public.ads_wallet_reserve_bound(uuid,uuid,bigint,bigint) to service_role;
revoke all on function public.ads_wallet_reserve_chatgpt_daily_bound(uuid,uuid,bigint,bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.ads_wallet_reserve_chatgpt_daily_bound(uuid,uuid,bigint,bigint,bigint,bigint) to service_role;
revoke all on function public.ads_wallet_settle_bound(uuid,uuid,bigint) from public,anon,authenticated;
grant execute on function public.ads_wallet_settle_bound(uuid,uuid,bigint) to service_role;
revoke all on function public.ads_wallet_finalize_bound(uuid,uuid,bigint) from public,anon,authenticated;
grant execute on function public.ads_wallet_finalize_bound(uuid,uuid,bigint) to service_role;
revoke all on function public.ads_wallet_reserve(uuid,text,bigint,bigint) from public,anon,authenticated;
revoke all on function public.ads_wallet_reserve_daily(uuid,text,bigint,bigint,bigint,bigint) from public,anon,authenticated;
revoke all on function public.ads_wallet_settle_spend(uuid,text,bigint) from public,anon,authenticated;
revoke all on function public.ads_wallet_finalize_campaign(uuid,text,bigint) from public,anon,authenticated;
revoke all on function public.ads_account_binding_owner() from public,anon,authenticated;
revoke all on function public.ads_binding_immutable() from public,anon,authenticated;
revoke all on function public.ads_provider_identity_immutable() from public,anon,authenticated;
revoke all on function public.ads_reservation_identity() from public,anon,authenticated;
commit;
