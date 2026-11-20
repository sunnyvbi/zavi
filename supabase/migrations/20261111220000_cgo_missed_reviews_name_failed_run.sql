
create or replace function public.cgo_missed_reviews(p_now timestamptz, p_grace_hours integer, p_after uuid default null, p_limit integer default 500)
returns table (tenant_id uuid, missed boolean, due_at timestamptz, test boolean, why text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with page as (
    select s.tenant_id
      from tenant_app_setting s
     where s.key = 'cgo_autopilot_enabled'
       and s.value = 'true'::jsonb
       and (p_after is null or s.tenant_id > p_after)
     order by s.tenant_id
     limit least(greatest(coalesce(p_limit, 500), 1), 900)
  ),
  live as (
    select p.tenant_id as id,
           coalesce(t.kind = 'test', false) as test,
           case when t.id is null then null
                else (select min(g.created_at) from autopilot_goals g where g.tenant_id = t.id and g.status = 'active') end as first_goal_at
      from page p
      left join tenants t on t.id = p.tenant_id
                         and t.deleted_at is null
                         and t.disabled_at is null
  ),
  due as (
    select l.id, l.test,
           case when l.first_goal_at is null then null else coalesce(
             (select n.next_review_at
                from cgo_notes n
               where n.tenant_id = l.id
                 and (n.alarm_keys is null or not (n.alarm_keys && array['ad_budget_review', 'cgo_blockers']::text[]))
               order by n.created_at desc
               limit 1),
             l.first_goal_at
           ) end as due_at
      from live l
  ),
  judged as (
    select d.id, d.due_at, d.test,
           d.due_at is not null
           and d.due_at <= p_now - make_interval(hours => p_grace_hours)
           and not exists (
       select 1
         from agent_runs r
        where r.tenant_id = d.id
          and r.agent_slug = 'cgo'
          and r.payload->>'stage' = 'own_goals'
          and r.status not in ('success', 'parse_failed', 'dispatch_error', 'error', 'failed', 'cancelled')
          and r.enqueued_at >= d.due_at
           ) as missed
      from due d
  )
  select j.id,
         j.missed,
         j.due_at,
         j.test,
         case when j.missed then
           (select w.why from (
              select s.wake_reason || ': ' || s.why as why, s.created_at as at
                from cgo_wake_skips s
               where s.tenant_id = j.id and s.created_at >= j.due_at
              union all
              select 'review run ' || r.status || coalesce(': ' || left(r.error::text, 120), ''), coalesce(r.finished_at, r.enqueued_at)
                from agent_runs r
               where r.tenant_id = j.id
                 and r.agent_slug = 'cgo'
                 and r.payload->>'stage' = 'own_goals'
                 and r.status in ('parse_failed', 'dispatch_error', 'error', 'failed', 'cancelled')
                 and not coalesce(
                   array(select jsonb_array_elements_text(case when jsonb_typeof(r.payload->'alarm_keys') = 'array' then r.payload->'alarm_keys' else '[]'::jsonb end))
                     && array['ad_budget_review', 'cgo_blockers']::text[],
                   false)
                 and r.enqueued_at >= j.due_at
            ) w
            order by w.at desc
            limit 1)
         end
    from judged j
   order by j.id;
$$;

revoke all on function public.cgo_missed_reviews(timestamptz, integer, uuid, integer) from public, anon, authenticated;
grant execute on function public.cgo_missed_reviews(timestamptz, integer, uuid, integer) to service_role;
