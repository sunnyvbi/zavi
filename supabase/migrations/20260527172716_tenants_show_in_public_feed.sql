
alter table tenants
  add column if not exists show_in_public_feed boolean not null default false;

update tenants
  set show_in_public_feed = true
  where slug in ('upcar-ai', 'upcar-private', 'apna-tutor-dogfood');

comment on column tenants.show_in_public_feed is
  'When true, sanitized agent_runs from this tenant appear in the public Live Feed on the marketing landing page. Default false (opt-in). Set per tenant by ops; no self-serve toggle.';
