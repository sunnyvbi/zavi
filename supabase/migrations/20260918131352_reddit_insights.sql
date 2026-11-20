begin;

create table if not exists reddit_sweeps (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  status              text not null default 'running'
    check (status in ('running', 'complete', 'partial', 'failed')),
  trigger             text not null check (trigger in ('cron', 'manual', 'auto')),
  requested_by        uuid,
  jobs_planned        int not null default 0,
  jobs_done           int not null default 0,
  jobs_failed         int not null default 0,
  posts_scanned       int not null default 0,
  comments_scanned    int not null default 0,
  communities_scanned int not null default 0,
  est_cost_usd        numeric(10, 4) not null default 0,
  cost_usd            numeric(10, 4),
  error_code          text,
  jobs                jsonb not null default '[]'::jsonb,
  heartbeat_at        timestamptz not null default now(),
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  unique (id, tenant_id)
);
create unique index if not exists reddit_sweeps_one_running
  on reddit_sweeps (tenant_id) where status = 'running';
create index if not exists reddit_sweeps_tenant_started
  on reddit_sweeps (tenant_id, started_at desc);

create table if not exists reddit_threads (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  url               text not null,
  subreddit         text not null,
  title             text not null,
  author            text,
  body_excerpt      text check (body_excerpt is null or char_length(body_excerpt) <= 1200),
  score             int,
  comment_count     int,
  posted_at         timestamptz,
  locked            boolean,
  removed           boolean not null default false,
  subscribers       int,
  matched_terms     text[] not null default '{}',
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  last_sweep_id     uuid,
  post_relevance    int check (post_relevance between 0 and 100),
  relevance_why     text check (relevance_why is null or char_length(relevance_why) <= 200),
  is_question       boolean,
  asks_for_tools    boolean,
  brands_named      text[] not null default '{}',
  names_you         boolean,
  sentiment         text check (sentiment in ('positive', 'neutral', 'negative')),
  scored_at         timestamptz,
  score_hash        text,
  google_rank       int check (google_rank between 1 and 100),
  google_query      text,
  google_checked_at timestamptz,
  draft_text        text check (draft_text is null or char_length(draft_text) <= 4000),
  draft_state       text check (draft_state in ('drafted', 'posted', 'dismissed')),
  draft_updated_at  timestamptz
);
create unique index if not exists reddit_threads_tenant_url_uq on reddit_threads (tenant_id, url);
create index if not exists reddit_threads_tenant_seen on reddit_threads (tenant_id, last_seen_at desc);
create index if not exists reddit_threads_tenant_relevance on reddit_threads (tenant_id, post_relevance desc);

create table if not exists reddit_comments (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  thread_id         uuid not null references reddit_threads(id) on delete cascade,
  content_hash      text not null,
  author            text,
  body_excerpt      text check (body_excerpt is null or char_length(body_excerpt) <= 800),
  score             int,
  matched_terms     text[] not null default '{}',
  first_seen_at     timestamptz not null default now(),
  last_sweep_id     uuid,
  comment_relevance int check (comment_relevance between 0 and 100),
  is_question       boolean,
  sentiment         text check (sentiment in ('positive', 'neutral', 'negative')),
  scored_at         timestamptz,
  score_hash        text
);
create unique index if not exists reddit_comments_tenant_hash_uq on reddit_comments (tenant_id, content_hash);
create index if not exists reddit_comments_thread on reddit_comments (thread_id);

create table if not exists reddit_mentions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  thread_id     uuid not null references reddit_threads(id) on delete cascade,
  comment_id    uuid references reddit_comments(id) on delete cascade,
  term          text not null,
  kind          text not null check (kind in ('brand', 'competitor', 'keyword')),
  keyword_id    uuid references reddit_keywords(id) on delete set null,
  competitor_id uuid references reddit_competitors(id) on delete set null,
  subreddit     text not null,
  sentiment     text check (sentiment in ('positive', 'neutral', 'negative')),
  observed_at   timestamptz not null,
  created_at    timestamptz not null default now()
);
create unique index if not exists reddit_mentions_item_term_uq
  on reddit_mentions (tenant_id, thread_id, coalesce(comment_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(term));
create index if not exists reddit_mentions_tenant_observed on reddit_mentions (tenant_id, observed_at desc);

create table if not exists reddit_community_stats (
  tenant_id            uuid not null references tenants(id) on delete cascade,
  name                 text not null check (name ~ '^[a-z0-9_]{2,21}$'),
  relevance            int check (relevance between 0 and 100),
  relevance_why        text check (relevance_why is null or char_length(relevance_why) <= 200),
  subscribers          int,
  posts_per_day        int,
  posts_per_day_capped boolean not null default false,
  threads_seen_7d      int not null default 0,
  relevant_threads_7d  int not null default 0,
  updated_at           timestamptz not null default now(),
  primary key (tenant_id, name)
);

create table if not exists reddit_metric_snapshots (
  tenant_id               uuid not null references tenants(id) on delete cascade,
  day                     date not null,
  brand_mentions_7d       int not null default 0,
  reply_opportunities     int not null default 0,
  posts_scanned           int not null default 0,
  posts_relevant          int not null default 0,
  comments_scanned        int not null default 0,
  comments_relevant       int not null default 0,
  subreddits_tracked      int not null default 0,
  top_subreddit           text,
  top_subreddit_relevance int,
  created_at              timestamptz not null default now(),
  primary key (tenant_id, day)
);

alter table reddit_sweeps enable row level security;
alter table reddit_threads enable row level security;
alter table reddit_comments enable row level security;
alter table reddit_mentions enable row level security;
alter table reddit_community_stats enable row level security;
alter table reddit_metric_snapshots enable row level security;

do $$
declare t text;
begin
  foreach t in array array['reddit_sweeps', 'reddit_threads', 'reddit_comments', 'reddit_mentions',
                           'reddit_community_stats', 'reddit_metric_snapshots'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from public, anon, authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;

create or replace function reddit_open_sweep(
  p_tenant_id          uuid,
  p_trigger            text,
  p_requested_by       uuid,
  p_jobs               jsonb,
  p_jobs_planned       int,
  p_est_cost_usd       numeric,
  p_tenant_cap_usd_7d  numeric,
  p_fleet_cap_usd_24h  numeric
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_used  numeric;
  v_fleet numeric;
  v_id    uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('reddit_open_sweep', 0));

  update reddit_sweeps
     set status = 'failed', error_code = 'stale_running', finished_at = now(),
         cost_usd = round(est_cost_usd * least(jobs_done + jobs_failed, jobs_planned)::numeric
                          / greatest(jobs_planned, 1), 4)
   where tenant_id = p_tenant_id and status = 'running' and heartbeat_at < now() - interval '1 hour';

  if exists (select 1 from reddit_sweeps where tenant_id = p_tenant_id and status = 'running') then
    return jsonb_build_object('ok', false, 'reason', 'already_running');
  end if;
  if coalesce(p_jobs_planned, 0) <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'nothing_to_scan');
  end if;

  select coalesce(sum(coalesce(cost_usd, est_cost_usd)), 0) into v_used
    from reddit_sweeps where tenant_id = p_tenant_id and started_at > now() - interval '7 days';
  if v_used + p_est_cost_usd > greatest(coalesce(p_tenant_cap_usd_7d, 0), 0) then
    return jsonb_build_object('ok', false, 'reason', 'tenant_cap_reached',
                              'used_usd_7d', v_used, 'cap_usd_7d', p_tenant_cap_usd_7d);
  end if;

  select coalesce(sum(coalesce(cost_usd, est_cost_usd)), 0) into v_fleet
    from reddit_sweeps where started_at > now() - interval '24 hours';
  if v_fleet + p_est_cost_usd > greatest(coalesce(p_fleet_cap_usd_24h, 0), 0) then
    return jsonb_build_object('ok', false, 'reason', 'fleet_cap_reached');
  end if;

  insert into reddit_sweeps (tenant_id, trigger, requested_by, jobs, jobs_planned, est_cost_usd)
  values (p_tenant_id, p_trigger, p_requested_by, coalesce(p_jobs, '[]'::jsonb), p_jobs_planned, p_est_cost_usd)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'sweep_id', v_id);
end $$;

revoke all on function reddit_open_sweep(uuid, text, uuid, jsonb, int, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function reddit_open_sweep(uuid, text, uuid, jsonb, int, numeric, numeric, numeric) to service_role;

commit;
