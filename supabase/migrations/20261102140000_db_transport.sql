begin;
alter table public.tenant_db_config
  add column if not exists transport text;
alter table public.tenant_db_config drop constraint if exists tenant_db_config_transport_check;
alter table public.tenant_db_config add constraint tenant_db_config_transport_check
  check (transport is null or transport in ('verified_tls', 'unverified_tls', 'plaintext'));
comment on column public.tenant_db_config.transport is
  'Direct mode: verified_tls / unverified_tls / plaintext, derived from the stored connection string when Zavi connects or scans. NULL until observed.';
commit;
