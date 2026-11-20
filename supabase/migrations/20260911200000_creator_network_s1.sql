
begin;

alter table human_members
  add column if not exists slug text
    check (slug is null or slug ~ '^[a-z0-9][a-z0-9_-]{1,38}[a-z0-9]$');
alter table human_members
  add column if not exists lanes text[]
    check (lanes is null or lanes <@ array['ugc_video', 'audience_post']::text[]);
alter table human_members
  add column if not exists city text
    check (city is null or length(btrim(city)) between 1 and 120);
alter table human_members
  add column if not exists country_code text
    check (country_code is null or country_code ~ '^[A-Z]{2}$');
alter table human_members
  add column if not exists missed_deadline_count integer default 0
    check (missed_deadline_count is null or missed_deadline_count >= 0);
alter table human_members
  add column if not exists intro_video_path text
    check (intro_video_path is null
           or (length(intro_video_path) between 3 and 400 and position('..' in intro_video_path) = 0));
alter table human_members
  add column if not exists sample_video_paths text[]
    check (sample_video_paths is null or cardinality(sample_video_paths) <= 3);

create unique index if not exists human_members_slug_key
  on human_members (slug);

alter table human_member_pii
  add column if not exists date_of_birth date
    check (date_of_birth is null or date_of_birth > date '1900-01-01');

alter table creator_briefs
  add column if not exists posted_at timestamptz;
alter table creator_briefs
  add column if not exists answer_by timestamptz;
alter table creator_briefs
  add column if not exists applicant_cap integer
    check (applicant_cap is null or applicant_cap between 1 and 500);
alter table creator_briefs
  add column if not exists lane text
    check (lane is null or lane in ('ugc_video', 'audience_post'));
alter table creator_briefs
  add column if not exists filters jsonb
    check (filters is null or jsonb_typeof(filters) = 'object');
alter table creator_briefs
  add column if not exists delivery_days integer
    check (delivery_days is null or delivery_days between 1 and 90);
alter table creator_briefs
  add column if not exists decline_note text
    check (decline_note is null or length(btrim(decline_note)) between 1 and 2000);
alter table creator_briefs
  add column if not exists closed_at timestamptz;

create table if not exists creator_packages (
  id                   uuid primary key default gen_random_uuid(),
  human_member_id      uuid not null references human_members(id) on delete cascade,
  kind                 text not null check (kind in ('ugc_video', 'audience_post')),
  title                text not null check (length(btrim(title)) between 1 and 120),
  description          text check (description is null or length(btrim(description)) between 1 and 2000),
  price_cents          integer not null check (price_cents > 0 and price_cents <= 10000000),
  currency             text not null default 'usd' check (currency = 'usd'),
  delivery_days        integer not null check (delivery_days between 1 and 90),

  video_count          integer check (video_count is null or video_count between 1 and 20),
  video_length_seconds integer check (video_length_seconds is null or video_length_seconds between 5 and 600),
  ad_rights_days       integer check (ad_rights_days is null or ad_rights_days in (30, 90, 365)),
  addons               jsonb not null default '[]'::jsonb check (jsonb_typeof(addons) = 'array'),

  platform             text check (platform is null or platform in ('tiktok', 'instagram', 'youtube', 'x', 'other')),
  post_type            text check (post_type is null or length(btrim(post_type)) between 1 and 60),
  stays_up_days        integer check (stays_up_days is null or stays_up_days between 1 and 3650),
  ad_label_required    boolean not null default true,

  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  check (
    (kind = 'ugc_video'
       and video_count is not null and video_length_seconds is not null and ad_rights_days is not null
       and platform is null and post_type is null and stays_up_days is null)
    or
    (kind = 'audience_post'
       and platform is not null and post_type is not null and stays_up_days is not null
       and video_count is null and video_length_seconds is null and ad_rights_days is null)
  )
);

comment on table creator_packages is
  'GLOBAL (creator-owned, no tenant_id). Zavi package templates with the creator''s price (spec Q10). RLS on, zero policies, service_role only; public read ONLY via get_creator_storefront().';

create table if not exists creator_payout_accounts (
  id                uuid primary key default gen_random_uuid(),
  human_member_id   uuid not null references human_members(id),
  stripe_account_id text not null unique check (stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  livemode          boolean not null,
  country           text not null check (country ~ '^[A-Z]{2}$'),
  details_submitted boolean not null default false,
  payouts_enabled   boolean not null default false,
  disabled_reason   text check (disabled_reason is null or length(disabled_reason) <= 200),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (human_member_id, livemode)
);

comment on table creator_payout_accounts is
  'GLOBAL. A creator''s Stripe Connect Express account per livemode. No bank/tax data (Stripe holds it). RLS on, zero policies, service_role only.';

alter table creator_packages        enable row level security;
alter table creator_payout_accounts enable row level security;
revoke all on creator_packages        from anon, authenticated;
revoke all on creator_payout_accounts from anon, authenticated;

create table if not exists creator_threads (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  human_member_id    uuid not null references human_members(id),
  started_by         text not null check (started_by in ('tenant', 'creator')),
  started_by_user_id uuid,
  last_message_at    timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, id)
);

create table if not exists creator_thread_messages (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  thread_id      uuid not null,
  sender_kind    text not null check (sender_kind in ('tenant', 'creator', 'staff', 'system')),
  sender_user_id uuid,
  body           text not null check (length(btrim(body)) between 1 and 4000),
  created_at     timestamptz not null default now(),
  foreign key (tenant_id, thread_id) references creator_threads (tenant_id, id) on delete cascade
);

create table if not exists creator_offers (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  human_member_id     uuid not null references human_members(id),
  thread_id           uuid,
  proposed_by         text not null check (proposed_by in ('tenant', 'creator')),
  proposed_by_user_id uuid,
  kind                text not null check (kind in ('ugc_video', 'audience_post')),
  terms               jsonb not null check (jsonb_typeof(terms) = 'object'),
  price_cents         integer not null check (price_cents > 0 and price_cents <= 10000000),
  currency            text not null default 'usd' check (currency = 'usd'),
  delivery_days       integer not null check (delivery_days between 1 and 90),
  note                text check (note is null or length(btrim(note)) between 1 and 2000),
  status              text not null default 'open'
                        check (status in ('open', 'accepted', 'declined', 'expired', 'withdrawn')),
  expires_at          timestamptz not null,
  responded_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, thread_id) references creator_threads (tenant_id, id)
);

create table if not exists creator_orders (
  id                         uuid primary key default gen_random_uuid(),
  tenant_id                  uuid not null references tenants(id) on delete cascade,
  human_member_id            uuid not null references human_members(id),
  source                     text not null check (source in ('booking', 'offer', 'applicant')),

  package_id                 uuid references creator_packages(id) on delete set null,
  offer_id                   uuid,
  application_id             uuid references brief_applications(id),
  brief_id                   uuid references creator_briefs(id),
  thread_id                  uuid,
  booked_by_user_id          uuid references auth.users(id) on delete set null,

  package_snapshot           jsonb not null check (jsonb_typeof(package_snapshot) = 'object'),
  brief_snapshot             jsonb check (brief_snapshot is null or jsonb_typeof(brief_snapshot) = 'object'),

  currency                   text not null default 'usd' check (currency = 'usd'),
  price_cents                integer not null check (price_cents > 0 and price_cents <= 10000000),
  business_fee_cents         integer not null check (business_fee_cents >= 0),
  creator_fee_cents          integer not null check (creator_fee_cents >= 0 and creator_fee_cents <= price_cents),
  business_total_cents       integer generated always as (price_cents + business_fee_cents) stored,
  creator_payout_cents       integer generated always as (price_cents - creator_fee_cents) stored,
  payout_amount_cents        integer check (payout_amount_cents is null
                                            or (payout_amount_cents > 0
                                                and payout_amount_cents <= price_cents - creator_fee_cents)),

  status                     text not null default 'checkout_pending'
                               check (status in ('checkout_pending', 'awaiting_acceptance', 'in_progress',
                                                 'submitted', 'revision_requested', 'cancel_requested',
                                                 'in_dispute', 'completed', 'cancelled')),
  closed_reason              text check (closed_reason is null or closed_reason in (
                               'approved', 'auto_accepted', 'mediation_pay_full', 'mediation_pay_part',
                               'checkout_abandoned', 'declined', 'expired', 'withdrawn', 'payment_failed',
                               'no_show', 'cancel_agreed', 'cancel_no_response', 'mediation_refund',
                               'creator_removed')),

  due_at                     timestamptz,
  extension_requested_due_at timestamptz,
  extension_state            text check (extension_state is null or extension_state in ('requested', 'approved', 'declined')),
  next_deadline_at           timestamptz,
  next_deadline_kind         text check (next_deadline_kind is null or next_deadline_kind in (
                               'accept', 'review', 'due', 'no_show_grace', 'cancel_response', 'offer_expiry')),
  lease_until                timestamptz,

  responded_at               timestamptz,
  accepted_at                timestamptz,
  cancel_requested_at        timestamptz,
  closed_at                  timestamptz,

  payout_status              text not null default 'not_due'
                               check (payout_status in ('not_due', 'awaiting_payout_account', 'ready',
                                                        'transferring', 'transferred', 'reversed', 'not_applicable')),
  payout_ready_at            timestamptz,

  livemode                   boolean not null,
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id   text unique,
  hold_expires_at            timestamptz,
  stripe_transfer_id         text unique,

  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),

  unique (tenant_id, id),
  foreign key (tenant_id, offer_id)  references creator_offers  (tenant_id, id),
  foreign key (tenant_id, thread_id) references creator_threads (tenant_id, id),

  check (source <> 'offer' or offer_id is not null),
  check (source <> 'applicant' or (application_id is not null and brief_id is not null)),
  check ((status in ('completed', 'cancelled')) = (closed_reason is not null and closed_at is not null)),
  check (status <> 'completed' or closed_reason in ('approved', 'auto_accepted', 'mediation_pay_full', 'mediation_pay_part')),
  check (status <> 'cancelled' or closed_reason not in ('approved', 'auto_accepted', 'mediation_pay_full', 'mediation_pay_part')),
  check (payout_status <> 'ready' or payout_ready_at is not null),
  check (payout_status <> 'transferred' or stripe_transfer_id is not null),
  check ((next_deadline_at is null) = (next_deadline_kind is null))
);

comment on table creator_orders is
  'One creator job (booking | custom offer | hired applicant). Integer cents; fee split frozen per order; generated business_total_cents / creator_payout_cents. Tenant-member SELECT only; all writes server-side.';

create unique index if not exists creator_orders_offer_id_key
  on creator_orders (offer_id) where offer_id is not null;
create unique index if not exists creator_orders_application_id_key
  on creator_orders (application_id) where application_id is not null;

create table if not exists creator_submissions (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  order_id     uuid not null,
  version      integer not null check (version >= 1),
  position     integer not null default 0 check (position between 0 and 49),
  kind         text not null check (kind in ('video', 'image', 'raw_footage', 'other')),
  storage_path text not null,
  mime_type    text check (mime_type is null or length(mime_type) <= 100),
  bytes        bigint check (bytes is null or bytes >= 0),
  note         text check (note is null or length(btrim(note)) between 1 and 2000),
  created_at   timestamptz not null default now(),
  unique (tenant_id, id),
  unique (order_id, version, position),
  foreign key (tenant_id, order_id) references creator_orders (tenant_id, id) on delete cascade,
  check (storage_path like tenant_id::text || '/' || order_id::text || '/%'),
  check (position('..' in storage_path) = 0)
);

create table if not exists creator_disputes (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  order_id             uuid not null,
  kind                 text not null check (kind in ('step_in', 'cancel_dispute')),
  opened_by            text not null check (opened_by in ('tenant', 'creator')),
  opened_by_user_id    uuid,
  reason               text not null check (length(btrim(reason)) between 1 and 4000),
  status               text not null default 'open' check (status in ('open', 'resolved')),
  outcome              text check (outcome is null or outcome in ('pay_full', 'pay_part', 'refund')),
  creator_amount_cents integer check (creator_amount_cents is null or creator_amount_cents > 0),
  refund_amount_cents  integer check (refund_amount_cents is null or refund_amount_cents > 0),
  resolution_note      text check (resolution_note is null or length(btrim(resolution_note)) between 1 and 4000),
  resolved_by_staff_id uuid,
  resolved_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  foreign key (tenant_id, order_id) references creator_orders (tenant_id, id) on delete cascade,
  check ((status = 'resolved') = (outcome is not null and resolved_at is not null)),
  check (outcome is distinct from 'pay_part' or creator_amount_cents is not null)
);

create unique index if not exists creator_disputes_one_open_per_order
  on creator_disputes (order_id) where status = 'open';

create table if not exists creator_money_events (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  order_id         uuid not null,
  kind             text not null
                     check (kind in ('hold', 'capture', 'cancel', 'refund', 'transfer', 'transfer_reversal', 'fee')),
  cause            text not null check (cause in (
                     'booking', 'hire', 'creator_accept', 'approval', 'auto_accept_buffer',
                     'decline', 'expiry', 'withdrawn', 'checkout_abandoned', 'payment_failed',
                     'no_show', 'cancel_agreed', 'cancel_no_response', 'mediation', 'creator_removed')),
  amount_cents     bigint not null check (amount_cents >= 0),
  currency         text not null default 'usd' check (currency = 'usd'),
  livemode         boolean not null,
  stripe_object_id text check (stripe_object_id is null or length(stripe_object_id) between 3 and 255),
  stripe_event_id  text check (stripe_event_id is null or length(stripe_event_id) between 3 and 255),
  idempotency_key  text not null unique check (length(idempotency_key) between 8 and 255),
  actor_kind       text not null check (actor_kind in ('tenant', 'creator', 'staff', 'system')),
  actor_user_id    uuid,
  created_at       timestamptz not null default now(),
  foreign key (tenant_id, order_id) references creator_orders (tenant_id, id) on delete cascade
);

comment on table creator_money_events is
  'Append-only creator money ledger. UPDATE always refused; DELETE refused for livemode rows (creator_money_events_guard). Unique idempotency_key. Tenant-member SELECT only.';

create or replace function creator_money_events_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'creator_money_events is append-only (update refused)' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' and old.livemode then
    raise exception 'creator_money_events: live ledger rows cannot be deleted' using errcode = '42501';
  end if;
  return old;
end $$;

create or replace trigger creator_money_events_append_only
  before update or delete on creator_money_events
  for each row execute function creator_money_events_guard();

create table if not exists creator_reviews (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  order_id         uuid not null unique,
  human_member_id  uuid not null references human_members(id),
  communication    smallint not null check (communication between 1 and 5),
  timeliness       smallint not null check (timeliness between 1 and 5),
  satisfaction     smallint not null check (satisfaction between 1 and 5),
  body             text check (body is null or length(btrim(body)) between 1 and 2000),
  reviewer_user_id uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (tenant_id, order_id) references creator_orders (tenant_id, id) on delete cascade
);

create table if not exists creator_library_assets (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  order_id           uuid not null,
  submission_id      uuid not null,
  human_member_id    uuid not null references human_members(id),
  rights_start_at    timestamptz not null,
  rights_end_at      timestamptz not null,
  utm_campaign       text not null
                       default ('zavi-cr-' || substring(replace(gen_random_uuid()::text, '-', ''), 1, 12))
                       unique check (length(utm_campaign) between 1 and 64),
  meta_ad_account_id text check (meta_ad_account_id is null or length(meta_ad_account_id) <= 64),
  meta_video_id      text check (meta_video_id is null or length(meta_video_id) <= 64),
  meta_ad_id         text check (meta_ad_id is null or length(meta_ad_id) <= 64),
  meta_auto_paused_at timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (submission_id),
  foreign key (tenant_id, order_id)      references creator_orders      (tenant_id, id) on delete cascade,
  foreign key (tenant_id, submission_id) references creator_submissions (tenant_id, id) on delete cascade,
  check (rights_end_at > rights_start_at)
);

create table if not exists creator_notifications (
  id              uuid primary key default gen_random_uuid(),
  recipient_kind  text not null check (recipient_kind in ('tenant', 'creator')),
  tenant_id       uuid references tenants(id) on delete cascade,
  human_member_id uuid references human_members(id) on delete cascade,
  order_id        uuid references creator_orders(id) on delete cascade,
  kind            text not null check (length(btrim(kind)) between 1 and 64),
  title           text not null check (length(btrim(title)) between 1 and 200),
  body            text check (body is null or length(btrim(body)) between 1 and 2000),
  link_path       text check (link_path is null or (link_path like '/%' and length(link_path) <= 500)),
  dedupe_key      text unique check (dedupe_key is null or length(dedupe_key) between 8 and 255),
  emailed_at      timestamptz,
  read_at         timestamptz,
  created_at      timestamptz not null default now(),
  foreign key (tenant_id, order_id) references creator_orders (tenant_id, id) on delete cascade,
  check (
    (recipient_kind = 'tenant'  and tenant_id is not null and human_member_id is null)
    or
    (recipient_kind = 'creator' and human_member_id is not null and tenant_id is null)
  )
);

alter table creator_threads         enable row level security;
alter table creator_thread_messages enable row level security;
alter table creator_offers          enable row level security;
alter table creator_orders          enable row level security;
alter table creator_submissions     enable row level security;
alter table creator_disputes        enable row level security;
alter table creator_money_events    enable row level security;
alter table creator_reviews         enable row level security;
alter table creator_library_assets  enable row level security;
alter table creator_notifications   enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'creator_threads', 'creator_thread_messages', 'creator_offers', 'creator_orders',
    'creator_submissions', 'creator_disputes', 'creator_money_events', 'creator_reviews',
    'creator_library_assets'
  ] loop
    if not exists (select 1 from pg_policies
                   where schemaname = 'public' and tablename = t and policyname = t || '_member_select') then
      execute format(
        'create policy %I on %I for select to authenticated using (
           exists (select 1 from tenant_users tu
                   where tu.tenant_id = %I.tenant_id and tu.user_id = auth.uid()))',
        t || '_member_select', t, t);
    end if;
  end loop;

  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'creator_notifications'
                   and policyname = 'creator_notifications_member_select') then
    create policy creator_notifications_member_select on creator_notifications
      for select to authenticated using (
        recipient_kind = 'tenant'
        and exists (select 1 from tenant_users tu
                    where tu.tenant_id = creator_notifications.tenant_id and tu.user_id = auth.uid())
      );
  end if;
end $$;

revoke all on creator_threads         from anon, authenticated;
revoke all on creator_thread_messages from anon, authenticated;
revoke all on creator_offers          from anon, authenticated;
revoke all on creator_orders          from anon, authenticated;
revoke all on creator_submissions     from anon, authenticated;
revoke all on creator_disputes        from anon, authenticated;
revoke all on creator_money_events    from anon, authenticated;
revoke all on creator_reviews         from anon, authenticated;
revoke all on creator_library_assets  from anon, authenticated;
revoke all on creator_notifications   from anon, authenticated;

grant select on creator_threads         to authenticated;
grant select on creator_thread_messages to authenticated;
grant select on creator_offers          to authenticated;
grant select on creator_orders          to authenticated;
grant select on creator_submissions     to authenticated;
grant select on creator_disputes        to authenticated;
grant select on creator_money_events    to authenticated;
grant select on creator_reviews         to authenticated;
grant select on creator_library_assets  to authenticated;
grant select on creator_notifications   to authenticated;

create or replace function creator_payout_country_supported(p_country_code text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(upper(p_country_code) = any (array[
    'US', 'CA', 'GB', 'CH',
    'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
    'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
    'IS', 'LI', 'NO'
  ]), false)
$$;

grant execute on function creator_payout_country_supported(text) to anon, authenticated, service_role;

create or replace function search_creators(
  p_tenant_id         uuid,
  p_order             text    default 'newest',
  p_lane              text    default null,
  p_platform          text    default null,
  p_niches            text[]  default null,
  p_max_price_cents   integer default null,
  p_max_delivery_days integer default null,
  p_country_code      text    default null,
  p_city              text    default null,
  p_limit             integer default 50,
  p_offset            integer default 0
)
returns table (
  human_member_id       uuid,
  slug                  text,
  display_name          text,
  lanes                 text[],
  niches                text[],
  platforms             text[],
  city                  text,
  country_code          text,
  bookable              boolean,
  intro_video_path      text,
  self_reported_metrics jsonb,
  from_price_cents      integer,
  joined_at             timestamptz,
  order_applied         text
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if p_tenant_id is null then
    raise exception 'search_creators: tenant_id required' using errcode = '22023';
  end if;
  if p_order is null or p_order not in ('newest', 'a_to_z') then
    raise exception 'search_creators: order must be newest or a_to_z' using errcode = '22023';
  end if;
  if auth.uid() is not null then
    if not exists (select 1 from tenant_users tu
                   where tu.user_id = auth.uid() and tu.tenant_id = p_tenant_id) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  return query
  select
    m.id,
    m.slug,
    m.display_name,
    coalesce(m.lanes, '{}'::text[]),
    coalesce(m.skills, '{}'::text[]),
    coalesce((select array_agg(distinct h.platform order by h.platform)
                from human_member_handles h where h.human_member_id = m.id), '{}'::text[]),
    m.city,
    m.country_code,
    creator_payout_country_supported(m.country_code),
    m.intro_video_path,
    coalesce(m.public_metrics, '{}'::jsonb),
    (select min(p.price_cents)::integer from creator_packages p
      where p.human_member_id = m.id and p.active
        and (p_lane is null or p.kind = p_lane)),
    m.created_at,
    p_order
  from human_members m
  where m.vetting_state = 'approved'
    and m.slug is not null
    and (p_lane is null or p_lane = any (coalesce(m.lanes, '{}'::text[])))
    and (p_platform is null or exists (select 1 from human_member_handles h
                                       where h.human_member_id = m.id and h.platform = p_platform))
    and (p_niches is null or cardinality(p_niches) = 0 or m.skills && p_niches)
    and (p_max_price_cents is null or exists (
          select 1 from creator_packages p
           where p.human_member_id = m.id and p.active and p.price_cents <= p_max_price_cents
             and (p_lane is null or p.kind = p_lane)))
    and (p_max_delivery_days is null or exists (
          select 1 from creator_packages p
           where p.human_member_id = m.id and p.active and p.delivery_days <= p_max_delivery_days
             and (p_lane is null or p.kind = p_lane)))
    and (p_country_code is null or m.country_code = upper(p_country_code))
    and (p_city is null or lower(m.city) = lower(btrim(p_city)))
  order by
    case when p_order = 'newest' then m.created_at end desc,
    case when p_order = 'a_to_z' then lower(m.display_name) end asc,
    m.id asc
  limit least(greatest(coalesce(p_limit, 50), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
end $$;

comment on function search_creators(uuid, text, text, text, text[], integer, integer, text, text, integer, integer) is
  'Find creators (spec Q12). NEUTRAL order only: newest or a_to_z, echoed as order_applied. Never ordered by price, fit, rating or audience. Public fields only; approved creators with a storefront. service_role only.';

revoke execute on function search_creators(uuid, text, text, text, text[], integer, integer, text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function search_creators(uuid, text, text, text, text[], integer, integer, text, text, integer, integer)
  to service_role;

create or replace function get_creator_storefront(p_slug text)
returns table (
  slug                     text,
  display_name             text,
  bio                      text,
  lanes                    text[],
  niches                   text[],
  platforms                text[],
  city                     text,
  country_code             text,
  bookable                 boolean,
  not_bookable_reason      text,
  intro_video_path         text,
  sample_video_paths       text[],
  self_reported_metrics    jsonb,
  packages                 jsonb,
  reviews                  jsonb,
  review_count             integer,
  avg_communication        numeric,
  avg_timeliness           numeric,
  avg_satisfaction         numeric,
  completed_job_count      integer,
  joined_at                timestamptz
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select
    m.slug,
    m.display_name,
    m.bio,
    coalesce(m.lanes, '{}'::text[]),
    coalesce(m.skills, '{}'::text[]),
    coalesce((select array_agg(distinct h.platform order by h.platform)
                from human_member_handles h where h.human_member_id = m.id), '{}'::text[]),
    m.city,
    m.country_code,
    creator_payout_country_supported(m.country_code),
    case when creator_payout_country_supported(m.country_code) then null
         else 'payout_country_unsupported' end,
    m.intro_video_path,
    coalesce(m.sample_video_paths, '{}'::text[]),
    coalesce(m.public_metrics, '{}'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'kind', p.kind, 'title', p.title, 'description', p.description,
               'price_cents', p.price_cents, 'currency', p.currency, 'delivery_days', p.delivery_days,
               'video_count', p.video_count, 'video_length_seconds', p.video_length_seconds,
               'ad_rights_days', p.ad_rights_days, 'addons', p.addons,
               'platform', p.platform, 'post_type', p.post_type, 'stays_up_days', p.stays_up_days,
               'ad_label_required', p.ad_label_required)
             order by p.created_at, p.id)
        from creator_packages p
       where p.human_member_id = m.id and p.active), '[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'business_name', t.display_name, 'communication', r.communication,
               'timeliness', r.timeliness, 'satisfaction', r.satisfaction,
               'body', r.body, 'created_at', r.created_at)
             order by r.created_at desc, r.id)
        from (select * from creator_reviews r0 where r0.human_member_id = m.id
               order by r0.created_at desc, r0.id limit 50) r
        join tenants t on t.id = r.tenant_id), '[]'::jsonb),
    (select count(*)::integer from creator_reviews r where r.human_member_id = m.id),
    (select round(avg(r.communication), 2) from creator_reviews r where r.human_member_id = m.id),
    (select round(avg(r.timeliness), 2)    from creator_reviews r where r.human_member_id = m.id),
    (select round(avg(r.satisfaction), 2)  from creator_reviews r where r.human_member_id = m.id),
    (select count(*)::integer from creator_orders o
      where o.human_member_id = m.id and o.status = 'completed'),
    m.created_at
  from human_members m
  where m.slug = lower(btrim(p_slug))
    and m.vetting_state = 'approved'
$$;

comment on function get_creator_storefront(text) is
  'Public storefront (spec Q13). Explicit field allowlist; never reads human_member_pii; no handles, no internal ids; city + country only. Approved creators only. Granted to anon (public page).';

revoke execute on function get_creator_storefront(text) from public;
grant  execute on function get_creator_storefront(text) to anon, authenticated, service_role;

create or replace function creator_claim_due_order_deadlines(p_limit integer default 50)
returns setof creator_orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update creator_orders o
     set lease_until = now() + interval '2 minutes'
   where o.id in (
     select id from creator_orders
      where next_deadline_at is not null
        and next_deadline_at <= now()
        and status not in ('completed', 'cancelled')
        and (lease_until is null or lease_until < now())
      order by next_deadline_at
      limit least(greatest(coalesce(p_limit, 50), 1), 500)
      for update skip locked
   )
  returning o.*;
end $$;

create or replace function creator_claim_order_deadline(p_order_id uuid)
returns setof creator_orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update creator_orders o
     set lease_until = now() + interval '2 minutes'
   where o.id = (
     select id from creator_orders
      where id = p_order_id
        and next_deadline_at is not null
        and next_deadline_at <= now()
        and status not in ('completed', 'cancelled')
        and (lease_until is null or lease_until < now())
      for update skip locked
   )
  returning o.*;
end $$;

create or replace function creator_release_order_deadline_lease(p_order_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update creator_orders set lease_until = null where id = p_order_id and lease_until is not null;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create or replace function creator_claim_order_transfer(p_order_id uuid)
returns creator_orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row creator_orders;
begin
  update creator_orders o
     set payout_status = 'transferring', updated_at = now()
   where o.id = p_order_id
     and o.status = 'completed'
     and o.payout_status = 'ready'
     and o.payout_ready_at <= now()
     and not exists (select 1 from creator_disputes d where d.order_id = o.id and d.status = 'open')
  returning o.* into v_row;
  return v_row;
end $$;

create or replace function creator_mark_order_transferred(
  p_order_id        uuid,
  p_transfer_id     text,
  p_idempotency_key text,
  p_cause           text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row creator_orders;
begin
  if p_transfer_id is null or p_transfer_id !~ '^tr_[A-Za-z0-9]+$' then
    raise exception 'creator_mark_order_transferred: transfer id required' using errcode = '22023';
  end if;
  if p_cause not in ('approval', 'auto_accept_buffer', 'mediation') then
    raise exception 'creator_mark_order_transferred: cause must be approval, auto_accept_buffer or mediation'
      using errcode = '22023';
  end if;

  update creator_orders
     set payout_status = 'transferred', stripe_transfer_id = p_transfer_id, updated_at = now()
   where id = p_order_id and payout_status = 'transferring'
  returning * into v_row;

  if v_row.id is null then
    return 0;
  end if;

  insert into creator_money_events (
    tenant_id, order_id, kind, cause, amount_cents, currency, livemode,
    stripe_object_id, idempotency_key, actor_kind
  ) values (
    v_row.tenant_id, v_row.id, 'transfer', p_cause,
    coalesce(v_row.payout_amount_cents, v_row.creator_payout_cents), v_row.currency, v_row.livemode,
    p_transfer_id, p_idempotency_key, 'system'
  )
  on conflict (idempotency_key) do nothing;

  return 1;
end $$;

create or replace function creator_release_order_transfer_claim(p_order_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update creator_orders
     set payout_status = 'ready', updated_at = now()
   where id = p_order_id and payout_status = 'transferring';
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke execute on function creator_claim_due_order_deadlines(integer)              from public, anon, authenticated;
revoke execute on function creator_claim_order_deadline(uuid)                      from public, anon, authenticated;
revoke execute on function creator_release_order_deadline_lease(uuid)              from public, anon, authenticated;
revoke execute on function creator_claim_order_transfer(uuid)                      from public, anon, authenticated;
revoke execute on function creator_mark_order_transferred(uuid, text, text, text)  from public, anon, authenticated;
revoke execute on function creator_release_order_transfer_claim(uuid)              from public, anon, authenticated;
revoke execute on function creator_money_events_guard()                            from public, anon, authenticated;

grant execute on function creator_claim_due_order_deadlines(integer)             to service_role;
grant execute on function creator_claim_order_deadline(uuid)                     to service_role;
grant execute on function creator_release_order_deadline_lease(uuid)             to service_role;
grant execute on function creator_claim_order_transfer(uuid)                     to service_role;
grant execute on function creator_mark_order_transferred(uuid, text, text, text) to service_role;
grant execute on function creator_release_order_transfer_claim(uuid)             to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('creator-media', 'creator-media', true, 104857600,
        array['video/mp4', 'video/quicktime', 'video/webm', 'image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('creator-deliverables', 'creator-deliverables', false, 524288000,
        array['video/mp4', 'video/quicktime', 'video/webm', 'image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'creator_buckets_deny_client_roles') then
    create policy creator_buckets_deny_client_roles on storage.objects
      as restrictive
      for all
      to anon, authenticated
      using (bucket_id not in ('creator-media', 'creator-deliverables'))
      with check (bucket_id not in ('creator-media', 'creator-deliverables'));
  end if;
end $$;

commit;
