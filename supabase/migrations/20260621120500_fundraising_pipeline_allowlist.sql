
begin;

update system_config
set blob = jsonb_set(
      blob,
      '{fundraising_pipeline_tenants}',
      '["73db45ff-457e-4541-bc8f-bdb625390204"]'::jsonb,
      true
    )
where id = 1 and not (blob ? 'fundraising_pipeline_tenants');

commit;
