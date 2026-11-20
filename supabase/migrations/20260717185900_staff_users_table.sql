
begin;

create table if not exists staff_users (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  email            text,
  role             text not null default 'staff',
  granted_by       uuid,
  granted_by_email text,
  granted_at       timestamptz not null default now(),
  revoked_at       timestamptz,
  revoked_by       uuid,
  revoked_by_email text,
  note             text
);

comment on table staff_users is
  'Source of truth for admin-dashboard (staff) access. Row with revoked_at IS NULL = active staff; staffMiddleware() reads this live per request. Managed by /api/admin/super-users. RLS default-deny: service-role only. See migration 20260717185900.';

create index if not exists staff_users_active
  on staff_users (user_id) where revoked_at is null;

alter table staff_users enable row level security;

insert into staff_users (user_id, email, role, granted_by, granted_at, note)
select u.id,
       u.email,
       'staff',
       null,
       now(),
       'seed 20260717185900: migrated from app_metadata.role=staff / bootstrap'
from auth.users u
where u.raw_app_meta_data->>'role' = 'staff'
   or lower(u.email) = 'ravi@upcar.ai'
on conflict (user_id) do nothing;

commit;
