
create table if not exists email_suppression (
  tenant_id    uuid        not null,
  email        text        not null,
  reason       text        not null default 'unsubscribe'
               check (reason in ('unsubscribe', 'bounce', 'complaint', 'manual')),
  unsub_token  uuid        not null default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  primary key (tenant_id, email)
);
create unique index if not exists email_suppression_token_uq
  on email_suppression (unsub_token);

alter table email_suppression enable row level security;

drop policy if exists email_suppression_select on email_suppression;
create policy email_suppression_select on email_suppression
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = email_suppression.tenant_id)
  );

create table if not exists email_send_counters (
  tenant_id  uuid        not null,
  day        date        not null,
  sent_count int         not null default 0,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, day)
);

alter table email_send_counters enable row level security;

drop policy if exists email_send_counters_select on email_send_counters;
create policy email_send_counters_select on email_send_counters
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = email_send_counters.tenant_id)
  );

create table if not exists email_domain_warmup (
  tenant_id    uuid        not null,
  domain       text        not null,
  started_on   date        not null default (now() at time zone 'utc')::date,
  day_index    int         not null default 0,
  last_sent_on date,
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, domain)
);

alter table email_domain_warmup enable row level security;

drop policy if exists email_domain_warmup_select on email_domain_warmup;
create policy email_domain_warmup_select on email_domain_warmup
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = email_domain_warmup.tenant_id)
  );

create table if not exists email_unsub_token (
  tenant_id   uuid        not null,
  email       text        not null,
  token       uuid        not null default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  primary key (tenant_id, email)
);
create unique index if not exists email_unsub_token_token_uq
  on email_unsub_token (token);
alter table email_unsub_token enable row level security;
drop policy if exists email_unsub_token_select on email_unsub_token;
create policy email_unsub_token_select on email_unsub_token
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = email_unsub_token.tenant_id)
  );

create or replace function is_email_suppressed(
  p_tenant_id uuid,
  p_email     text
) returns text
language plpgsql security definer set search_path = public as $$
declare v_reason text;
begin
  if p_tenant_id is null or p_email is null then
    raise exception 'is_email_suppressed: null argument' using errcode = '22023';
  end if;
  select reason into v_reason
    from email_suppression
   where tenant_id = p_tenant_id and email = lower(p_email);
  return v_reason;
end $$;
revoke all on function is_email_suppressed(uuid, text) from public;
grant execute on function is_email_suppressed(uuid, text) to service_role;

create or replace function suppress_email(
  p_tenant_id uuid,
  p_email     text,
  p_reason    text default 'unsubscribe'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_token uuid;
begin
  if p_tenant_id is null or p_email is null then
    raise exception 'suppress_email: null argument' using errcode = '22023';
  end if;
  if p_reason not in ('unsubscribe', 'bounce', 'complaint', 'manual') then
    raise exception 'suppress_email: invalid reason %', p_reason using errcode = '22023';
  end if;

  insert into email_suppression (tenant_id, email, reason)
  values (p_tenant_id, lower(p_email), p_reason)
  on conflict (tenant_id, email) do update
    set reason = excluded.reason
  returning unsub_token into v_token;

  return v_token;
end $$;
revoke all on function suppress_email(uuid, text, text) from public;
grant execute on function suppress_email(uuid, text, text) to service_role;

create or replace function get_or_create_unsub_token(
  p_tenant_id uuid,
  p_email     text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_token uuid;
begin
  if p_tenant_id is null or p_email is null then
    raise exception 'get_or_create_unsub_token: null argument' using errcode = '22023';
  end if;
  insert into email_unsub_token (tenant_id, email)
  values (p_tenant_id, lower(p_email))
  on conflict (tenant_id, email) do nothing;

  select token into v_token
    from email_unsub_token
   where tenant_id = p_tenant_id and email = lower(p_email);
  return v_token;
end $$;
revoke all on function get_or_create_unsub_token(uuid, text) from public;
grant execute on function get_or_create_unsub_token(uuid, text) to service_role;

create or replace function consume_email_send_or_reject(
  p_tenant_id     uuid,
  p_day           date,
  p_effective_cap int
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  if p_tenant_id is null or p_day is null or p_effective_cap is null then
    raise exception 'consume_email_send_or_reject: null argument' using errcode = '22023';
  end if;

  insert into email_send_counters (tenant_id, day)
  values (p_tenant_id, p_day)
  on conflict (tenant_id, day) do nothing;

  update email_send_counters
     set sent_count = sent_count + 1,
         updated_at = now()
   where tenant_id = p_tenant_id
     and day = p_day
     and (p_effective_cap <= 0 or sent_count + 1 <= p_effective_cap)
  returning sent_count into v_count;

  return v_count is not null;
end $$;
revoke all on function consume_email_send_or_reject(uuid, date, int) from public;
grant execute on function consume_email_send_or_reject(uuid, date, int) to service_role;

create or replace function touch_domain_warmup(
  p_tenant_id uuid,
  p_domain    text,
  p_day       date
) returns int
language plpgsql security definer set search_path = public as $$
declare v_day_index int;
begin
  if p_tenant_id is null or p_domain is null or p_day is null then
    raise exception 'touch_domain_warmup: null argument' using errcode = '22023';
  end if;

  insert into email_domain_warmup (tenant_id, domain, started_on, day_index, last_sent_on)
  values (p_tenant_id, lower(p_domain), p_day, 0, p_day)
  on conflict (tenant_id, domain) do update
    set day_index = case
          when email_domain_warmup.last_sent_on is null
               or email_domain_warmup.last_sent_on < p_day
          then email_domain_warmup.day_index + 1
          else email_domain_warmup.day_index
        end,
        last_sent_on = p_day,
        updated_at = now()
  returning day_index into v_day_index;

  return v_day_index;
end $$;
revoke all on function touch_domain_warmup(uuid, text, date) from public;
grant execute on function touch_domain_warmup(uuid, text, date) to service_role;
