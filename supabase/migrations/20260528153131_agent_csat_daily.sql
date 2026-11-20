
create table agent_csat_daily (
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_slug text not null,
  day date not null,
  thumbs_up int not null default 0,
  thumbs_down int not null default 0,
  total int not null default 0,
  pct_positive numeric,
  computed_at timestamptz not null default now(),
  primary key (tenant_id, agent_slug, day)
);

create index agent_csat_daily_tenant_day
  on agent_csat_daily (tenant_id, day desc);

alter table agent_csat_daily enable row level security;

create policy agent_csat_daily_member_select on agent_csat_daily
  for select using (
    exists (select 1 from tenant_users tu
              where tu.user_id = auth.uid()
                and tu.tenant_id = agent_csat_daily.tenant_id)
  );

create or replace function rollup_agent_csat(p_day date default current_date)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  insert into agent_csat_daily
    (tenant_id, agent_slug, day, thumbs_up, thumbs_down, total, pct_positive, computed_at)
  select
    af.tenant_id,
    af.agent_slug,
    p_day,
    count(*) filter (where af.rating = 1)::int,
    count(*) filter (where af.rating = -1)::int,
    count(*)::int,
    case when count(*) > 0
      then round(count(*) filter (where af.rating = 1)::numeric / count(*)::numeric, 4)
      else null
    end,
    now()
  from agent_feedback af
  where af.target_type = 'agent_run'
    and af.rating in (-1, 1)
    and af.created_at >= p_day::timestamptz
    and af.created_at <  (p_day + 1)::timestamptz
  group by af.tenant_id, af.agent_slug
  on conflict (tenant_id, agent_slug, day) do update set
    thumbs_up    = excluded.thumbs_up,
    thumbs_down  = excluded.thumbs_down,
    total        = excluded.total,
    pct_positive = excluded.pct_positive,
    computed_at  = excluded.computed_at;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function rollup_agent_csat(date) from public;
