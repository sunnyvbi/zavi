
create table if not exists tenant_metered_read_counters (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  day        date not null,
  key        text not null,
  reads      int  not null default 0,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, day, key)
);

alter table tenant_metered_read_counters enable row level security;

drop policy if exists tenant_metered_read_counters_member_select on tenant_metered_read_counters;
create policy tenant_metered_read_counters_member_select on tenant_metered_read_counters
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = tenant_metered_read_counters.tenant_id
    )
  );

create or replace function consume_metered_read_or_reject(
  p_tenant_id uuid,
  p_day       date,
  p_key       text,
  p_cap       int
) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_reads int;
begin
  if p_tenant_id is null or p_day is null or p_key is null or p_cap is null then
    raise exception 'consume_metered_read_or_reject: null argument' using errcode = '22023';
  end if;

  insert into tenant_metered_read_counters (tenant_id, day, key)
  values (p_tenant_id, p_day, p_key)
  on conflict (tenant_id, day, key) do nothing;

  update tenant_metered_read_counters
     set reads = reads + 1,
         updated_at = now()
   where tenant_id = p_tenant_id
     and day = p_day
     and key = p_key
     and (p_cap <= 0 or reads + 1 <= p_cap)
  returning reads into v_reads;

  return v_reads;
end $$;
revoke all on function consume_metered_read_or_reject(uuid, date, text, int) from public;
grant execute on function consume_metered_read_or_reject(uuid, date, text, int) to service_role;

create or replace function release_metered_read(
  p_tenant_id uuid,
  p_day       date,
  p_key       text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null or p_day is null or p_key is null then
    raise exception 'release_metered_read: null argument' using errcode = '22023';
  end if;

  update tenant_metered_read_counters
     set reads = greatest(0, reads - 1),
         updated_at = now()
   where tenant_id = p_tenant_id
     and day = p_day
     and key = p_key;
end $$;
revoke all on function release_metered_read(uuid, date, text) from public;
grant execute on function release_metered_read(uuid, date, text) to service_role;

alter table social_post_metric_snapshots
  add column if not exists thumb_url  text,
  add column if not exists media_type text;

create table if not exists social_account_snapshots (
  tenant_id           uuid not null references tenants(id) on delete cascade,
  channel             text not null,
  captured_on         date not null,
  username            text,
  name                text,
  description         text,
  url                 text,
  profile_image_url   text,
  profile_banner_url  text,
  pinned_post_id      text,
  location            text,
  verified            boolean,
  followers_count     int,
  following_count     int,
  post_count          int,
  created_at          timestamptz not null default now(),
  primary key (tenant_id, channel, captured_on)
);

alter table social_account_snapshots enable row level security;

drop policy if exists social_account_snapshots_member_select on social_account_snapshots;
create policy social_account_snapshots_member_select on social_account_snapshots
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = social_account_snapshots.tenant_id
    )
  );

create table if not exists social_profile_check_dismissals (
  tenant_id    uuid not null references tenants(id) on delete cascade,
  channel      text not null,
  check_key    text not null,
  dismissed_at timestamptz not null default now(),
  primary key (tenant_id, channel, check_key)
);

alter table social_profile_check_dismissals enable row level security;

drop policy if exists social_profile_check_dismissals_member_select on social_profile_check_dismissals;
create policy social_profile_check_dismissals_member_select on social_profile_check_dismissals
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = social_profile_check_dismissals.tenant_id
    )
  );
