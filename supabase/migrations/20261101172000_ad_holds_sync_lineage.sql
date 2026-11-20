
begin;

create index if not exists ad_budget_reservations_object_idx
  on public.ad_budget_reservations (budget_id, platform, object_id, status);

create table if not exists public.ad_hold_live_reads (
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  platform      text not null check (platform in ('meta', 'google')),
  object_id     text not null check (char_length(object_id) between 1 and 64),
  cur_read_at   timestamptz not null,
  cur_stopped   boolean not null,
  cur_budget    numeric(12,2),
  prev_read_at  timestamptz,
  prev_stopped  boolean,
  prev_budget   numeric(12,2),
  primary key (tenant_id, platform, object_id)
);
alter table public.ad_hold_live_reads enable row level security;
revoke all on public.ad_hold_live_reads from public, anon, authenticated;

create or replace function public.ad_budget_read_start(p_tenant_id uuid)
returns timestamptz
language sql stable security definer set search_path = public, pg_temp as $$
  select now()
$$;
revoke all on function public.ad_budget_read_start(uuid) from public, anon, authenticated;
grant execute on function public.ad_budget_read_start(uuid) to service_role;

create or replace function public.sync_ad_holds_to_live(p_tenant_id uuid, p_platforms text[], p_read_started_at timestamptz)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_budget     ad_budgets%rowtype;
  v_today      date;
  v_o          record;
  v_p          ad_hold_live_reads%rowtype;
  v_r          jsonb;
  v_target     numeric(12,2);
  v_budget_usd numeric(12,2);
  v_released   int := 0;
  v_rel_usd    numeric(12,2) := 0;
  v_lowered    int := 0;
  v_n          int;
  v_read_from  timestamptz;
  v_fence      timestamptz;
begin
  if p_tenant_id is null then
    raise exception 'sync_ad_holds_to_live: tenant is required';
  end if;
  if p_read_started_at is null then
    raise exception 'sync_ad_holds_to_live: read start is required';
  end if;
  if p_platforms is null or cardinality(p_platforms) = 0 then
    return jsonb_build_object('status', 'no_platforms', 'released', 0, 'lowered', 0);
  end if;
  select * into v_budget from ad_budgets
   where tenant_id = p_tenant_id and status = 'active'
   for update;
  if not found then
    return jsonb_build_object('status', 'no_budget', 'released', 0, 'lowered', 0);
  end if;
  v_today := _ad_budget_today();
  v_read_from := least(p_read_started_at, now());
  v_fence := v_read_from - interval '2 minutes';

  delete from ad_hold_live_reads
   where tenant_id = p_tenant_id and cur_read_at < now() - interval '7 days';

  for v_o in
    with recursive obj as (
      select r.platform, r.object_id,
             sum(r.daily_delta_usd) filter (where r.status = 'committed') as held,
             max(greatest(r.created_at, r.updated_at)) as last_change
        from ad_budget_reservations r
       where r.budget_id = v_budget.id and r.tenant_id = p_tenant_id
         and r.platform in ('meta', 'google') and r.platform = any(p_platforms)
         and r.status in ('reserved', 'committed') and r.object_id is not null
       group by r.platform, r.object_id
      having not bool_or(r.status = 'reserved') and not bool_or(r.paused) and not bool_or(r.pause_due)
    ), lin as (
      select r.id, r.platform, r.object_id, r.op, r.idem_key, r.created_at,
             r.channel_action_id, r.decision_id, 0 as depth
        from ad_budget_reservations r
        join obj o on o.platform = r.platform and o.object_id = r.object_id
       where r.budget_id = v_budget.id and r.tenant_id = p_tenant_id and r.status = 'committed'
      union
      select p.id, p.platform, p.object_id, p.op, p.idem_key, p.created_at,
             p.channel_action_id, p.decision_id, lin.depth + 1
        from lin
        join ad_budget_reservations p
          on p.budget_id = v_budget.id and p.tenant_id = p_tenant_id
         and p.platform = lin.platform and p.object_id = lin.object_id
         and p.status = 'released' and p.reason = 'rebased' and p.updated_at = lin.created_at
       where lin.op = 'rebase' and lin.idem_key not like 'shrink:%' and lin.depth < 32
    ), span as (
      select platform, object_id, min(created_at) as first_at, max(created_at) as last_at
        from lin group by platform, object_id
    ), leaf as (
      select l.platform, l.object_id, l.op, l.idem_key, l.channel_action_id, l.decision_id
        from lin l
       where not (l.op = 'rebase' and l.idem_key not like 'shrink:%' and l.depth < 32 and exists (
               select 1 from ad_budget_reservations x
                where x.budget_id = v_budget.id and x.tenant_id = p_tenant_id
                  and x.platform = l.platform and x.object_id = l.object_id and x.id <> l.id
                  and x.status = 'released' and x.reason = 'rebased' and x.updated_at = l.created_at))
      union all
      select x.platform, x.object_id, x.op, x.idem_key, x.channel_action_id, x.decision_id
        from ad_budget_reservations x
        join span s on s.platform = x.platform and s.object_id = x.object_id
       where x.budget_id = v_budget.id and x.tenant_id = p_tenant_id
         and (x.status = 'refused'
              or (x.status = 'released' and coalesce(x.reason, '') not in
                  ('rebased', 'live_stopped', 'idle_paused', 'absent_on_platform', 'month_rollover',
                   'budget_stopped', 'budget_ended', 'handed_over')))
         and x.created_at <= s.last_at and x.updated_at >= s.first_at
    ), base as (
      select l.platform, l.object_id,
             min(case
                   when l.idem_key like 'shrink:%' then 0
                   when l.op = 'raise' then coalesce((
                     select min(z.before_daily_usd) from ad_object_changes z
                      where z.tenant_id = p_tenant_id and z.source = 'zavi' and z.change_kind = 'budget'
                        and z.platform = l.platform and z.object_id = l.object_id
                        and ((z.action_table = 'channel_actions' and z.action_id = l.channel_action_id)
                             or (z.action_table = 'decisions' and z.action_id = l.decision_id))), 0)
                   else 0
                 end) as base
        from leaf l group by l.platform, l.object_id
    ), kids as (
      select c.platform, c.campaign_id,
             bool_and(upper(coalesce(c.status, '')) in
                      ('PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'ARCHIVED', 'DELETED', 'REMOVED', 'ENDED')) as stopped,
             bool_and(c.campaign_budget_usd is not null) filter (where upper(coalesce(c.status, '')) <> 'REMOVED') as has_daily,
             max(c.campaign_budget_usd) filter (where upper(coalesce(c.status, '')) <> 'REMOVED') as daily_budget
        from ad_campaigns c
       where c.tenant_id = p_tenant_id and c.platform = 'meta' and c.level = 'ad_set' and c.campaign_id is not null
         and c.as_of >= v_read_from
       group by c.platform, c.campaign_id
    ), led as (
      select c.platform, c.object_id,
             bool_and(c.as_of >= v_read_from or upper(coalesce(c.status, '')) = 'REMOVED') as fresh,
             bool_and(upper(coalesce(c.status, '')) in
                      ('PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'ARCHIVED', 'DELETED', 'REMOVED', 'ENDED')) as stopped,
             bool_and(c.budget_kind = 'daily' and c.budget_usd is not null) as has_daily,
             max(c.budget_usd) as daily_budget
        from ad_campaigns c
       where c.tenant_id = p_tenant_id
         and not exists (select 1 from kids k where k.platform = c.platform and k.campaign_id = c.object_id)
       group by c.platform, c.object_id
      union all
      select k.platform, k.campaign_id, true, k.stopped, coalesce(k.has_daily, false), k.daily_budget
        from kids k
    )
    select o.platform, o.object_id, o.held, l.stopped, l.has_daily, l.daily_budget,
           coalesce(b.base, 0) as base,
           o.last_change < v_fence as judged,
           (select max(greatest(r.created_at, r.updated_at))
              from ad_budget_reservations r
             where r.budget_id = v_budget.id and r.tenant_id = p_tenant_id
               and r.platform = o.platform and r.object_id = o.object_id and r.op in ('create', 'resume')
               and (r.status = 'committed' or (r.status = 'released' and r.reason = 'rebased'))) as switched_on_at
      from obj o
      join led l on l.platform = o.platform and l.object_id = o.object_id and l.fresh
      left join base b on b.platform = o.platform and b.object_id = o.object_id
     where o.held > 0
  loop
    select * into v_p from ad_hold_live_reads
     where tenant_id = p_tenant_id and platform = v_o.platform and object_id = v_o.object_id
     for update;
    if not found then
      insert into ad_hold_live_reads (tenant_id, platform, object_id, cur_read_at, cur_stopped, cur_budget)
      values (p_tenant_id, v_o.platform, v_o.object_id, v_read_from, v_o.stopped,
              case when v_o.has_daily then v_o.daily_budget end);
      continue;
    elsif v_p.cur_read_at > v_read_from then
      continue;
    elsif v_p.cur_read_at < v_read_from then
      update ad_hold_live_reads
         set prev_read_at = cur_read_at, prev_stopped = cur_stopped, prev_budget = cur_budget,
             cur_read_at = v_read_from, cur_stopped = v_o.stopped,
             cur_budget = case when v_o.has_daily then v_o.daily_budget end
       where tenant_id = p_tenant_id and platform = v_o.platform and object_id = v_o.object_id
       returning * into v_p;
    end if;
    if not v_o.judged or v_p.prev_read_at is null
       or v_p.prev_read_at > v_read_from - interval '20 minutes'
       or v_p.prev_read_at < v_read_from - interval '3 hours'
       or v_p.prev_read_at < v_o.switched_on_at then
      continue;
    end if;

    if v_o.stopped and v_p.prev_stopped then
      update ad_budget_reservations
         set status = 'released', released_on = v_today, reason = 'live_stopped',
             pause_due = false, updated_at = now()
       where budget_id = v_budget.id and tenant_id = p_tenant_id
         and platform = v_o.platform and object_id = v_o.object_id and status = 'committed';
      get diagnostics v_n = row_count;
      if v_n > 0 then
        v_released := v_released + v_n;
        v_rel_usd := v_rel_usd + v_o.held;
      end if;
    elsif not v_o.stopped and v_o.has_daily and not v_p.prev_stopped and v_p.prev_budget is not null then
      v_budget_usd := greatest(v_o.daily_budget, v_p.prev_budget);
      v_target := greatest(v_budget_usd - v_o.base, 0);
      if v_target < v_o.held then
        v_r := rebase_ad_spend_for_object(p_tenant_id, v_o.platform, v_o.object_id, v_target,
                 'live:' || v_o.platform || ':' || v_o.object_id || ':' || v_today::text || ':' || v_target::text || ':'
                 || extract(epoch from p_read_started_at)::bigint::text);
        if v_r->>'status' = 'rebased' then
          v_lowered := v_lowered + 1;
        end if;
      end if;
    end if;
  end loop;

  return jsonb_build_object('status', 'done', 'released', v_released,
                            'released_daily_usd', v_rel_usd, 'lowered', v_lowered);
end $$;

revoke all on function public.sync_ad_holds_to_live(uuid, text[], timestamptz) from public, anon, authenticated;
grant execute on function public.sync_ad_holds_to_live(uuid, text[], timestamptz) to service_role;

create or replace function public.sync_ad_holds_to_live(p_tenant_id uuid, p_platforms text[])
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('status', 'skipped', 'released', 0, 'released_daily_usd', 0, 'lowered', 0)
$$;
revoke all on function public.sync_ad_holds_to_live(uuid, text[]) from public, anon, authenticated;
grant execute on function public.sync_ad_holds_to_live(uuid, text[]) to service_role;

commit;
