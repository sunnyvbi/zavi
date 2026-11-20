
begin;

drop function if exists public.sync_ad_holds_to_live(uuid, text[]);

create or replace function public.sync_ad_holds_to_live(p_tenant_id uuid, p_platforms text[], p_read_started_at timestamptz)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget   ad_budgets%rowtype;
  v_today    date;
  v_o        record;
  v_r        jsonb;
  v_target   numeric(12,2);
  v_released int := 0;
  v_rel_usd  numeric(12,2) := 0;
  v_lowered  int := 0;
  v_n        int;
  v_daily    numeric(12,2);
  v_fence    timestamptz;
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
  v_fence := least(p_read_started_at, now()) - interval '2 minutes';

  for v_o in
    with obj as (
      select r.platform, r.object_id,
             sum(r.daily_delta_usd) filter (where r.status = 'committed') as held,
             max(greatest(r.created_at, r.updated_at)) as last_change,
             bool_or(r.op in ('create', 'resume') or r.idem_key like 'shrink:%') as whole_rate
        from ad_budget_reservations r
       where r.budget_id = v_budget.id and r.tenant_id = p_tenant_id
         and r.platform in ('meta', 'google') and r.platform = any(p_platforms)
         and r.status in ('reserved', 'committed') and r.object_id is not null
       group by r.platform, r.object_id
      having not bool_or(r.status = 'reserved') and not bool_or(r.paused) and not bool_or(r.pause_due)
    ), led as (
      select c.platform, c.object_id,
             min(c.as_of) as as_of,
             bool_and(c.as_of >= v_fence or upper(coalesce(c.status, '')) = 'REMOVED') as fresh,
             bool_and(upper(coalesce(c.status, '')) in
                      ('PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'ARCHIVED', 'DELETED', 'REMOVED', 'ENDED')) as stopped,
             bool_and(c.budget_kind = 'daily' and c.budget_usd is not null) as has_daily,
             max(c.budget_usd) as daily_budget
        from ad_campaigns c
       where c.tenant_id = p_tenant_id
       group by c.platform, c.object_id
      union all
      select c.platform, c.campaign_id,
             min(c.as_of),
             true,
             bool_and(upper(coalesce(c.status, '')) in
                      ('PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'ARCHIVED', 'DELETED', 'REMOVED', 'ENDED')),
             bool_and(c.campaign_budget_usd is not null),
             max(c.campaign_budget_usd)
        from ad_campaigns c
       where c.tenant_id = p_tenant_id and c.platform = 'meta' and c.level = 'ad_set' and c.campaign_id is not null
         and (c.as_of >= v_fence or upper(coalesce(c.status, '')) = 'REMOVED')
         and not exists (
           select 1 from ad_campaigns x
            where x.tenant_id = p_tenant_id and x.platform = c.platform and x.object_id = c.campaign_id)
       group by c.platform, c.campaign_id
    ), zavi as (
      select z.platform, z.object_id,
             bool_or(z.change_kind = 'status') as touched_status,
             min(z.before_daily_usd) filter (where z.change_kind = 'budget') as base
        from ad_object_changes z
       where z.tenant_id = p_tenant_id and z.source = 'zavi'
       group by z.platform, z.object_id
    )
    select o.platform, o.object_id, o.held, l.stopped, l.has_daily, l.daily_budget,
           case when o.whole_rate or z.object_id is null or z.touched_status or z.base is null then 0
                else z.base end as base
      from obj o
      join led l on l.platform = o.platform and l.object_id = o.object_id and l.fresh
      left join zavi z on z.platform = o.platform and z.object_id = o.object_id
     where o.held > 0 and o.last_change < v_fence
  loop
    if v_o.stopped then
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
    elsif v_o.has_daily then
      v_target := greatest(v_o.daily_budget - v_o.base, 0);
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

commit;
