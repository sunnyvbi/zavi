begin;

create table if not exists tenant_brand_kits (
  tenant_id    uuid primary key references tenants(id) on delete cascade,
  primary_hex  text check (primary_hex ~ '^#[0-9a-f]{6}$'),
  accent_hex   text check (accent_hex ~ '^#[0-9a-f]{6}$'),
  bg_hex       text check (bg_hex ~ '^#[0-9a-f]{6}$'),
  text_hex     text check (text_hex ~ '^#[0-9a-f]{6}$'),
  source       text not null default 'default' check (source in ('scrape', 'default')),
  source_url   text check (length(source_url) <= 2000),
  evidence     jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  refreshed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table tenant_brand_kits enable row level security;
revoke all on table tenant_brand_kits from public, anon, authenticated;
grant all on table tenant_brand_kits to service_role;

commit;
