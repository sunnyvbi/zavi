
begin;

alter table tenant_routines
  add column if not exists provenance_origin text not null default 'machine_distilled';

alter table tenant_routines
  drop constraint if exists tenant_routines_provenance_origin_chk;
alter table tenant_routines
  add constraint tenant_routines_provenance_origin_chk
  check (provenance_origin in ('machine_distilled', 'tenant_authored'));

alter table tenant_routines add column if not exists created_by  uuid;
alter table tenant_routines add column if not exists approved_by  uuid;
alter table tenant_routines add column if not exists approved_at  timestamptz;

alter table tenant_routines add column if not exists max_cents integer
  check (max_cents is null or max_cents >= 0);

alter table tenant_routines add column if not exists run_count integer not null default 0;

alter table tenant_routines
  drop constraint if exists tenant_routines_tenant_authored_pinned_chk;
alter table tenant_routines
  add constraint tenant_routines_tenant_authored_pinned_chk
  check (
    not (provenance_origin = 'tenant_authored'
         and status = 'approved'
         and approved_spec_hash is null)
  ) not valid;

commit;

alter table tenant_routines validate constraint tenant_routines_tenant_authored_pinned_chk;
