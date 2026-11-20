
create or replace function enqueue_slack_outbox(
  p_tenant_id uuid,
  p_channel_id text,
  p_thread_ts text,
  p_kind text,
  p_body text,
  p_run_id uuid default null,
  p_team_id text default null,
  p_idempotency_key text default null,
  p_anchor boolean default false,
  p_anchor_slack_ts text default null,
  p_depends_on_answer boolean default false
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_thread text := coalesce(p_thread_ts, '');
  v_seq bigint;
  v_dep bigint;
  v_existing bigint;
  v_anchor_seq bigint;
begin
  if p_idempotency_key is not null then
    select seq into v_existing from slack_outbox
      where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || '|' || p_channel_id || '|' || v_thread, 0));

  select coalesce(max(seq), 0) into v_seq from slack_outbox
    where tenant_id = p_tenant_id and channel_id = p_channel_id and thread_ts = v_thread;

  v_dep := nullif(v_seq, 0);
  v_seq := v_seq + 1;

  if p_depends_on_answer then
    select max(seq) into v_anchor_seq from slack_outbox
      where tenant_id = p_tenant_id and channel_id = p_channel_id and thread_ts = v_thread
        and kind in ('answer_barrier', 'answer_anchor');
    if v_anchor_seq is not null then
      v_dep := greatest(coalesce(v_dep, 0), v_anchor_seq);
    end if;
  end if;

  insert into slack_outbox (
    tenant_id, team_id, channel_id, thread_ts, run_id, kind, body, seq,
    depends_on_seq, status, slack_ts, sent_at, idempotency_key
  ) values (
    p_tenant_id, p_team_id, p_channel_id, v_thread, p_run_id, p_kind, p_body, v_seq,
    v_dep,
    case when p_anchor then 'sent' else 'pending' end,
    case when p_anchor then p_anchor_slack_ts else null end,
    case when p_anchor then now() else null end,
    p_idempotency_key
  );

  return v_seq;
end;
$$;

revoke all on function enqueue_slack_outbox(uuid, text, text, text, text, uuid, text, text, boolean, text, boolean) from public;

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
      and c.kind not in ('answer_barrier', 'answer_anchor')
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

create or replace function reserve_slack_answer_barrier(
  p_tenant_id uuid,
  p_channel_id text,
  p_thread_ts text,
  p_run_id uuid,
  p_idempotency_key text
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_thread text := coalesce(p_thread_ts, '');
  v_seq bigint;
  v_existing bigint;
begin
  select seq into v_existing from slack_outbox
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
  if v_existing is not null then
    return v_existing;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || '|' || p_channel_id || '|' || v_thread, 0));

  select coalesce(max(seq), 0) + 1 into v_seq from slack_outbox
    where tenant_id = p_tenant_id and channel_id = p_channel_id and thread_ts = v_thread;

  insert into slack_outbox (
    tenant_id, channel_id, thread_ts, run_id, kind, body, seq, status, idempotency_key
  ) values (
    p_tenant_id, p_channel_id, v_thread, p_run_id, 'answer_barrier', '', v_seq, 'pending', p_idempotency_key
  );
  return v_seq;
end;
$$;

revoke all on function reserve_slack_answer_barrier(uuid, text, text, uuid, text) from public;

create or replace function complete_slack_answer_barrier(
  p_tenant_id uuid,
  p_channel_id text,
  p_thread_ts text,
  p_run_id uuid,
  p_idempotency_key text,
  p_slack_ts text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_thread text := coalesce(p_thread_ts, '');
  v_updated int;
  v_seq bigint;
begin
  update slack_outbox
    set status = 'sent', slack_ts = p_slack_ts, sent_at = now()
  where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key
    and kind = 'answer_barrier';
  get diagnostics v_updated = row_count;
  if v_updated > 0 then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || '|' || p_channel_id || '|' || v_thread, 0));
  select coalesce(max(seq), 0) + 1 into v_seq from slack_outbox
    where tenant_id = p_tenant_id and channel_id = p_channel_id and thread_ts = v_thread;
  insert into slack_outbox (
    tenant_id, channel_id, thread_ts, run_id, kind, body, seq, status, slack_ts, sent_at, idempotency_key
  ) values (
    p_tenant_id, p_channel_id, v_thread, p_run_id, 'answer_barrier', '', v_seq, 'sent', p_slack_ts, now(), p_idempotency_key
  )
  on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing;
end;
$$;

revoke all on function complete_slack_answer_barrier(uuid, text, text, uuid, text, text) from public;

drop function if exists reap_stale_slack_outbox(int);
create or replace function reap_stale_slack_outbox(
  p_older_seconds int default 300,
  p_barrier_older_seconds int default 1800
) returns int
language plpgsql security definer set search_path = public as $$
declare v_count int; v_bar int;
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

  with reaped_bar as (
    update slack_outbox
      set status = 'skipped', last_error = 'stale_barrier_reaped'
    where status = 'pending'
      and kind = 'answer_barrier'
      and enqueued_at < now() - make_interval(secs => greatest(p_barrier_older_seconds, 1))
    returning 1
  )
  select count(*) into v_bar from reaped_bar;

  return v_count + v_bar;
end;
$$;

revoke all on function reap_stale_slack_outbox(int, int) from public;
