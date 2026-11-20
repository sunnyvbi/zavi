
set search_path = public;

create table if not exists staff_access_log (
  id uuid primary key default gen_random_uuid(),
  staff_user_id uuid null,
  email text null,
  route text not null,
  ip text null,
  ua text null,
  ts timestamptz not null default now()
);

comment on table staff_access_log is
  'Audit trail for /api/staff/* hits. Both successful and failed auths land here. See migration 0068 + decisions/agent-flow-hardening-2026-05-14.md Track B locked-decision-3.';

comment on column staff_access_log.staff_user_id is
  'JWT sub for successful auths; nullable on failed auths.';

comment on column staff_access_log.email is
  'Normalized (lowercase, trimmed) JWT email for successful auths; nullable on failed auths.';

comment on column staff_access_log.route is
  'req.originalUrl at the time the middleware ran. Includes query string.';

create index if not exists staff_access_log_ts on staff_access_log (ts desc);

alter table staff_access_log enable row level security;
