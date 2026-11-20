
begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';

create table if not exists zsite.site_fences (
  site_id            uuid primary key,
  applied_generation bigint not null check (applied_generation >= 1),
  updated_at         timestamptz not null default now()
);
alter table zsite.site_fences enable row level security;
revoke all on zsite.site_fences from public, anon, authenticated;

insert into zsite.migrations (version) values ('0011_site_publish_fence') on conflict do nothing;

commit;
