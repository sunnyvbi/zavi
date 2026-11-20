
begin;

alter table tenant_channels
  drop column if exists delivery_mode,
  drop column if exists credits_30d_cache;

commit;

do $$
begin
  raise notice '20260905223252: dropped tenant_channels.delivery_mode + .credits_30d_cache (never written on any row)';
end $$;
