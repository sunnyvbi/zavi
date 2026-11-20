
begin;

create table if not exists bench_members (
  id                 uuid primary key default gen_random_uuid(),

  auth_user_id       uuid not null unique references auth.users(id) on delete cascade,

  display_name       text not null check (length(btrim(display_name)) between 1 and 120),

  discipline         text not null
                       check (discipline in ('ugc_creator', 'engineer', 'designer', 'support')),

  skills             text[] not null default '{}',

  rate_usd           numeric(10, 2) check (rate_usd is null or rate_usd >= 0),
  rate_unit          text not null default 'per_deliverable'
                       check (rate_unit in ('per_deliverable', 'per_hour', 'per_month')),

  public_metrics     jsonb not null default '{}'::jsonb
                       check (jsonb_typeof(public_metrics) = 'object'),

  profile            jsonb not null default '{}'::jsonb
                       check (jsonb_typeof(profile) = 'object'),

  vetting_state      text not null default 'pending'
                       check (vetting_state in ('pending', 'under_review', 'approved', 'rejected')),
  rejected_reason    text check (rejected_reason is null or length(rejected_reason) <= 1000),

  handle_verified_at timestamptz,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table bench_members is
  'GLOBAL contractor identity (no tenant_id). RLS on with ZERO policies => default-deny for anon+authenticated; service_role only, via globalClient(). Discipline-agnostic; only ugc_creator is open in Phase 1. See migration 20260901010000.';

create table if not exists bench_member_handles (
  id               uuid primary key default gen_random_uuid(),
  bench_member_id  uuid not null references bench_members(id) on delete cascade,
  platform         text not null
                     check (platform in ('tiktok', 'instagram', 'youtube', 'github',
                                         'dribbble', 'linkedin', 'x', 'other')),
  handle           text not null check (length(btrim(handle)) between 1 and 200),
  created_at       timestamptz not null default now()
);

comment on table bench_member_handles is
  'Platform handles for a bench member. Unique on (platform, lower(handle)) so a second signup claiming a taken handle is a LOUD insert error, not a silent duplicate the staff console has to catch.';

create unique index if not exists bench_member_handles_platform_handle_key
  on bench_member_handles (platform, lower(handle));

create index if not exists bench_member_handles_member_idx
  on bench_member_handles (bench_member_id);

create table if not exists bench_member_pii (
  bench_member_id  uuid primary key references bench_members(id) on delete cascade,
  legal_name       text check (legal_name is null or length(btrim(legal_name)) between 1 and 200),
  email            text not null check (length(btrim(email)) between 3 and 320),

  tin_sha256       bytea,
  payout_ref_hash  bytea,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table bench_member_pii is
  'Bench member PII, split off bench_members so the S5 discovery projection physically cannot select it. HASHES ONLY for tin/payout ref — no raw TIN, no bank details, no payout columns (Phase 2). RLS default-deny, service_role only.';

create unique index if not exists bench_member_pii_email_key
  on bench_member_pii (lower(email));

create unique index if not exists bench_member_pii_tin_key
  on bench_member_pii (tin_sha256) where tin_sha256 is not null;

create unique index if not exists bench_member_pii_payout_ref_key
  on bench_member_pii (payout_ref_hash) where payout_ref_hash is not null;

alter table bench_members       enable row level security;
alter table bench_member_handles enable row level security;
alter table bench_member_pii     enable row level security;

create table if not exists brief_applications (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,

  brief_kind       text not null default 'creative' check (brief_kind in ('creative')),
  brief_id         uuid not null,

  bench_member_id  uuid not null references bench_members(id),

  status           text not null default 'applied'
                     check (status in ('applied', 'shortlisted', 'approved', 'rejected', 'withdrawn')),
  pitch            text check (pitch is null or length(btrim(pitch)) between 1 and 4000),
  quoted_rate_usd  numeric(10, 2) check (quoted_rate_usd is null or quoted_rate_usd >= 0),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (tenant_id, brief_kind, brief_id, bench_member_id)
);

comment on table brief_applications is
  'A bench member applying to one tenant brief. Keyed polymorphically on (brief_kind, brief_id) — brief_kind=''creative'' points at creator_briefs. Tenant-scoped RLS; writes are server-side only.';

create index if not exists brief_applications_tenant_status_idx
  on brief_applications (tenant_id, status, created_at desc);

create table if not exists engagements (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,

  brief_kind       text not null default 'creative' check (brief_kind in ('creative')),
  brief_id         uuid not null,

  bench_member_id  uuid not null references bench_members(id),
  application_id   uuid references brief_applications(id),

  agreed_rate_usd  numeric(10, 2) check (agreed_rate_usd is null or agreed_rate_usd >= 0),

  utm_campaign     text not null check (length(btrim(utm_campaign)) between 1 and 64),

  status           text not null default 'active'
                     check (status in ('active', 'delivered', 'accepted', 'revision_requested', 'cancelled')),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()

);

comment on table engagements is
  'An accepted bench engagement. utm_campaign is copied from the brief so the attribution tag is pinned to the engagement. NO payout/Stripe/tax columns — Phase 1 has no payout rail.';

create index if not exists engagements_tenant_status_idx
  on engagements (tenant_id, status, created_at desc);

create table if not exists engagement_messages (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  application_id  uuid not null references brief_applications(id) on delete cascade,

  sender_kind     text not null check (sender_kind in ('tenant', 'bench_member')),
  sender_user_id  uuid,

  body            text not null check (length(btrim(body)) between 1 and 4000),
  created_at      timestamptz not null default now()
);

comment on table engagement_messages is
  'Text-only thread on a brief application (carries into the engagement). Tenant-scoped so a tenant reads only its own threads; the bench member''s side is served server-side by member identity, never by this policy.';

create index if not exists engagement_messages_application_idx
  on engagement_messages (application_id, created_at);

alter table brief_applications  enable row level security;
alter table engagements         enable row level security;
alter table engagement_messages enable row level security;

drop policy if exists brief_applications_member_select on brief_applications;
create policy brief_applications_member_select on brief_applications
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.tenant_id = brief_applications.tenant_id
        and tu.user_id = auth.uid()
    )
  );

drop policy if exists engagements_member_select on engagements;
create policy engagements_member_select on engagements
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.tenant_id = engagements.tenant_id
        and tu.user_id = auth.uid()
    )
  );

drop policy if exists engagement_messages_member_select on engagement_messages;
create policy engagement_messages_member_select on engagement_messages
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.tenant_id = engagement_messages.tenant_id
        and tu.user_id = auth.uid()
    )
  );

revoke insert, update, delete on brief_applications  from anon, authenticated;
revoke insert, update, delete on engagements         from anon, authenticated;
revoke insert, update, delete on engagement_messages from anon, authenticated;

grant select on brief_applications  to authenticated;
grant select on engagements         to authenticated;
grant select on engagement_messages to authenticated;

commit;
