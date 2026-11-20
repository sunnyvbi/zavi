
alter table tenants
  add column if not exists reporting_timezone text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tenants_reporting_timezone_format'
  ) then
    alter table tenants
      add constraint tenants_reporting_timezone_format
      check (
        reporting_timezone is null
        or (
          length(reporting_timezone) <= 64
          and reporting_timezone ~ '^(UTC|[A-Za-z]+(/[A-Za-z0-9_+-]+){1,2})$'
        )
      );
  end if;
end $$;

comment on column tenants.reporting_timezone is
  'IANA zone for metric windows and receipts (get_metric). Null = not decided; auto-detected from GA4 / Meta / booking config, or set by the founder.';
