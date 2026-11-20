
alter table slack_outbox add column if not exists claimed_at timestamptz;

create or replace function claim_ready_slack_outbox(p_limit int default 50)
returns setof slack_outbox
language plpgsql security definer set search_path = public as $$
begin
  return query
  update slack_outbox o
    set status = 'sending', attempts = o.attempts + 1, claimed_at = now()
  where o.id in (
    select c.id from slack_outbox c
    where c.status = 'pending'
      and (
        c.depends_on_seq is null
        or exists (
          select 1 from slack_outbox d
          where d.tenant_id = c.tenant_id
            and d.channel_id = c.channel_id
            and d.thread_ts = c.thread_ts
            and d.seq = c.depends_on_seq
            and d.status in ('sent', 'failed', 'skipped')
        )
      )
    order by c.enqueued_at
    for update skip locked
    limit greatest(p_limit, 1)
  )
  returning o.*;
end;
$$;

revoke all on function claim_ready_slack_outbox(int) from public;

create or replace function reap_stale_slack_outbox(p_older_seconds int default 300)
returns int
language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  with reaped as (
    update slack_outbox
      set status = 'failed', last_error = 'stale_sending_reaped'
    where status = 'sending'
      and claimed_at is not null
      and claimed_at < now() - make_interval(secs => greatest(p_older_seconds, 1))
    returning 1
  )
  select count(*) into v_count from reaped;
  return v_count;
end;
$$;

revoke all on function reap_stale_slack_outbox(int) from public;
