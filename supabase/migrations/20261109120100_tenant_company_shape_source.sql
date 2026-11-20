
alter table tenants
  add column if not exists company_shape_source text
  check (company_shape_source is null or company_shape_source in ('founder', 'mapping', 'inferred'));

update tenants set company_shape_source = case when company_shape = 'marketplace' then 'inferred' else 'founder' end
  where company_shape is not null and company_shape_source is null;
