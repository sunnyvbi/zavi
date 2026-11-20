
alter table social_posts
  add column if not exists metrics jsonb,
  add column if not exists metrics_read_at timestamptz;

comment on column social_posts.metrics is
  'Latest per-post metrics snapshot from the connector read, e.g. {"public":{...},"non_public":{...},"organic":{...}}. Null until the first connected read after publish.';
comment on column social_posts.metrics_read_at is
  'When social_posts.metrics was last written (the connector fetch time).';
