
create table if not exists regression_signatures (
  signature        text        primary key,
  status           text        not null default 'pending'
                   check (status in ('pending', 'armed', 'regressed')),
  sig_version      int         not null default 1,
  code_class       text        not null,
  agent_slug       text        not null,
  engine           text,
  armed_by         text,
  armed_at         timestamptz,
  armed_pr_url     text,
  regressed_at     timestamptz,
  first_seen       timestamptz not null default now(),
  last_seen        timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists regression_signatures_armed_idx
  on regression_signatures (status)
  where status = 'armed';

create table if not exists regression_signature_occurrences (
  id           bigint      generated always as identity primary key,
  signature    text        not null references regression_signatures(signature) on delete cascade,
  run_id       uuid        not null unique,
  tenant_id    uuid        not null,
  status_class text        not null,
  seen_at      timestamptz not null default now()
);

create index if not exists regression_occurrences_seen_idx
  on regression_signature_occurrences (seen_at desc);

alter table regression_signatures enable row level security;
alter table regression_signature_occurrences enable row level security;

create or replace function register_regression_signature(
  p_run_id      uuid,
  p_signature   text,
  p_sig_version int,
  p_code_class  text,
  p_agent_slug  text,
  p_engine      text default null
) returns table (matched_tenant uuid, was_recurrence boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_tenant       uuid;
  v_status_class text;
  v_flipped      bigint := 0;
  v_recurrence   boolean := false;
begin
  if p_run_id is null then
    raise exception 'register_regression_signature: null run_id' using errcode = '22023';
  end if;
  if p_signature is null or char_length(p_signature) < 8 then
    raise exception 'register_regression_signature: bad signature' using errcode = '22023';
  end if;
  if p_code_class is null or char_length(p_code_class) < 1 then
    raise exception 'register_regression_signature: empty code_class' using errcode = '22023';
  end if;

  select tenant_id, status into v_tenant, v_status_class
    from agent_runs where id = p_run_id;
  if v_tenant is null then
    return query select null::uuid, false;
    return;
  end if;

  insert into regression_signatures (
    signature, status, sig_version, code_class, agent_slug, engine, first_seen, last_seen
  ) values (
    p_signature, 'pending', coalesce(p_sig_version, 1), p_code_class, p_agent_slug, p_engine, now(), now()
  )
  on conflict (signature) do update
    set last_seen = now(), updated_at = now();

  insert into regression_signature_occurrences (
    signature, run_id, tenant_id, status_class
  ) values (
    p_signature, p_run_id, v_tenant, coalesce(v_status_class, 'failed')
  )
  on conflict (run_id) do nothing;

  update regression_signatures
     set status = 'regressed', regressed_at = now(), updated_at = now()
   where signature = p_signature and status = 'armed';
  get diagnostics v_flipped = row_count;
  v_recurrence := (v_flipped = 1);

  return query select v_tenant, v_recurrence;
end $$;
revoke all on function register_regression_signature(uuid, text, int, text, text, text) from public;
revoke all on function register_regression_signature(uuid, text, int, text, text, text) from authenticated;
grant execute on function register_regression_signature(uuid, text, int, text, text, text) to service_role;

create or replace function arm_regression_signature(
  p_signature   text,
  p_armed_by    text,
  p_armed_pr_url text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_changed bigint;
begin
  if p_signature is null or char_length(p_signature) < 8 then
    raise exception 'arm_regression_signature: bad signature' using errcode = '22023';
  end if;
  if p_armed_by is null or char_length(p_armed_by) < 1 then
    raise exception 'arm_regression_signature: empty armed_by' using errcode = '22023';
  end if;

  update regression_signatures
     set status       = 'armed',
         armed_by     = left(p_armed_by, 120),
         armed_at     = now(),
         armed_pr_url = left(p_armed_pr_url, 300),
         updated_at   = now()
   where signature = p_signature and status = 'pending';
  get diagnostics v_changed = row_count;

  if v_changed = 0 then
    return false;
  end if;

  insert into praxis_logs (level, source, code, message, meta)
  values ('info', 'regression-mint', 'regression_signature_armed', 'regression signature armed',
          jsonb_build_object('signature', p_signature, 'armed_by', left(p_armed_by, 120),
                             'armed_pr_url', left(coalesce(p_armed_pr_url, ''), 300)));

  return true;
end $$;
revoke all on function arm_regression_signature(text, text, text) from public;
revoke all on function arm_regression_signature(text, text, text) from authenticated;
grant execute on function arm_regression_signature(text, text, text) to service_role;
