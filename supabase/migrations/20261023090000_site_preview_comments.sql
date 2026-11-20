begin;

create unique index if not exists sites_id_tenant_uq on public.sites (id, tenant_id);

create table if not exists public.site_comment_threads (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  site_id      uuid not null,
  page_path    text not null check (char_length(page_path) between 1 and 200 and left(page_path, 1) = '/'),
  selector     text not null check (char_length(btrim(selector)) between 1 and 400),
  section      text check (section is null or section ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  anchor_text  text check (anchor_text is null or char_length(anchor_text) <= 160),
  rel_x        real not null default 0.5 check (rel_x >= 0 and rel_x <= 1),
  rel_y        real not null default 0.5 check (rel_y >= 0 and rel_y <= 1),
  status       text not null default 'open' check (status in ('open', 'resolved', 'sent')),
  sent_run_id  uuid,
  created_by   uuid not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint site_comment_threads_id_tenant_uq unique (id, tenant_id),
  constraint site_comment_threads_site_tenant_fk
    foreign key (site_id, tenant_id) references public.sites (id, tenant_id) on delete cascade
);

create index if not exists site_comment_threads_site_idx
  on public.site_comment_threads (tenant_id, site_id, created_at);

create table if not exists public.site_comments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  thread_id   uuid not null,
  author_id   uuid not null,
  body        text not null check (char_length(btrim(body)) between 1 and 2000),
  mentions    uuid[] not null default '{}'::uuid[] check (cardinality(mentions) <= 20),
  created_at  timestamptz not null default now(),
  constraint site_comments_thread_tenant_fk
    foreign key (thread_id, tenant_id) references public.site_comment_threads (id, tenant_id) on delete cascade
);

create index if not exists site_comments_thread_idx
  on public.site_comments (tenant_id, thread_id, created_at);

alter table public.site_comment_threads enable row level security;
alter table public.site_comments enable row level security;

revoke insert, update, delete, truncate on table public.site_comment_threads from public, anon, authenticated;
revoke insert, update, delete, truncate on table public.site_comments from public, anon, authenticated;
revoke all on table public.site_comment_threads from anon;
revoke all on table public.site_comments from anon;
grant select on table public.site_comment_threads to authenticated;
grant select on table public.site_comments to authenticated;

drop policy if exists site_comment_threads_select on public.site_comment_threads;
create policy site_comment_threads_select on public.site_comment_threads
  for select using (
    exists (select 1 from public.tenant_users tu
            where tu.user_id = auth.uid() and tu.tenant_id = site_comment_threads.tenant_id)
  );

drop policy if exists site_comments_select on public.site_comments;
create policy site_comments_select on public.site_comments
  for select using (
    exists (select 1 from public.tenant_users tu
            where tu.user_id = auth.uid() and tu.tenant_id = site_comments.tenant_id)
  );

commit;
