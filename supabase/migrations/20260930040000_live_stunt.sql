
create table if not exists public.live_stunt_snapshots (
  id bigserial primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  run_slug text not null check (run_slug ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  taken_at timestamptz not null default now(),
  payload jsonb not null
);
create index if not exists live_stunt_snapshots_tenant_taken
  on public.live_stunt_snapshots (tenant_id, run_slug, taken_at desc);

create table if not exists public.live_stunt_days (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  run_slug text not null check (run_slug ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  day date not null,
  status text not null default 'draft' check (status in ('draft','published','hidden')),
  full_entry jsonb not null,
  neutral_entry jsonb not null,
  edited_headline text,
  edited_why text,
  edited_kind text check (edited_kind in ('PLAN','CHANGE','WIN','LOSS','HUMAN','NOT_AVAILABLE','WORK')),
  token_hash text,
  token_expires_at timestamptz not null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, run_slug, day)
);

alter table public.live_stunt_snapshots enable row level security;
alter table public.live_stunt_days enable row level security;
revoke all on public.live_stunt_snapshots from public, anon, authenticated;
revoke all on public.live_stunt_days from public, anon, authenticated;

create or replace function public.live_stunt_review_apply(
  p_tenant_id uuid, p_run_slug text, p_day date, p_token_hash text, p_action text,
  p_headline text, p_why text, p_kind text
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  if p_action not in ('publish','hide') then return 'bad_action'; end if;
  update public.live_stunt_days
     set status = case when p_action = 'publish' then 'published' else 'hidden' end,
         edited_headline = p_headline, edited_why = p_why, edited_kind = p_kind,
         published_at = case when p_action = 'publish' then now() else published_at end,
         token_hash = null, updated_at = now()
   where tenant_id = p_tenant_id and run_slug = p_run_slug and day = p_day and status = 'draft'
     and token_hash is not null and token_hash = p_token_hash and token_expires_at > now();
  get diagnostics v_n = row_count;
  return case when v_n = 1 then 'ok' else 'invalid' end;
end $$;
revoke all on function public.live_stunt_review_apply(uuid,text,date,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.live_stunt_review_apply(uuid,text,date,text,text,text,text,text) to service_role;

create or replace function public.live_stunt_draft_upsert(
  p_tenant_id uuid, p_run_slug text, p_day date, p_full jsonb, p_neutral jsonb, p_token_hash text, p_expires timestamptz
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  insert into public.live_stunt_days (tenant_id, run_slug, day, full_entry, neutral_entry, token_hash, token_expires_at)
  values (p_tenant_id, p_run_slug, p_day, p_full, p_neutral, p_token_hash, p_expires)
  on conflict (tenant_id, run_slug, day) do update
     set full_entry = excluded.full_entry, neutral_entry = excluded.neutral_entry,
         token_hash = excluded.token_hash, token_expires_at = excluded.token_expires_at, updated_at = now()
   where public.live_stunt_days.status = 'draft';
  get diagnostics v_n = row_count;
  return case when v_n = 1 then 'ok' else 'kept_published' end;
end $$;
revoke all on function public.live_stunt_draft_upsert(uuid,text,date,jsonb,jsonb,text,timestamptz) from public, anon, authenticated;
grant execute on function public.live_stunt_draft_upsert(uuid,text,date,jsonb,jsonb,text,timestamptz) to service_role;
