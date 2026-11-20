
begin;

insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable, severity)
values (
  'meta_ads.pause_past_cut_guard',
  'Approval route — a person pauses ONE Meta ad set that the cut guard would not let Zavi pause (still learning, too new to judge, or producing results). Status PAUSED only; any member may approve, as every pause. Body: pausePastGuardBodySchema (services/tools/meta-ads/write/_pause-past-guard.ts).',
  'approval',
  'meta_ads.pause_past_cut_guard',
  true,
  false,
  'medium'
)
on conflict (slug) do update
  set description         = excluded.description,
      default_autonomy    = excluded.default_autonomy,
      dispatch_handler    = excluded.dispatch_handler,
      never_auto          = excluded.never_auto,
      click_allowlistable = excluded.click_allowlistable,
      severity            = excluded.severity;

create table if not exists public.pause_past_guard_claims (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  object_id  text not null check (object_id ~ '^[0-9]{1,64}$'),
  day        date not null,
  token      uuid not null,
  card_id    text check (card_id is null or char_length(card_id) <= 64),
  created_at timestamptz not null default now(),
  primary key (tenant_id, object_id, day)
);

alter table public.pause_past_guard_claims enable row level security;
revoke all on public.pause_past_guard_claims from public, anon, authenticated;
grant select, insert, update, delete on public.pause_past_guard_claims to service_role;

commit;
