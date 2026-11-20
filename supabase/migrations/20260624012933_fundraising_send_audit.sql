
create table if not exists fundraising_send_audit (
  id                  uuid        primary key default gen_random_uuid(),
  decision_id         uuid,
  run_id              uuid,
  tenant_id           uuid        not null references tenants(id) on delete cascade,
  investor_id         uuid,
  sender              text,
  recipient           text,
  subject             text,
  status              text        not null check (status in (
                                    'authorized','blocked','sent','failed',
                                    'not_connected','manual_task','test_sent'
                                  )),
  provider            text,
  provider_message_id text,
  safety_result       jsonb,
  authorized_by       uuid        references auth.users(id),
  authorized_at       timestamptz,
  created_at          timestamptz not null default now()
);

create index if not exists fundraising_send_audit_tenant_run_idx
  on fundraising_send_audit (tenant_id, run_id);

alter table fundraising_send_audit enable row level security;

drop policy if exists fundraising_send_audit_select on fundraising_send_audit;
create policy fundraising_send_audit_select on fundraising_send_audit
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = fundraising_send_audit.tenant_id)
  );

create or replace function fundraising_send_audit_worm()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  raise exception 'fundraising_send_audit is append-only — UPDATE and DELETE are not permitted'
    using errcode = 'P0001';
end $$;

drop trigger if exists fundraising_send_audit_worm_tg on fundraising_send_audit;
create trigger fundraising_send_audit_worm_tg
  before update or delete on fundraising_send_audit
  for each row execute function fundraising_send_audit_worm();

revoke update, delete on fundraising_send_audit from public;
revoke update, delete on fundraising_send_audit from authenticated;
revoke update, delete on fundraising_send_audit from service_role;

revoke truncate on fundraising_send_audit from public;
revoke truncate on fundraising_send_audit from authenticated;
revoke truncate on fundraising_send_audit from service_role;

create or replace function fundraising_send_audit_worm_truncate()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  raise exception 'fundraising_send_audit is append-only — TRUNCATE is not permitted'
    using errcode = 'P0001';
end $$;

drop trigger if exists fundraising_send_audit_worm_truncate_tg on fundraising_send_audit;
create trigger fundraising_send_audit_worm_truncate_tg
  before truncate on fundraising_send_audit
  for each statement execute function fundraising_send_audit_worm_truncate();
