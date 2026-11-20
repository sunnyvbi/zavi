
begin;

create table if not exists public.growth_suggestions (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id) on delete cascade,
  title                  text not null check (char_length(title) between 1 and 240),
  body                   text not null check (char_length(body) between 1 and 5000),
  category               text not null check (category in ('creative', 'campaign', 'landing_page', 'budget', 'other')),
  priority               text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  status                 text not null default 'draft' check (status in ('draft', 'awaiting_client', 'approved', 'archived')),
  source                 text not null default 'manual' check (source in ('ai_ads', 'manual', 'paste')),
  source_payload         jsonb not null default '{}'::jsonb,
  owner_staff_id         uuid references public.staff_users(user_id) on delete set null,
  owner_staff_email      text,
  created_by_staff_id    uuid references public.staff_users(user_id) on delete set null,
  created_by_staff_email text,
  decision_id            uuid unique references public.decisions(id) on delete set null,
  duplicate_of           uuid references public.growth_suggestions(id) on delete set null,
  constraint growth_suggestions_not_self_duplicate check (duplicate_of is null or duplicate_of <> id),
  pushed_at              timestamptz,
  resolved_at            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table public.growth_suggestions is
  'Staff curation ledger for AI/manual growth recommendations. Drafts are private; pushed rows reuse decisions for customer approval.';

create index if not exists growth_suggestions_tenant_status_created_idx
  on public.growth_suggestions (tenant_id, status, created_at desc);
create index if not exists growth_suggestions_tenant_category_priority_idx
  on public.growth_suggestions (tenant_id, category, priority, created_at desc);
create index if not exists growth_suggestions_open_dedupe_idx
  on public.growth_suggestions (tenant_id, updated_at desc)
  where status in ('draft', 'awaiting_client');

alter table public.growth_suggestions enable row level security;
revoke all on table public.growth_suggestions from public, anon, authenticated;
grant all on table public.growth_suggestions to service_role;

create or replace function public.touch_growth_suggestion_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists growth_suggestions_touch_updated_at on public.growth_suggestions;
create trigger growth_suggestions_touch_updated_at
before update on public.growth_suggestions
for each row execute function public.touch_growth_suggestion_updated_at();

insert into public.decision_classes (
  slug,
  description,
  default_autonomy,
  dispatch_handler,
  never_auto,
  click_allowlistable
) values (
  'growth-lead.suggestion',
  'A staff-curated growth recommendation for the client. Approval records acceptance only; it performs no Meta Ads mutation.',
  'approval',
  null,
  true,
  false
)
on conflict (slug) do update set
  description = excluded.description,
  default_autonomy = excluded.default_autonomy,
  dispatch_handler = excluded.dispatch_handler,
  never_auto = excluded.never_auto,
  click_allowlistable = excluded.click_allowlistable;

create or replace function public.push_growth_suggestions(
  p_suggestion_ids uuid[],
  p_tenant_id uuid,
  p_staff_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_expected int;
  v_found int;
  v_not_draft int;
  v_row public.growth_suggestions%rowtype;
  v_decision_id uuid;
  v_decision_status text;
  v_decision_autonomy public.decision_autonomy;
  v_results jsonb := '[]'::jsonb;
begin
  v_expected := coalesce(cardinality(p_suggestion_ids), 0);
  if v_expected = 0 or v_expected > 20 then
    raise exception 'suggestion_ids must contain 1..20 ids' using errcode = '22023';
  end if;
  if (select count(distinct x) from unnest(p_suggestion_ids) as x) <> v_expected then
    raise exception 'suggestion_ids contains duplicates' using errcode = '22023';
  end if;

  perform 1
    from public.growth_suggestions
   where tenant_id = p_tenant_id and id = any(p_suggestion_ids)
   for update;

  select count(*), count(*) filter (where status <> 'draft')
    into v_found, v_not_draft
    from public.growth_suggestions
   where tenant_id = p_tenant_id and id = any(p_suggestion_ids);

  if v_found <> v_expected then
    raise exception 'one or more suggestions were not found for tenant' using errcode = 'P0002';
  end if;
  if v_not_draft > 0 then
    raise exception 'only draft suggestions can be pushed' using errcode = 'P0001';
  end if;

  for v_row in
    select *
      from public.growth_suggestions
     where tenant_id = p_tenant_id and id = any(p_suggestion_ids)
     order by created_at, id
  loop
    v_decision_id := public.emit_decision(
      p_tenant_id,
      null,
      'growth-lead.suggestion',
      jsonb_build_object(
        'suggestion_id', v_row.id,
        'title', v_row.title,
        'recommendation', v_row.body,
        'rationale', v_row.body,
        'rendered_markdown',
          '## ' || replace(replace(replace(v_row.title, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') ||
          E'\n\n' || replace(replace(replace(v_row.body, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
        'category', v_row.category,
        'priority', v_row.priority,
        'source', v_row.source,
        'source_payload', v_row.source_payload,
        'if_approved', 'The recommendation is accepted and recorded. No Meta Ads change runs automatically.',
        'if_rejected', 'The recommendation is archived. Nothing changes in Meta Ads.'
      )
    );

    select status, autonomy_at_emit
      into v_decision_status, v_decision_autonomy
      from public.decisions
     where id = v_decision_id
       and tenant_id = p_tenant_id
       and decision_class = 'growth-lead.suggestion';
    if v_decision_status is distinct from 'proposed'
       or v_decision_autonomy is distinct from 'approval'::public.decision_autonomy
    then
      raise exception 'suggestion decision did not enter the approval queue' using errcode = 'P0001';
    end if;

    update public.growth_suggestions
       set status = 'awaiting_client',
           decision_id = v_decision_id,
           owner_staff_id = coalesce(owner_staff_id, p_staff_id),
           pushed_at = now()
     where id = v_row.id;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'suggestion_id', v_row.id,
      'decision_id', v_decision_id,
      'status', 'awaiting_client'
    ));
  end loop;

  return v_results;
end;
$$;

revoke all on function public.push_growth_suggestions(uuid[], uuid, uuid) from public, anon, authenticated;
grant execute on function public.push_growth_suggestions(uuid[], uuid, uuid) to service_role;

create or replace function public.sync_growth_suggestion_from_decision()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status in ('approved', 'dispatching', 'acted', 'failed', 'dispatch_failed') then
    update public.growth_suggestions
       set status = 'approved', resolved_at = coalesce(resolved_at, now())
     where decision_id = new.id and status = 'awaiting_client';
  elsif new.status in ('rejected', 'superseded', 'expired') then
    update public.growth_suggestions
       set status = 'archived', resolved_at = coalesce(resolved_at, now())
     where decision_id = new.id and status = 'awaiting_client';
  end if;
  return new;
end;
$$;

drop trigger if exists decisions_sync_growth_suggestion on public.decisions;
create trigger decisions_sync_growth_suggestion
after update of status on public.decisions
for each row
when (old.status is distinct from new.status)
execute function public.sync_growth_suggestion_from_decision();

create table if not exists public.growth_suggestion_sessions (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id) on delete cascade,
  title                  text not null check (char_length(title) between 1 and 240),
  created_by_staff_id    uuid references public.staff_users(user_id) on delete set null,
  created_by_staff_email text,
  created_at             timestamptz not null default now(),
  last_message_at        timestamptz not null default now()
);

comment on table public.growth_suggestion_sessions is
  'One staff <-> Zavi suggestion conversation for one tenant. Staff-only; never exposed to customers.';

create table if not exists public.growth_suggestion_messages (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.growth_suggestion_sessions(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  role       text not null check (role in ('staff', 'zavi')),
  body       text not null check (char_length(body) between 1 and 32000),
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.growth_suggestion_messages is
  'Turns within a growth_suggestion_sessions row. meta carries small counters only (suggestion/duplicate counts) — never raw ad payloads.';

create index if not exists growth_suggestion_sessions_tenant_recent_idx
  on public.growth_suggestion_sessions (tenant_id, last_message_at desc);

create index if not exists growth_suggestion_messages_session_created_idx
  on public.growth_suggestion_messages (session_id, created_at);

alter table public.growth_suggestion_sessions enable row level security;
alter table public.growth_suggestion_messages enable row level security;
revoke all on table public.growth_suggestion_sessions from public, anon, authenticated;
revoke all on table public.growth_suggestion_messages from public, anon, authenticated;
grant all on table public.growth_suggestion_sessions to service_role;
grant all on table public.growth_suggestion_messages to service_role;

create or replace function public.touch_growth_suggestion_session()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.growth_suggestion_sessions
     set last_message_at = new.created_at
   where id = new.session_id;
  return new;
end;
$$;

drop trigger if exists growth_suggestion_messages_touch_session on public.growth_suggestion_messages;
create trigger growth_suggestion_messages_touch_session
after insert on public.growth_suggestion_messages
for each row execute function public.touch_growth_suggestion_session();

create or replace function public.assert_growth_suggestion_message_tenant()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant
    from public.growth_suggestion_sessions
   where id = new.session_id;
  if v_tenant is null then
    raise exception 'session not found' using errcode = 'P0002';
  end if;
  if v_tenant <> new.tenant_id then
    raise exception 'message tenant does not match session tenant' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists growth_suggestion_messages_assert_tenant on public.growth_suggestion_messages;
create trigger growth_suggestion_messages_assert_tenant
before insert on public.growth_suggestion_messages
for each row execute function public.assert_growth_suggestion_message_tenant();

commit;
