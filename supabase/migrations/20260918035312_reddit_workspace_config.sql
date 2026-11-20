begin;

create table if not exists reddit_keywords (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  term        text not null check (char_length(btrim(term)) between 2 and 80),
  type        text not null default 'problem'
    check (type in ('brand', 'product', 'problem', 'competitor', 'category', 'comparison', 'industry')),
  origin      text not null default 'custom' check (origin in ('suggested', 'custom')),
  status      text not null default 'tracking'
    check (status in ('suggested', 'tracking', 'paused', 'dismissed')),
  why         text check (why is null or char_length(why) <= 300),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists reddit_keywords_tenant_term_uq
  on reddit_keywords (tenant_id, lower(btrim(term)));

create table if not exists reddit_competitors (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 2 and 80),
  domain      text check (domain is null or domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  origin      text not null default 'custom' check (origin in ('suggested', 'custom')),
  status      text not null default 'tracking'
    check (status in ('suggested', 'tracking', 'paused', 'dismissed')),
  why         text check (why is null or char_length(why) <= 300),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists reddit_competitors_tenant_name_uq
  on reddit_competitors (tenant_id, lower(btrim(name)));

create table if not exists reddit_communities (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  name              text not null check (name ~ '^[A-Za-z0-9_]{2,21}$'),
  selected          boolean not null default true,
  rules_verdict     text check (rules_verdict in ('allowed', 'unclear', 'banned')),
  rules_verdict_at  timestamptz,
  rules_verdict_by  uuid,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check ((rules_verdict is null) = (rules_verdict_at is null))
);
create unique index if not exists reddit_communities_tenant_name_uq
  on reddit_communities (tenant_id, lower(name));

alter table reddit_keywords enable row level security;
alter table reddit_competitors enable row level security;
alter table reddit_communities enable row level security;

do $$
declare t text;
begin
  foreach t in array array['reddit_keywords', 'reddit_competitors', 'reddit_communities'] loop
    execute format('alter table %I enable row level security', t);
    execute format('grant select on table %I to authenticated', t);
    execute format('grant all on table %I to service_role', t);

    execute format('drop policy if exists %I on %I', t || '_member_select', t);
    execute format(
      'create policy %I on %I for select using (exists (
         select 1 from tenant_users tu
         where tu.user_id = auth.uid() and tu.tenant_id = %I.tenant_id))',
      t || '_member_select', t, t);

    execute format('drop policy if exists %I on %I', t || '_active_tenant_restrict', t);
    execute format(
      'create policy %I on %I as restrictive for select
         using (tenant_id = nullif(auth.jwt() -> ''app_metadata'' ->> ''active_tenant_id'', '''')::uuid)',
      t || '_active_tenant_restrict', t);
  end loop;
end $$;

commit;
