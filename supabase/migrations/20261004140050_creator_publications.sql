
create table if not exists creator_publications (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  order_id           uuid not null,
  publisher          text not null check (publisher in ('business', 'creator')),
  platform           text not null check (platform in ('tiktok', 'instagram', 'youtube', 'facebook', 'x', 'linkedin', 'pinterest', 'other')),
  account            text check (account is null or length(btrim(account)) between 1 and 200),
  post_url           text check (post_url is null or (post_url like 'https://%' and length(post_url) <= 2000)),
  status             text not null check (status in ('scheduled', 'published')),
  scheduled_for      timestamptz,
  published_at       timestamptz,
  verification       text not null default 'pending' check (verification in ('verified', 'pending', 'manual', 'failed')),
  verification_note  text check (verification_note is null or length(verification_note) <= 500),
  verified_at        timestamptz,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  foreign key (tenant_id, order_id) references creator_orders (tenant_id, id) on delete cascade,
  check (status <> 'published' or post_url is not null),
  check (status <> 'scheduled' or scheduled_for is not null)
);

create index if not exists creator_publications_order_idx on creator_publications (tenant_id, order_id, created_at);

alter table creator_publications enable row level security;
revoke all on creator_publications from anon, authenticated;
