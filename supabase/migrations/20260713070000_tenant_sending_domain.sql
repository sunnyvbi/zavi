
begin;

create table if not exists tenant_sending_domain (
  tenant_id           uuid primary key references tenants(id) on delete cascade,

  domain              text not null,
  from_address        text,
  from_name           text,

  verification_status text not null default 'pending'
    check (verification_status in ('pending', 'verified', 'failed')),
  verification_error  text,
  dns_records         jsonb not null default '[]'::jsonb,

  provider_domain_id  text,

  verified_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists tenant_sending_domain_domain_uq
  on tenant_sending_domain (lower(domain));

alter table tenant_sending_domain enable row level security;

drop policy if exists tenant_sending_domain_select on tenant_sending_domain;
create policy tenant_sending_domain_select on tenant_sending_domain
  for select to authenticated using (
    tenant_id in (select tenant_id from tenant_users where user_id = auth.uid())
  );

comment on table tenant_sending_domain is
  'Per-tenant email sending domain. INERT until verification_status=''verified'' — the send path falls back to the shared domain until then, because mail from an unauthenticated domain fails SPF/DKIM and lands in spam, which is worse than the shared domain. Exists because reputation is per-domain: on the shared domain, one tenant''s spam complaints degrade deliverability for every tenant AND for Zavi''s own OTP/password-reset mail. See migration 20260713070000 + onboarding-readiness-fde-plan.md:110.';

commit;
