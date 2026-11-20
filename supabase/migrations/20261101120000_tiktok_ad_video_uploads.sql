begin;

create table if not exists public.tiktok_ad_video_uploads (
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  advertiser_id text not null check (advertiser_id ~ '^[0-9]{1,32}$'),
  source_key    text not null check (source_key ~ '^(zavi:[0-9a-f-]{36}|link:[0-9a-f]{64})$'),
  video_id      text not null check (char_length(video_id) between 1 and 128),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, advertiser_id, source_key)
);
alter table public.tiktok_ad_video_uploads enable row level security;
revoke all on public.tiktok_ad_video_uploads from public, anon, authenticated;
grant all on public.tiktok_ad_video_uploads to service_role;

commit;
