
alter table tenants
  add column if not exists company_shape text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tenants_company_shape_check'
  ) then
    alter table tenants
      add constraint tenants_company_shape_check
      check (
        company_shape is null
        or company_shape in (
          'marketplace', 'saas', 'ecommerce', 'services', 'fintech', 'other'
        )
      );
  end if;
end $$;

comment on column tenants.company_shape is
  'Onboarding-declared company shape (Move E2). Nullable = unknown → fail-open in shape-based visibility. One of: marketplace|saas|ecommerce|services|fintech|other.';
