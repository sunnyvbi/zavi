
create or replace function purge_old_slack_outbox(
  p_older_days int default 30,
  p_limit int default 1000
) returns int
language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  with doomed as (
    select id from slack_outbox
    where status in ('sent', 'failed', 'skipped')
      and enqueued_at < now() - make_interval(days => greatest(p_older_days, 1))
    order by enqueued_at
    limit greatest(p_limit, 1)
  ),
  purged as (
    delete from slack_outbox o using doomed d where o.id = d.id
    returning 1
  )
  select count(*) into v_count from purged;
  return v_count;
end;
$$;

revoke all on function purge_old_slack_outbox(int, int) from public;
