
begin;

create or replace function staff_audit_log_worm_guard()
returns trigger language plpgsql as $$
begin
  raise exception 'staff_audit_log is append-only (WORM): % blocked', tg_op
    using errcode = '42501';
end $$;

drop trigger if exists staff_audit_log_worm on staff_audit_log;
create trigger staff_audit_log_worm
  before update or delete on staff_audit_log
  for each row execute function staff_audit_log_worm_guard();

alter table staff_audit_log enable row level security;

comment on table staff_audit_log is
  'Append-only (WORM) cross-tenant staff-action compliance log. UPDATE/DELETE blocked by staff_audit_log_worm trigger (incl. service-role). RLS default-deny: read via service-role behind verified staff JWT only, never by clients. See migration 20260707183000 (Move E10).';

commit;
