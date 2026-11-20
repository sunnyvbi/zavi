
begin;

create table if not exists public.start_cards (
  id                uuid primary key default gen_random_uuid(),
  public_id         text not null unique check (public_id ~ '^[A-Za-z0-9]{16,32}$'),
  domain            text not null check (length(domain) between 1 and 253),
  locale            text not null default 'US',
  search_term       text,
  status            text not null default 'running'
                      check (status in ('queued','running','done','failed','expired','removed')),
  parts             jsonb not null default '{}'::jsonb,
  score             jsonb,
  scorer_version    text not null default '1',
  evidence          jsonb not null default '{}'::jsonb,
  ip_hash           text,
  referrer_card_id  uuid references public.start_cards(id) on delete set null,
  budget_day        date,
  reserved_usd      numeric(10,4) not null default 0,
  spent_usd         numeric(10,4) not null default 0,
  revoked_at        timestamptz,
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  expires_at        timestamptz not null default now() + interval '90 days'
);

create table if not exists public.start_card_budget (
  day            date primary key,
  committed_usd  numeric(12,4) not null default 0 check (committed_usd >= 0),
  updated_at     timestamptz not null default now()
);

create table if not exists public.start_card_email_queue (
  id                  uuid primary key default gen_random_uuid(),
  email               text not null check (length(email) <= 320),
  domain              text not null check (length(domain) between 1 and 253),
  confirm_token_hash  text not null unique,
  ip_hash             text,
  confirmed_at        timestamptz,
  card_id             uuid references public.start_cards(id) on delete set null,
  created_at          timestamptz not null default now()
);

alter table public.start_cards enable row level security;
alter table public.start_cards force row level security;
alter table public.start_card_budget enable row level security;
alter table public.start_card_budget force row level security;
alter table public.start_card_email_queue enable row level security;
alter table public.start_card_email_queue force row level security;

revoke all on table public.start_cards from public, anon, authenticated;
revoke all on table public.start_card_budget from public, anon, authenticated;
revoke all on table public.start_card_email_queue from public, anon, authenticated;
grant all on table public.start_cards to service_role;
grant all on table public.start_card_budget to service_role;
grant all on table public.start_card_email_queue to service_role;

create or replace function public.start_card_budget_reserve(
  p_day date,
  p_amount numeric,
  p_ceiling numeric
) returns boolean
language sql volatile security invoker set search_path = public, pg_temp as $$
  with r as (
    insert into public.start_card_budget as b (day, committed_usd)
    select p_day, p_amount
    where p_amount > 0 and p_amount <= p_ceiling
    on conflict (day) do update
      set committed_usd = b.committed_usd + excluded.committed_usd,
          updated_at = now()
      where b.committed_usd + excluded.committed_usd <= p_ceiling
    returning 1
  )
  select exists (select 1 from r);
$$;

create or replace function public.start_card_budget_adjust(
  p_day date,
  p_delta numeric
) returns numeric
language sql volatile security invoker set search_path = public, pg_temp as $$
  insert into public.start_card_budget as b (day, committed_usd)
  values (p_day, greatest(p_delta, 0))
  on conflict (day) do update
    set committed_usd = greatest(0, b.committed_usd + p_delta),
        updated_at = now()
  returning committed_usd;
$$;

create or replace function public.start_card_set_part(
  p_card_id uuid,
  p_key text,
  p_part jsonb
) returns void
language sql volatile security invoker set search_path = public, pg_temp as $$
  update public.start_cards
     set parts = jsonb_set(parts, array[p_key], p_part, true),
         updated_at = now()
   where id = p_card_id
     and p_key in ('profile','google','ai','seo','design','compare','diagnosis');
$$;

revoke all on function public.start_card_budget_reserve(date, numeric, numeric) from public, anon, authenticated;
revoke all on function public.start_card_budget_adjust(date, numeric) from public, anon, authenticated;
revoke all on function public.start_card_set_part(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.start_card_budget_reserve(date, numeric, numeric) to service_role;
grant execute on function public.start_card_budget_adjust(date, numeric) to service_role;
grant execute on function public.start_card_set_part(uuid, text, jsonb) to service_role;

commit;
