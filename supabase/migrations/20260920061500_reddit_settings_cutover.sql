
begin;

insert into tenant_channels (tenant_id, channel_slug)
select distinct s.tenant_id, 'reddit_organic'
  from (
    select tenant_id from reddit_keywords
    union select tenant_id from reddit_competitors
    union select tenant_id from reddit_communities
  ) s
on conflict (tenant_id, channel_slug) do nothing;

insert into channel_settings
  (id, tenant_id, channel_slug, field_id, item, item_type, status, position,
   note, origin, detail, updated_at, updated_by)
select k.id,
       k.tenant_id,
       'reddit_organic',
       'keywords',
       btrim(k.term),
       k.type,
       k.status,
       (row_number() over (partition by k.tenant_id order by k.created_at, k.id) - 1)::int,
       nullif(btrim(coalesce(k.why, '')), ''),
       k.origin,
       null,
       k.updated_at,
       k.created_by
  from reddit_keywords k
on conflict (id) do nothing;

insert into channel_settings
  (id, tenant_id, channel_slug, field_id, item, item_type, status, position,
   note, origin, detail, updated_at, updated_by)
select c.id,
       c.tenant_id,
       'reddit_organic',
       'competitors',
       btrim(c.name),
       null,
       c.status,
       (row_number() over (partition by c.tenant_id order by c.created_at, c.id) - 1)::int,
       nullif(btrim(coalesce(c.why, '')), ''),
       c.origin,
       nullif(btrim(coalesce(c.domain, '')), ''),
       c.updated_at,
       c.created_by
  from reddit_competitors c
on conflict (id) do nothing;

insert into channel_settings
  (id, tenant_id, channel_slug, field_id, item, item_type, status, position,
   note, origin, detail, updated_at, updated_by)
select m.id,
       m.tenant_id,
       'reddit_organic',
       'communities',
       btrim(m.name),
       m.rules_verdict,
       case when m.selected then 'tracking' else 'paused' end,
       (row_number() over (partition by m.tenant_id order by m.created_at, m.id) - 1)::int,
       null,
       'custom',
       null,
       m.updated_at,
       coalesce(m.rules_verdict_by, m.created_by)
  from reddit_communities m
on conflict (id) do nothing;

do $$
declare r record;
begin
  for r in
    select con.conname
      from pg_constraint con
      join lateral unnest(con.conkey) as k(attnum) on true
      join pg_attribute a
        on a.attrelid = con.conrelid and a.attnum = k.attnum
     where con.conrelid = 'reddit_mentions'::regclass
       and con.contype = 'f'
       and a.attname in ('keyword_id', 'competitor_id')
  loop
    execute format('alter table reddit_mentions drop constraint %I', r.conname);
  end loop;
end $$;

alter table reddit_mentions
  add constraint reddit_mentions_keyword_id_fkey
    foreign key (keyword_id) references channel_settings (id) on delete set null,
  add constraint reddit_mentions_competitor_id_fkey
    foreign key (competitor_id) references channel_settings (id) on delete set null;

commit;

do $$
declare
  v_copied bigint;
  v_missed bigint;
  v_orphan bigint;
begin
  select count(*) into v_copied
    from channel_settings where channel_slug = 'reddit_organic';

  select count(*) into v_missed from (
    select id from reddit_keywords
    union all select id from reddit_competitors
    union all select id from reddit_communities
  ) src
   where not exists (select 1 from channel_settings s where s.id = src.id);

  select count(*) into v_orphan
    from reddit_mentions m
   where (m.keyword_id is not null
          and not exists (select 1 from channel_settings s where s.id = m.keyword_id))
      or (m.competitor_id is not null
          and not exists (select 1 from channel_settings s where s.id = m.competitor_id));

  raise notice '20260920061500: reddit cutover — % settings rows, % source rows missed, % orphan mentions',
    v_copied, v_missed, v_orphan;
end $$;
