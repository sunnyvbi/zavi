
create table if not exists slack_outbox (
  id              bigint generated always as identity primary key,
  tenant_id       uuid not null references tenants(id) on delete cascade,
  team_id         text,
  channel_id      text not null,
  thread_ts       text not null default '',
  run_id          uuid,
  kind            text not null,
  body            text not null,
  seq             bigint not null,
  depends_on_seq  bigint,
  status          text not null default 'pending'
                    check (status in ('pending','sending','sent','failed','skipped')),
  attempts        int  not null default 0,
  slack_ts        text,
  last_error      text,
  idempotency_key text,
  enqueued_at     timestamptz not null default now(),
  sent_at         timestamptz,
  unique (tenant_id, channel_id, thread_ts, seq)
);

create unique index if not exists slack_outbox_idem
  on slack_outbox (tenant_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists slack_outbox_pending
  on slack_outbox (status, enqueued_at)
  where status = 'pending';

alter table slack_outbox enable row level security;

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
        and kind = 'answer_anchor';
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
    set status = 'sending', attempts = o.attempts + 1
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
            and d.status = 'sent'
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
