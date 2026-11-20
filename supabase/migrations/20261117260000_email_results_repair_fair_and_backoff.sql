begin;

create table if not exists public.email_results_repair_holds (
  rail        text not null check (rail in ('channel_actions', 'decisions')),
  card_id     uuid not null,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  attempts    int not null default 1,
  reason      text check (reason is null or char_length(reason) <= 300),
  retry_at    timestamptz not null,
  updated_at  timestamptz not null default now(),
  primary key (rail, card_id)
);
alter table public.email_results_repair_holds enable row level security;
revoke all on public.email_results_repair_holds from public, anon, authenticated;
grant all on public.email_results_repair_holds to service_role;

create or replace function public.email_results_repair_hold(p_tenant_id uuid, p_rail text, p_card_id uuid, p_reason text)
returns timestamptz
language sql security definer set search_path = public, pg_temp as $$
  insert into email_results_repair_holds as h (rail, card_id, tenant_id, attempts, reason, retry_at)
  values (
    p_rail, p_card_id, p_tenant_id, 1, left(p_reason, 300),
    case when p_reason in ('no_card', 'not_a_versions_card') then 'infinity'::timestamptz
         else now() + interval '10 minutes' end
  )
  on conflict (rail, card_id) do update
    set attempts = h.attempts + 1,
        reason = excluded.reason,
        retry_at = case when excluded.retry_at = 'infinity'::timestamptz then excluded.retry_at
                        else now() + least(interval '12 hours', interval '10 minutes' * power(2, least(h.attempts, 10))) end,
        updated_at = now()
    where h.tenant_id = excluded.tenant_id
  returning h.retry_at;
$$;
revoke all on function public.email_results_repair_hold(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.email_results_repair_hold(uuid, text, uuid, text) to service_role;

create or replace function public.email_results_missing(p_since timestamptz, p_limit int)
returns table (tenant_id uuid, rail text, card_id uuid, sent int)
language sql security definer set search_path = public, pg_temp as $$
  select f.tenant_id, f.rail, f.card_id, f.sent from (
    select m.tenant_id, m.rail, m.card_id, m.sent, m.at,
           row_number() over (partition by m.tenant_id order by m.at desc, m.card_id) as turn
      from (
        select c.tenant_id, 'channel_actions'::text as rail, c.id as card_id, null::int as sent, c.executed_at as at
          from channel_actions c
         where c.exec_class = 'email_campaign.create_and_send' and c.exec_status = 'executed'
           and c.executed_at >= p_since
           and jsonb_typeof(c.exec_payload->'variants') = 'array'
           and not exists (select 1 from email_send_results x where x.rail = 'channel_actions' and x.card_id = c.id)
        union all
        select r.tenant_id, 'decisions'::text, r.card_id, null::int, r.recorded_at
          from email_send_refs r
          join decisions d on d.id = r.card_id and d.tenant_id = r.tenant_id
         where r.rail = 'decisions' and r.recorded_at >= p_since and d.status = 'acted'
           and not exists (select 1 from email_send_results x where x.rail = 'decisions' and x.card_id = r.card_id)
        union all
        select s.tenant_id, 'decisions'::text, s.decision_id, s.sent, s.created_at
          from email_bulk_sends s
         where s.sent > 0 and s.created_at >= p_since
           and (s.status in ('done', 'failed')
                or (s.status = 'held' and coalesce(s.hold_reason, '') not in
                    ('abuse_complaints', 'abuse_bounces', 'provider_refused', 'bulk_check_failed', 'email_paused')))
           and not exists (select 1 from email_send_results x where x.rail = 'decisions' and x.card_id = s.decision_id)
      ) m
     where not exists (select 1 from email_results_repair_holds h where h.rail = m.rail and h.card_id = m.card_id and h.retry_at > now())
  ) f
  order by f.turn, f.at desc, f.tenant_id
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;
revoke all on function public.email_results_missing(timestamptz, int) from public, anon, authenticated;
grant execute on function public.email_results_missing(timestamptz, int) to service_role;

commit;
