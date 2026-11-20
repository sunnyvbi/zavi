
begin;

create table if not exists public.email_learn_observations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  account_key   text not null check (char_length(account_key) between 1 and 200),
  route         text not null check (route in ('sendgrid', 'mailchimp', 'klaviyo')),
  campaign_id   text not null check (char_length(campaign_id) between 1 and 128),
  obs_window    text not null check (obs_window in ('lifetime')),
  list_id       text check (list_id is null or char_length(list_id) <= 128),
  list_name     text check (list_name is null or char_length(list_name) <= 200),
  subject       text not null default '' check (char_length(subject) <= 300),
  sent_at       timestamptz not null,
  delivered     int check (delivered is null or delivered >= 0),
  clicks        int check (clicks is null or clicks >= 0),
  observed_at   timestamptz not null default now(),
  constraint email_learn_observations_key unique (tenant_id, account_key, route, campaign_id, obs_window)
);
create index if not exists email_learn_observations_tenant_idx on public.email_learn_observations (tenant_id, sent_at desc);
alter table public.email_learn_observations enable row level security;
revoke all on public.email_learn_observations from public, anon, authenticated;
grant all on public.email_learn_observations to service_role;

create table if not exists public.email_learnings (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  text         text not null check (char_length(btrim(text)) between 1 and 300),
  origin       text not null check (origin in ('zavi', 'founder')),
  status       text not null check (status in ('active', 'stale', 'suggested', 'dismissed')),
  split        text check (split is null or split in ('subject_digit', 'subject_length', 'weekend', 'morning', 'list')),
  route        text,
  list_id      text,
  metric       text check (metric is null or metric in ('clicks', 'visitors')),
  account_key  text,
  obs_window   text,
  topic_key    text generated always as (
                 case when split is null then null
                      else split || '|' || coalesce(route, '') || '|' || coalesce(list_id, '') || '|'
                           || coalesce(metric, '') || '|' || coalesce(account_key, '') || '|' || coalesce(obs_window, '') end
               ) stored,
  list_name    text,
  stats        jsonb not null default '{}'::jsonb,
  strength     text check (strength is null or strength in ('early', 'firm')),
  side         text check (side is null or side in ('a', 'b')),
  evidence_fp  text,
  miss_streak  int not null default 0,
  hit_streak   int not null default 0,
  streak_side  text check (streak_side is null or streak_side in ('a', 'b')),
  from_zavi    boolean not null default false,
  note         text check (note is null or char_length(note) <= 300),
  cant_recheck boolean not null default false,
  version      int not null default 1,
  created_by   uuid,
  edited_by    uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint email_learnings_tenant_id_id_key unique (tenant_id, id)
);
alter table public.email_learnings
  add column if not exists side text check (side is null or side in ('a', 'b')),
  add column if not exists evidence_fp text,
  add column if not exists miss_streak int not null default 0,
  add column if not exists hit_streak int not null default 0,
  add column if not exists streak_side text check (streak_side is null or streak_side in ('a', 'b')),
  add column if not exists from_zavi boolean not null default false,
  add column if not exists note text check (note is null or char_length(note) <= 300),
  add column if not exists cant_recheck boolean not null default false,
  add column if not exists version int not null default 1,
  add column if not exists edited_by uuid;
create unique index if not exists email_learnings_topic_idx on public.email_learnings (tenant_id, topic_key) where topic_key is not null;
create index if not exists email_learnings_tenant_status_idx on public.email_learnings (tenant_id, status);
alter table public.email_learnings enable row level security;
revoke all on public.email_learnings from public, anon, authenticated;
grant all on public.email_learnings to service_role;

create table if not exists public.email_learning_seen (
  tenant_id    uuid not null,
  learning_id  uuid not null,
  user_id      uuid not null,
  seen_version int not null,
  seen_at      timestamptz not null default now(),
  primary key (learning_id, user_id),
  constraint email_learning_seen_learning_fk foreign key (tenant_id, learning_id)
    references public.email_learnings (tenant_id, id) on delete cascade
);
alter table public.email_learning_seen enable row level security;
revoke all on public.email_learning_seen from public, anon, authenticated;
grant all on public.email_learning_seen to service_role;

create table if not exists public.email_learning_reads (
  run_id     uuid primary key,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  status     text not null default 'ok' check (status in ('ok', 'empty', 'read_failed')),
  items      jsonb not null check (jsonb_typeof(items) = 'array'),
  created_at timestamptz not null default now()
);
alter table public.email_learning_reads
  add column if not exists status text not null default 'ok' check (status in ('ok', 'empty', 'read_failed'));
alter table public.email_learning_reads enable row level security;
revoke all on public.email_learning_reads from public, anon, authenticated;
grant all on public.email_learning_reads to service_role;

create table if not exists public.email_learn_work (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  kind        text not null check (kind in ('result', 'seed')),
  dedupe_key  text not null check (char_length(dedupe_key) between 1 and 200),
  state       text not null default 'pending' check (state in ('pending', 'done', 'gave_up')),
  attempts    int not null default 0,
  due_at      timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  last_error  text check (last_error is null or char_length(last_error) <= 300),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint email_learn_work_key unique (tenant_id, dedupe_key)
);
alter table public.email_learn_work
  add column if not exists attempts int not null default 0,
  add column if not exists lease_token uuid,
  add column if not exists lease_until timestamptz,
  add column if not exists last_error text check (last_error is null or char_length(last_error) <= 300);
create index if not exists email_learn_work_due_idx on public.email_learn_work (due_at) where state = 'pending';
alter table public.email_learn_work enable row level security;
revoke all on public.email_learn_work from public, anon, authenticated;
grant all on public.email_learn_work to service_role;

create or replace function public._email_learn_on_result()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.d7_published_at is not null
     and (old.d7_published_at is null or new.d7_version is distinct from old.d7_version) then
    insert into email_learn_work (tenant_id, kind, dedupe_key, due_at)
    values (new.tenant_id, 'result', 'result:' || new.id::text || ':' || new.d7_version::text, now() + interval '10 minutes')
    on conflict (tenant_id, dedupe_key) do nothing;
  end if;
  return new;
end $$;
revoke all on function public._email_learn_on_result() from public, anon, authenticated;
drop trigger if exists email_learn_on_result on public.email_send_results;
create trigger email_learn_on_result
  after update of d7_published_at, d7_version on public.email_send_results
  for each row execute function public._email_learn_on_result();

create table if not exists public.email_learn_state (
  tenant_id       uuid primary key references public.tenants(id) on delete cascade,
  last_run_at     timestamptz,
  full_skipped    int not null default 0,
  kept_stronger   int not null default 0,
  sources         jsonb not null default '{}'::jsonb,
  seeded_at       timestamptz,
  seed_requested_at timestamptz,
  last_revived_at timestamptz,
  updated_at      timestamptz not null default now()
);
alter table public.email_learn_state
  add column if not exists full_skipped int not null default 0,
  add column if not exists kept_stronger int not null default 0,
  add column if not exists sources jsonb not null default '{}'::jsonb,
  add column if not exists seeded_at timestamptz,
  add column if not exists seed_requested_at timestamptz,
  add column if not exists last_revived_at timestamptz;
alter table public.email_learn_state enable row level security;
revoke all on public.email_learn_state from public, anon, authenticated;
grant all on public.email_learn_state to service_role;

drop function if exists public.request_email_learn_seed(uuid);
drop function if exists public.request_email_learn_seed(uuid, text);
drop function if exists public.complete_email_learn_work(uuid, jsonb, boolean, text);
drop function if exists public.record_email_learning_read(uuid, uuid, jsonb);
drop function if exists public.record_email_learn_sources(uuid, jsonb, boolean);
drop function if exists public.record_email_learn_sources(uuid, jsonb, boolean, jsonb);

create or replace function public.list_email_learnings(p_tenant_id uuid, p_user_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null or p_user_id is null
     or not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_user_id) then
    return jsonb_build_object('items', '[]'::jsonb, 'dismissed', 0, 'state', null);
  end if;
  return jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'text', l.text, 'origin', l.origin, 'status', l.status, 'split', l.split,
               'route', l.route, 'list_id', l.list_id, 'list_name', l.list_name, 'metric', l.metric, 'stats', l.stats,
               'strength', l.strength, 'note', l.note, 'cant_recheck', l.cant_recheck, 'version', l.version,
               'from_zavi', l.from_zavi, 'updated_at', l.updated_at,
               'is_new', (l.origin = 'zavi' or l.from_zavi) and l.status <> 'suggested' and coalesce(s.seen_version, 0) < l.version)
             order by case l.status when 'active' then 0 when 'suggested' then 1 else 2 end, l.updated_at desc)
        from email_learnings l
        left join email_learning_seen s on s.learning_id = l.id and s.user_id = p_user_id
       where l.tenant_id = p_tenant_id and l.status <> 'dismissed'), '[]'::jsonb),
    'dismissed', (select count(*) from email_learnings where tenant_id = p_tenant_id and status = 'dismissed'),
    'state', (select jsonb_build_object('last_run_at', st.last_run_at, 'full_skipped', st.full_skipped,
                                        'kept_stronger', st.kept_stronger, 'sources', st.sources,
                                        'seeded_at', st.seeded_at, 'seed_requested_at', st.seed_requested_at, 'updated_at', st.updated_at)
                from email_learn_state st where st.tenant_id = p_tenant_id)
  );
end $$;
revoke all on function public.list_email_learnings(uuid, uuid) from public, anon, authenticated;
grant execute on function public.list_email_learnings(uuid, uuid) to service_role;

create or replace function public.list_dismissed_email_learnings(p_tenant_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'text', text, 'origin', origin, 'version', version) order by updated_at desc), '[]'::jsonb)
    from email_learnings where tenant_id = p_tenant_id and status = 'dismissed'
$$;
revoke all on function public.list_dismissed_email_learnings(uuid) from public, anon, authenticated;
grant execute on function public.list_dismissed_email_learnings(uuid) to service_role;

create or replace function public._email_learning_cap() returns int
language sql immutable as $$ select 12 $$;
revoke all on function public._email_learning_cap() from public, anon, authenticated;
create or replace function public._email_learning_suggestion_cap() returns int
language sql immutable as $$ select 20 $$;
revoke all on function public._email_learning_suggestion_cap() from public, anon, authenticated;

create or replace function public.set_email_learning(
  p_tenant_id uuid, p_actor_user_id uuid, p_action text, p_id uuid, p_text text, p_version int
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_role   text;
  v_text   text := regexp_replace(btrim(coalesce(p_text, '')), '\s+', ' ', 'g');
  l        email_learnings%rowtype;
  v_active int;
  v_waiting int;
begin
  if p_tenant_id is null or p_actor_user_id is null or p_action not in ('add', 'edit', 'dismiss', 'restore', 'activate') then
    return jsonb_build_object('ok', false, 'code', 'bad_request');
  end if;
  select role into v_role from tenant_users where tenant_id = p_tenant_id and user_id = p_actor_user_id;
  if v_role is null or v_role not in ('owner', 'admin', 'member') then
    return jsonb_build_object('ok', false, 'code', 'not_authorized');
  end if;
  if v_role = 'member' and p_action <> 'add' then
    return jsonb_build_object('ok', false, 'code', 'not_authorized');
  end if;
  if p_action in ('add', 'edit') and (char_length(v_text) < 1 or char_length(v_text) > 300) then
    return jsonb_build_object('ok', false, 'code', 'bad_text');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('email_learnings:' || p_tenant_id::text, 0));
  select count(*) filter (where status = 'active'), count(*) filter (where status = 'suggested')
    into v_active, v_waiting
    from email_learnings where tenant_id = p_tenant_id;

  if p_action = 'add' then
    if v_role in ('owner', 'admin') and v_active >= public._email_learning_cap() then
      return jsonb_build_object('ok', false, 'code', 'list_full');
    end if;
    if v_role = 'member' and v_waiting >= public._email_learning_suggestion_cap() then
      return jsonb_build_object('ok', false, 'code', 'suggestions_full');
    end if;
    insert into email_learnings (tenant_id, text, origin, status, created_by, edited_by)
    values (p_tenant_id, v_text, 'founder', case when v_role in ('owner', 'admin') then 'active' else 'suggested' end,
            p_actor_user_id, p_actor_user_id)
    returning * into l;
    return jsonb_build_object('ok', true, 'id', l.id, 'version', l.version, 'status', l.status);
  end if;

  select * into l from email_learnings where tenant_id = p_tenant_id and id = p_id for update;
  if l.id is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if p_version is null or l.version <> p_version then return jsonb_build_object('ok', false, 'code', 'card_changed'); end if;

  if p_action = 'edit' then
    if l.status = 'dismissed' then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
    update email_learnings
       set text = v_text, from_zavi = (origin = 'zavi' or from_zavi), origin = 'founder', note = null,
           edited_by = p_actor_user_id, version = version + 1, updated_at = now()
     where id = l.id returning * into l;
  elsif p_action = 'dismiss' then
    update email_learnings set status = 'dismissed', edited_by = p_actor_user_id, version = version + 1, updated_at = now()
     where id = l.id returning * into l;
  else
    if (p_action = 'restore' and l.status <> 'dismissed') or (p_action = 'activate' and l.status not in ('suggested', 'stale')) then
      return jsonb_build_object('ok', false, 'code', 'card_changed');
    end if;
    if v_active >= public._email_learning_cap() then return jsonb_build_object('ok', false, 'code', 'list_full'); end if;
    update email_learnings
       set status = 'active', miss_streak = 0, hit_streak = 0, streak_side = null, edited_by = p_actor_user_id,
           version = version + 1, updated_at = now()
     where id = l.id returning * into l;
  end if;
  return jsonb_build_object('ok', true, 'id', l.id, 'version', l.version, 'status', l.status);
end $$;
revoke all on function public.set_email_learning(uuid, uuid, text, uuid, text, int) from public, anon, authenticated;
grant execute on function public.set_email_learning(uuid, uuid, text, uuid, text, int) to service_role;

create or replace function public.mark_email_learnings_seen(p_tenant_id uuid, p_user_id uuid, p_items jsonb)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n int;
begin
  if p_tenant_id is null or p_user_id is null or jsonb_typeof(p_items) <> 'array' then return 0; end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_user_id) then return 0; end if;
  insert into email_learning_seen (tenant_id, learning_id, user_id, seen_version)
  select l.tenant_id, l.id, p_user_id, least((x->>'version')::int, l.version)
    from jsonb_array_elements(p_items) x
    join email_learnings l on l.tenant_id = p_tenant_id and l.id = (x->>'id')::uuid
   where (x->>'version') ~ '^\d{1,9}$'
  on conflict (learning_id, user_id) do update
    set seen_version = greatest(email_learning_seen.seen_version, excluded.seen_version), seen_at = now();
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.mark_email_learnings_seen(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.mark_email_learnings_seen(uuid, uuid, jsonb) to service_role;

create or replace function public.record_email_learn_observations(p_tenant_id uuid, p_rows jsonb)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n int;
begin
  if p_tenant_id is null or jsonb_typeof(p_rows) <> 'array' then return 0; end if;
  insert into email_learn_observations
    (tenant_id, account_key, route, campaign_id, obs_window, list_id, list_name, subject, sent_at, delivered, clicks)
  select p_tenant_id, x->>'account_key', x->>'route', x->>'campaign_id', 'lifetime',
         left(x->>'list_id', 128), left(x->>'list_name', 200), left(coalesce(x->>'subject', ''), 300),
         (x->>'sent_at')::timestamptz,
         case when jsonb_typeof(x->'delivered') = 'number' then greatest(0, (x->>'delivered')::numeric)::int end,
         case when jsonb_typeof(x->'clicks') = 'number' then greatest(0, (x->>'clicks')::numeric)::int end
    from jsonb_array_elements(p_rows) x
   where x->>'route' in ('sendgrid', 'mailchimp', 'klaviyo')
     and char_length(coalesce(x->>'account_key', '')) between 1 and 200
     and char_length(coalesce(x->>'campaign_id', '')) between 1 and 128
     and x->>'sent_at' is not null
  on conflict (tenant_id, account_key, route, campaign_id, obs_window) do update
    set list_id = excluded.list_id, list_name = excluded.list_name, subject = excluded.subject,
        sent_at = excluded.sent_at, delivered = excluded.delivered, clicks = excluded.clicks, observed_at = now();
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.record_email_learn_observations(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_email_learn_observations(uuid, jsonb) to service_role;

create or replace function public.email_learn_inputs(p_tenant_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'results', coalesce((
      select jsonb_agg(to_jsonb(x) - 'rn') from (
        select r.id, r.route, r.provider_ref, r.account_ref, r.list_id, r.list_name, r.subject, r.started_at,
               r.finished_at, r.shared_tag, r.verdict, r.d7,
               row_number() over (
                 partition by r.route,
                              coalesce(r.account_ref->>'connected_account_id', r.account_ref->>'key_digest', ''),
                              coalesce(r.account_ref->>'auth_config_id', ''),
                              coalesce(r.list_id, '')
                 order by r.finished_at desc, r.id) as rn
          from email_send_results r
         where r.tenant_id = p_tenant_id and r.d7_published_at is not null
           and r.finished_at > now() - interval '180 days'
      ) x where x.rn <= 30), '[]'::jsonb),
    'observations', coalesce((
      select jsonb_agg(to_jsonb(y) - 'rn') from (
        select o.account_key, o.route, o.campaign_id, o.list_id, o.list_name, o.subject, o.sent_at, o.delivered, o.clicks,
               row_number() over (partition by o.account_key, o.route order by o.sent_at desc, o.id) as rn
          from email_learn_observations o
         where o.tenant_id = p_tenant_id and o.sent_at > now() - interval '180 days'
      ) y where y.rn <= 20), '[]'::jsonb)
  )
$$;
revoke all on function public.email_learn_inputs(uuid) from public, anon, authenticated;
grant execute on function public.email_learn_inputs(uuid) to service_role;

create or replace function public.apply_email_learn_recompute(p_tenant_id uuid, p_topics jsonb, p_connected jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t        jsonb;
  l        email_learnings%rowtype;
  w        email_learnings%rowtype;
  v_key    text;
  v_holds  boolean;
  v_side   text;
  v_fp     text;
  v_agree  boolean;
  v_active int;
  v_room   boolean;
  v_staled uuid[] := '{}';
  v_added  int := 0; v_updated int := 0; v_stale_n int := 0; v_back int := 0; v_full int := 0; v_kept int := 0;
  v_cap    int := public._email_learning_cap();
  v_rank   numeric;
  c_disagree constant text := 'Newer results disagree with this.';
begin
  if p_tenant_id is null or jsonb_typeof(p_topics) <> 'array' then return jsonb_build_object('ok', false); end if;
  perform pg_advisory_xact_lock(hashtextextended('email_learnings:' || p_tenant_id::text, 0));

  for t in select * from jsonb_array_elements(p_topics) loop
    v_key := (t->>'split') || '|' || coalesce(t->>'route', '') || '|' || coalesce(t->>'list_id', '') || '|'
             || coalesce(t->>'metric', '') || '|' || coalesce(t->>'account_key', '') || '|' || coalesce(t->>'obs_window', '');
    v_rank := coalesce((t->>'rank')::numeric, 0);
    v_holds := coalesce((t->>'holds')::boolean, false);
    v_side := case when t->>'side' in ('a', 'b') then t->>'side' end;
    v_fp := t->>'fingerprint';
    select * into l from email_learnings where tenant_id = p_tenant_id and topic_key = v_key for update;

    if l.id is null then
      if not v_holds then continue; end if;
      select count(*) into v_active from email_learnings where tenant_id = p_tenant_id and status = 'active';
      v_room := v_active < v_cap;
      if not v_room then
        select * into w from email_learnings
         where tenant_id = p_tenant_id and status = 'active' and origin = 'zavi'
         order by coalesce((stats->>'rank')::numeric, 0) asc, updated_at asc limit 1 for update;
        if w.id is null then
          v_full := v_full + 1;
        elsif coalesce((w.stats->>'rank')::numeric, 0) >= v_rank then
          v_kept := v_kept + 1;
        else
          update email_learnings set status = 'stale', note = 'Made room for a stronger lesson.', miss_streak = 0, hit_streak = 0,
                 streak_side = null, version = version + 1, updated_at = now()
           where id = w.id;
          v_staled := v_staled || w.id;
          v_room := true;
        end if;
      end if;
      if not v_room then continue; end if;
      insert into email_learnings (tenant_id, text, origin, status, split, route, list_id, metric, account_key, obs_window,
                                   list_name, stats, strength, side, evidence_fp)
      values (p_tenant_id, left(t->>'text', 300), 'zavi', 'active', t->>'split', t->>'route', t->>'list_id', t->>'metric',
              t->>'account_key', t->>'obs_window', t->>'list_name',
              coalesce(t->'stats', '{}'::jsonb) || jsonb_build_object('rank', v_rank), t->>'strength', v_side, v_fp);
      v_added := v_added + 1;
      continue;
    end if;

    if l.status in ('dismissed', 'suggested') then continue; end if;
    if v_fp is not null and l.evidence_fp is not distinct from v_fp then continue; end if;
    v_agree := v_holds and v_side is not null and v_side is not distinct from l.side;

    if l.origin = 'founder' then
      update email_learnings
         set note = case when v_agree then null else c_disagree end,
             stats = coalesce(t->'stats', stats) || jsonb_build_object('rank', v_rank),
             evidence_fp = coalesce(v_fp, evidence_fp), updated_at = now()
       where id = l.id;
      continue;
    end if;

    if l.status = 'active' then
      if v_agree then
        update email_learnings
           set text = left(t->>'text', 300), stats = coalesce(t->'stats', '{}'::jsonb) || jsonb_build_object('rank', v_rank),
               strength = t->>'strength', list_name = coalesce(t->>'list_name', list_name), miss_streak = 0, hit_streak = 0,
               streak_side = null, evidence_fp = coalesce(v_fp, evidence_fp),
               version = case when text is distinct from left(t->>'text', 300) then version + 1 else version end,
               updated_at = now()
         where id = l.id;
        v_updated := v_updated + 1;
      elsif l.miss_streak + 1 >= 2 then
        update email_learnings
           set status = 'stale', note = c_disagree, miss_streak = 0, hit_streak = 0, streak_side = null,
               evidence_fp = coalesce(v_fp, evidence_fp), version = version + 1, updated_at = now()
         where id = l.id;
        v_stale_n := v_stale_n + 1;
      else
        update email_learnings set miss_streak = miss_streak + 1, evidence_fp = coalesce(v_fp, evidence_fp), updated_at = now()
         where id = l.id;
      end if;
      continue;
    end if;

    if l.id = any(v_staled) then continue; end if;
    if not v_holds or v_side is null then
      update email_learnings set hit_streak = 0, streak_side = null, evidence_fp = coalesce(v_fp, evidence_fp), updated_at = now()
       where id = l.id;
      continue;
    end if;
    if l.streak_side is distinct from v_side then
      update email_learnings set hit_streak = 1, streak_side = v_side, evidence_fp = coalesce(v_fp, evidence_fp), updated_at = now()
       where id = l.id;
      continue;
    end if;
    if l.hit_streak + 1 < 2 then
      update email_learnings set hit_streak = hit_streak + 1, evidence_fp = coalesce(v_fp, evidence_fp), updated_at = now()
       where id = l.id;
      continue;
    end if;
    select count(*) into v_active from email_learnings where tenant_id = p_tenant_id and status = 'active';
    if v_active >= v_cap then
      select * into w from email_learnings
       where tenant_id = p_tenant_id and status = 'active' and origin = 'zavi'
       order by coalesce((stats->>'rank')::numeric, 0) asc, updated_at asc limit 1 for update;
      if w.id is null or coalesce((w.stats->>'rank')::numeric, 0) >= v_rank then
        if w.id is null then v_full := v_full + 1; else v_kept := v_kept + 1; end if;
        update email_learnings set hit_streak = hit_streak + 1, evidence_fp = coalesce(v_fp, evidence_fp), updated_at = now() where id = l.id;
        continue;
      end if;
      update email_learnings set status = 'stale', note = 'Made room for a stronger lesson.', miss_streak = 0, hit_streak = 0,
             streak_side = null, version = version + 1, updated_at = now()
       where id = w.id;
      v_staled := v_staled || w.id;
    end if;
    update email_learnings
       set status = 'active', note = case when v_side is distinct from side then 'Results now point the other way; Zavi rewrote this.' else null end,
           list_name = coalesce(t->>'list_name', list_name),
           text = case when v_side is distinct from side then left(t->>'text', 300) else text end,
           side = v_side, hit_streak = 0, miss_streak = 0, streak_side = null,
           stats = coalesce(t->'stats', '{}'::jsonb) || jsonb_build_object('rank', v_rank), strength = t->>'strength',
           evidence_fp = coalesce(v_fp, evidence_fp), version = version + 1, updated_at = now()
     where id = l.id;
    v_back := v_back + 1;
  end loop;

  if jsonb_typeof(p_connected) = 'array' then
    update email_learnings
       set cant_recheck = (account_key is not null and not (p_connected ? account_key)), updated_at = now()
     where tenant_id = p_tenant_id and status <> 'dismissed'
       and cant_recheck is distinct from (account_key is not null and not (p_connected ? account_key));
  end if;

  insert into email_learn_state (tenant_id, last_run_at, full_skipped, kept_stronger, updated_at)
  values (p_tenant_id, now(), v_full, v_kept, now())
  on conflict (tenant_id) do update set last_run_at = now(), full_skipped = v_full, kept_stronger = v_kept, updated_at = now();

  return jsonb_build_object('ok', true, 'added', v_added, 'updated', v_updated, 'staled', v_stale_n,
                            'reactivated', v_back, 'skipped_full', v_full, 'kept_stronger', v_kept);
end $$;
revoke all on function public.apply_email_learn_recompute(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.apply_email_learn_recompute(uuid, jsonb, jsonb) to service_role;

create or replace function public.record_email_learn_sources(p_tenant_id uuid, p_sources jsonb, p_seeded boolean, p_current jsonb, p_current_authoritative boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_merged jsonb;
begin
  if p_tenant_id is null then return; end if;
  select coalesce(st.sources, '{}'::jsonb) || coalesce(p_sources, '{}'::jsonb) into v_merged
    from (select 1) one left join email_learn_state st on st.tenant_id = p_tenant_id;
  if coalesce(p_current_authoritative, false) and jsonb_typeof(p_current) = 'array' then
    select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_merged
      from jsonb_each(coalesce(v_merged, '{}'::jsonb)) as e(k, v)
     where p_current ? k;
  end if;
  insert into email_learn_state (tenant_id, sources, seeded_at, updated_at)
  values (p_tenant_id, coalesce(v_merged, '{}'::jsonb), case when p_seeded then now() end, now())
  on conflict (tenant_id) do update
    set sources = excluded.sources,
        seeded_at = coalesce(excluded.seeded_at, email_learn_state.seeded_at), updated_at = now();
end $$;
revoke all on function public.record_email_learn_sources(uuid, jsonb, boolean, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.record_email_learn_sources(uuid, jsonb, boolean, jsonb, boolean) to service_role;

create or replace function public.request_email_learn_seed(p_tenant_id uuid, p_sources_hash text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_key text;
  v_id  uuid;
  w     email_learn_work%rowtype;
begin
  if p_tenant_id is null or p_sources_hash is null or p_sources_hash !~ '^[a-f0-9]{8,64}$' then return 'refused'; end if;
  v_key := 'seed:' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD') || ':' || p_sources_hash;
  insert into email_learn_work (tenant_id, kind, dedupe_key)
  values (p_tenant_id, 'seed', v_key)
  on conflict (tenant_id, dedupe_key) do nothing
  returning id into v_id;
  if v_id is not null then
    insert into email_learn_state (tenant_id, seed_requested_at, updated_at) values (p_tenant_id, now(), now())
    on conflict (tenant_id) do update set seed_requested_at = now(), updated_at = now();
    return 'queued';
  end if;
  select * into w from email_learn_work where tenant_id = p_tenant_id and dedupe_key = v_key;
  if w.state = 'done' then return 'done'; end if;
  if w.state = 'pending' and (w.lease_until > now() or (w.attempts = 0 and w.due_at <= now())) then return 'pending'; end if;
  return 'failed_today';
end $$;
revoke all on function public.request_email_learn_seed(uuid, text) from public, anon, authenticated;
grant execute on function public.request_email_learn_seed(uuid, text) to service_role;

create or replace function public.retry_email_learn_seed(p_tenant_id uuid, p_actor_user_id uuid, p_sources_hash text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_out  text;
  v_key  text;
  v_last timestamptz;
  w      email_learn_work%rowtype;
begin
  if p_tenant_id is null or p_actor_user_id is null
     or not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor_user_id and role in ('owner', 'admin')) then
    return 'not_authorized';
  end if;
  v_out := public.request_email_learn_seed(p_tenant_id, p_sources_hash);
  if v_out <> 'failed_today' then return v_out; end if;
  insert into email_learn_state (tenant_id, updated_at) values (p_tenant_id, now()) on conflict (tenant_id) do nothing;
  select last_revived_at into v_last from email_learn_state where tenant_id = p_tenant_id for update;
  if v_last is not null and (v_last at time zone 'UTC')::date = (now() at time zone 'UTC')::date then
    return 'already_retried_today';
  end if;
  v_key := 'seed:' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD') || ':' || p_sources_hash;
  select * into w from email_learn_work where tenant_id = p_tenant_id and dedupe_key = v_key for update;
  if w.state = 'done' then return 'done'; end if;
  if w.state = 'pending' and (w.lease_until > now() or (w.attempts = 0 and w.due_at <= now())) then return 'pending'; end if;
  update email_learn_work
     set state = 'pending', attempts = 0, due_at = now(), lease_token = null, lease_until = null, last_error = null, updated_at = now()
   where id = w.id;
  update email_learn_state set last_revived_at = now(), seed_requested_at = now(), updated_at = now() where tenant_id = p_tenant_id;
  return 'queued';
end $$;
revoke all on function public.retry_email_learn_seed(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.retry_email_learn_seed(uuid, uuid, text) to service_role;

create or replace function public.claim_email_learn_work(p_limit int, p_lease_seconds int)
returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  with due as (
    select w.id from email_learn_work w
     where w.state = 'pending' and w.due_at <= now()
       and (w.lease_until is null or w.lease_until < now())
     order by w.due_at
     limit greatest(1, least(coalesce(p_limit, 50), 200))
     for update skip locked
  ), leased as (
    update email_learn_work w
       set lease_token = gen_random_uuid(),
           lease_until = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 600), 1800))),
           updated_at = now()
      from due where w.id = due.id
    returning w.id, w.tenant_id, w.kind, w.dedupe_key, w.lease_token, w.attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'tenant_id', tenant_id, 'kind', kind,
                                               'dedupe_key', dedupe_key, 'lease_token', lease_token, 'attempts', attempts)), '[]'::jsonb)
    from leased
$$;
revoke all on function public.claim_email_learn_work(int, int) from public, anon, authenticated;
grant execute on function public.claim_email_learn_work(int, int) to service_role;

create or replace function public.complete_email_learn_work(p_tenant_id uuid, p_ids jsonb, p_outcome text, p_error text)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n int;
begin
  if p_tenant_id is null or jsonb_typeof(p_ids) <> 'array' or p_outcome not in ('done', 'failed', 'released') then return 0; end if;
  update email_learn_work w
     set state = case p_outcome when 'done' then 'done' when 'released' then 'pending'
                   else case when w.attempts + 1 >= 6 then 'gave_up' else 'pending' end end,
         attempts = case when p_outcome = 'failed' then w.attempts + 1 else w.attempts end,
         due_at = case p_outcome when 'failed' then now() + make_interval(mins => least(60, 5 * (w.attempts + 1)))
                                 when 'released' then now() else w.due_at end,
         last_error = case when p_outcome = 'failed' then left(p_error, 300) else w.last_error end,
         lease_token = null, lease_until = null, updated_at = now()
    from jsonb_array_elements(p_ids) x
   where w.tenant_id = p_tenant_id
     and w.id = (x->>'id')::uuid and w.lease_token = (x->>'lease_token')::uuid
     and w.state = 'pending';
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.complete_email_learn_work(uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.complete_email_learn_work(uuid, jsonb, text, text) to service_role;

create or replace function public.extend_email_learn_lease(p_tenant_id uuid, p_ids jsonb, p_seconds int)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n int;
begin
  if p_tenant_id is null or jsonb_typeof(p_ids) <> 'array' then return false; end if;
  update email_learn_work w
     set lease_until = now() + make_interval(secs => greatest(30, least(coalesce(p_seconds, 600), 1800))), updated_at = now()
    from jsonb_array_elements(p_ids) x
   where w.tenant_id = p_tenant_id and w.id = (x->>'id')::uuid and w.lease_token = (x->>'lease_token')::uuid
     and w.state = 'pending';
  get diagnostics v_n = row_count;
  return v_n = jsonb_array_length(p_ids);
end $$;
revoke all on function public.extend_email_learn_lease(uuid, jsonb, int) from public, anon, authenticated;
grant execute on function public.extend_email_learn_lease(uuid, jsonb, int) to service_role;

create or replace function public.repair_email_learn_work(p_limit int)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n int;
begin
  insert into email_learn_work (tenant_id, kind, dedupe_key)
  select r.tenant_id, 'result', 'result:' || r.id::text || ':' || r.d7_version::text
    from email_send_results r
   where r.d7_published_at is not null
     and r.d7_published_at > now() - interval '180 days'
     and not exists (select 1 from email_learn_work w
                      where w.tenant_id = r.tenant_id
                        and w.dedupe_key = 'result:' || r.id::text || ':' || r.d7_version::text)
   order by r.d7_published_at desc
   limit greatest(1, least(coalesce(p_limit, 200), 1000))
  on conflict (tenant_id, dedupe_key) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.repair_email_learn_work(int) from public, anon, authenticated;
grant execute on function public.repair_email_learn_work(int) to service_role;

create or replace function public.record_email_learning_read(p_tenant_id uuid, p_run_id uuid, p_status text, p_items jsonb)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n int;
begin
  if p_tenant_id is null or p_run_id is null or p_status not in ('ok', 'empty', 'read_failed') or jsonb_typeof(p_items) <> 'array' then
    return false;
  end if;
  if not exists (select 1 from agent_runs where id = p_run_id and tenant_id = p_tenant_id) then return false; end if;
  insert into email_learning_reads (run_id, tenant_id, status, items) values (p_run_id, p_tenant_id, p_status, p_items)
  on conflict (run_id) do update set status = excluded.status, items = excluded.items
   where email_learning_reads.tenant_id = excluded.tenant_id;
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;
revoke all on function public.record_email_learning_read(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_email_learning_read(uuid, uuid, text, jsonb) to service_role;

create or replace function public.get_email_learning_read(p_tenant_id uuid, p_run_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('status', status, 'items', items)
    from email_learning_reads where tenant_id = p_tenant_id and run_id = p_run_id
$$;
revoke all on function public.get_email_learning_read(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_email_learning_read(uuid, uuid) to service_role;

commit;
