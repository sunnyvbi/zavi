
begin;

do $$
begin
  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.decisions'::regclass and c.contype in ('u', 'p')
       and (select array_agg(a.attname::text order by a.attname) from pg_attribute a
             where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) = array['id', 'tenant_id']
  ) then
    alter table public.decisions add constraint decisions_tenant_id_id_key unique (tenant_id, id);
  end if;
end $$;

alter table public.email_suppression drop constraint if exists email_suppression_reason_check;
alter table public.email_suppression add constraint email_suppression_reason_check
  check (reason in ('unsubscribe', 'bounce', 'complaint', 'manual', 'erased'));

create table if not exists public.email_contacts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  email_norm   text,
  display_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  erased_at    timestamptz,
  constraint email_contacts_tenant_id_id_key unique (tenant_id, id),
  constraint email_contacts_tenant_email_key unique (tenant_id, email_norm),
  constraint email_contacts_erased_ck check (
    (erased_at is null and email_norm is not null) or (erased_at is not null and email_norm is null)
  )
);

create table if not exists public.email_lists (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  name              text not null check (length(trim(name)) between 1 and 120 and name !~ '[[:cntrl:]]'),
  active_version_id uuid,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  archived_at       timestamptz,
  constraint email_lists_tenant_id_id_key unique (tenant_id, id)
);
create unique index if not exists email_lists_tenant_name_uq
  on public.email_lists (tenant_id, lower(trim(name))) where archived_at is null;

create table if not exists public.email_list_versions (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  list_id              uuid not null,
  source_kind          text not null check (source_kind in ('csv', 'database')),
  source_ref           jsonb not null default '{}'::jsonb,
  contact_count        int not null default 0 check (contact_count >= 0),
  consent_text         text,
  consent_confirmed_by uuid,
  consent_confirmed_at timestamptz,
  created_by           uuid,
  created_at           timestamptz not null default now(),
  constraint email_list_versions_tenant_id_id_key unique (tenant_id, id),
  constraint email_list_versions_tenant_list_id_key unique (tenant_id, list_id, id),
  constraint email_list_versions_list_fk foreign key (tenant_id, list_id)
    references public.email_lists (tenant_id, id) on delete cascade,
  constraint email_list_versions_consent_ck check (
    (consent_text is null and consent_confirmed_by is null and consent_confirmed_at is null)
    or (consent_text is not null and consent_confirmed_by is not null and consent_confirmed_at is not null)
  )
);
create index if not exists email_list_versions_tenant_list_idx
  on public.email_list_versions (tenant_id, list_id, created_at desc);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'email_lists_active_version_fk') then
    alter table public.email_lists add constraint email_lists_active_version_fk
      foreign key (tenant_id, id, active_version_id)
      references public.email_list_versions (tenant_id, list_id, id);
  end if;
end $$;

create or replace function public.email_list_versions_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp as $$
begin
  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.list_id is distinct from old.list_id
     or new.source_kind is distinct from old.source_kind
     or new.source_ref is distinct from old.source_ref
     or new.contact_count is distinct from old.contact_count
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'email_list_versions: a version cannot be changed' using errcode = '23514';
  end if;
  if old.consent_confirmed_at is not null and (
       new.consent_text is distinct from old.consent_text
       or new.consent_confirmed_by is distinct from old.consent_confirmed_by
       or new.consent_confirmed_at is distinct from old.consent_confirmed_at) then
    raise exception 'email_list_versions: consent is recorded once' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function public.email_list_versions_immutable() from public, anon, authenticated;

drop trigger if exists email_list_versions_immutable_trg on public.email_list_versions;
create trigger email_list_versions_immutable_trg
  before update on public.email_list_versions
  for each row execute function public.email_list_versions_immutable();

create table if not exists public.email_list_version_contacts (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  version_id uuid not null,
  contact_id uuid not null,
  added_at   timestamptz not null default now(),
  primary key (version_id, contact_id),
  constraint email_list_version_contacts_version_fk foreign key (tenant_id, version_id)
    references public.email_list_versions (tenant_id, id) on delete cascade,
  constraint email_list_version_contacts_contact_fk foreign key (tenant_id, contact_id)
    references public.email_contacts (tenant_id, id) on delete cascade
);
create index if not exists email_list_version_contacts_tenant_contact_idx
  on public.email_list_version_contacts (tenant_id, contact_id);

create table if not exists public.email_bulk_sends (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  decision_id     uuid not null,
  list_id         uuid not null,
  list_version_id uuid not null,
  subject         text not null,
  body_text       text not null,
  from_address    text not null,
  reply_to        text,
  total           int not null default 0,
  sent            int not null default 0,
  skipped         int not null default 0,
  failed          int not null default 0,
  unknown         int not null default 0,
  complaints      int not null default 0,
  hard_bounces    int not null default 0,
  status          text not null default 'sending'
                  check (status in ('sending', 'waiting_for_tomorrow', 'held', 'done', 'failed')),
  hold_reason     text,
  next_run_at     timestamptz,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz,
  constraint email_bulk_sends_decision_key unique (decision_id),
  constraint email_bulk_sends_tenant_id_id_key unique (tenant_id, id),
  constraint email_bulk_sends_decision_fk foreign key (tenant_id, decision_id)
    references public.decisions (tenant_id, id) on delete cascade,
  constraint email_bulk_sends_version_fk foreign key (tenant_id, list_id, list_version_id)
    references public.email_list_versions (tenant_id, list_id, id)
);
create index if not exists email_bulk_sends_tenant_created_idx
  on public.email_bulk_sends (tenant_id, created_at desc);

create table if not exists public.email_bulk_send_recipients (
  send_id       uuid not null,
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  contact_id    uuid not null,
  email_at_send text,
  status        text not null default 'pending'
                check (status in ('pending', 'sending', 'sent', 'skipped', 'failed', 'unknown')),
  skip_reason   text,
  feedback      text check (feedback is null or feedback in ('complaint', 'hard_bounce')),
  stamped_at    timestamptz,
  primary key (send_id, contact_id),
  constraint email_bulk_send_recipients_send_fk foreign key (tenant_id, send_id)
    references public.email_bulk_sends (tenant_id, id) on delete cascade,
  constraint email_bulk_send_recipients_contact_fk foreign key (tenant_id, contact_id)
    references public.email_contacts (tenant_id, id) on delete cascade
);
create index if not exists email_bulk_send_recipients_tenant_send_status_idx
  on public.email_bulk_send_recipients (tenant_id, send_id, status);
create index if not exists email_bulk_send_recipients_tenant_contact_idx
  on public.email_bulk_send_recipients (tenant_id, contact_id);

create table if not exists public.email_bulk_abuse_holds (
  tenant_id  uuid primary key references public.tenants(id) on delete cascade,
  send_id    uuid,
  reason     text not null check (reason in ('abuse_complaints', 'abuse_bounces')),
  created_at timestamptz not null default now(),
  cleared_at timestamptz,
  cleared_by uuid
);

alter table public.tenant_sending_domain add column if not exists last_checked_at timestamptz;

alter table public.email_contacts enable row level security;
alter table public.email_lists enable row level security;
alter table public.email_list_versions enable row level security;
alter table public.email_list_version_contacts enable row level security;
alter table public.email_bulk_sends enable row level security;
alter table public.email_bulk_send_recipients enable row level security;
alter table public.email_bulk_abuse_holds enable row level security;

revoke all on public.email_contacts from public, anon, authenticated;
revoke all on public.email_lists from public, anon, authenticated;
revoke all on public.email_list_versions from public, anon, authenticated;
revoke all on public.email_list_version_contacts from public, anon, authenticated;
revoke all on public.email_bulk_sends from public, anon, authenticated;
revoke all on public.email_bulk_send_recipients from public, anon, authenticated;
revoke all on public.email_bulk_abuse_holds from public, anon, authenticated;

grant select, insert, update, delete on public.email_contacts to service_role;
grant select, insert, update, delete on public.email_lists to service_role;
grant select, insert, update, delete on public.email_list_versions to service_role;
grant select, insert, update, delete on public.email_list_version_contacts to service_role;
grant select, insert, update, delete on public.email_bulk_sends to service_role;
grant select, insert, update, delete on public.email_bulk_send_recipients to service_role;
grant select, insert, update, delete on public.email_bulk_abuse_holds to service_role;

create or replace function public.email_bulk_block_reason(p_tenant_id uuid, p_email text)
returns text
language sql stable security definer
set search_path = public, pg_temp as $$
  select coalesce(
    (select case s.reason
              when 'unsubscribe' then 'unsubscribed'
              when 'bounce' then 'bounced'
              when 'complaint' then 'complained'
              when 'erased' then 'erased'
              else 'suppressed' end
       from public.email_suppression s
      where s.tenant_id = p_tenant_id and s.email = lower(trim(p_email))),
    (select 'unsubscribed'
       from public.comms_unsubscribes u
      where u.tenant_id = p_tenant_id and u.channel = 'email' and u.recipient = lower(trim(p_email))),
    (select case x.reason
              when 'bounce' then 'bounced'
              when 'complaint' then 'complained'
              else 'suppressed' end
       from public.comms_suppressions x
      where x.tenant_id = p_tenant_id and x.channel = 'email' and x.recipient = lower(trim(p_email)))
  );
$$;
revoke all on function public.email_bulk_block_reason(uuid, text) from public, anon, authenticated;
grant execute on function public.email_bulk_block_reason(uuid, text) to service_role;

create or replace function public.email_list_import_version(
  p_tenant_id   uuid,
  p_list_id     uuid,
  p_list_name   text,
  p_source_kind text,
  p_source_ref  jsonb,
  p_emails      text[],
  p_created_by  uuid
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_norm       text[];
  v_list_id    uuid;
  v_version_id uuid;
  v_count      int;
  v_blocked    int;
begin
  if p_tenant_id is null or p_created_by is null or p_emails is null then
    raise exception 'email_list_import_version: null argument' using errcode = '22023';
  end if;
  if p_source_kind not in ('csv', 'database') then
    raise exception 'email_list_import_version: invalid source' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct lower(trim(e))), '{}'::text[]) into v_norm
    from unnest(p_emails) as e
   where e is not null and length(trim(e)) > 0;
  if coalesce(array_length(v_norm, 1), 0) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_addresses');
  end if;
  if array_length(v_norm, 1) > 10000 then
    return jsonb_build_object('ok', false, 'reason', 'too_many');
  end if;
  if not exists (select 1 from public.tenant_users tu
                  where tu.tenant_id = p_tenant_id and tu.user_id = p_created_by) then
    return jsonb_build_object('ok', false, 'reason', 'not_a_member');
  end if;

  if p_list_id is not null then
    select l.id into v_list_id from public.email_lists l
     where l.id = p_list_id and l.tenant_id = p_tenant_id and l.archived_at is null
     for update;
    if v_list_id is null then
      return jsonb_build_object('ok', false, 'reason', 'list_not_found');
    end if;
  else
    if p_list_name is null or length(trim(p_list_name)) not between 1 and 120 then
      return jsonb_build_object('ok', false, 'reason', 'invalid_name');
    end if;
    if exists (select 1 from public.email_lists l
                where l.tenant_id = p_tenant_id and l.archived_at is null
                  and lower(trim(l.name)) = lower(trim(p_list_name))) then
      return jsonb_build_object('ok', false, 'reason', 'name_taken');
    end if;
    insert into public.email_lists (tenant_id, name, created_by)
    values (p_tenant_id, trim(p_list_name), p_created_by)
    returning id into v_list_id;
  end if;

  insert into public.email_contacts (tenant_id, email_norm)
  select p_tenant_id, e from unnest(v_norm) as e
  on conflict (tenant_id, email_norm) do nothing;

  v_count := array_length(v_norm, 1);
  insert into public.email_list_versions
    (tenant_id, list_id, source_kind, source_ref, contact_count, created_by)
  values
    (p_tenant_id, v_list_id, p_source_kind, coalesce(p_source_ref, '{}'::jsonb), v_count, p_created_by)
  returning id into v_version_id;

  insert into public.email_list_version_contacts (tenant_id, version_id, contact_id)
  select p_tenant_id, v_version_id, c.id
    from public.email_contacts c
   where c.tenant_id = p_tenant_id and c.email_norm = any (v_norm);

  select count(*) into v_blocked
    from unnest(v_norm) as e
   where public.email_bulk_block_reason(p_tenant_id, e) is not null;

  return jsonb_build_object(
    'ok', true, 'list_id', v_list_id, 'version_id', v_version_id,
    'contact_count', v_count, 'already_blocked', v_blocked);
end $$;
revoke all on function public.email_list_import_version(uuid, uuid, text, text, jsonb, text[], uuid) from public, anon, authenticated;
grant execute on function public.email_list_import_version(uuid, uuid, text, text, jsonb, text[], uuid) to service_role;

create or replace function public.email_list_record_consent(
  p_tenant_id    uuid,
  p_list_id      uuid,
  p_version_id   uuid,
  p_user_id      uuid,
  p_consent_text text
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_latest uuid;
  v_done   timestamptz;
begin
  if p_tenant_id is null or p_list_id is null or p_version_id is null or p_user_id is null
     or p_consent_text is null or length(trim(p_consent_text)) = 0 then
    raise exception 'email_list_record_consent: null argument' using errcode = '22023';
  end if;
  if not exists (select 1 from public.tenant_users tu
                  where tu.tenant_id = p_tenant_id and tu.user_id = p_user_id) then
    return jsonb_build_object('ok', false, 'reason', 'not_a_member');
  end if;
  perform 1 from public.email_lists l
    where l.id = p_list_id and l.tenant_id = p_tenant_id and l.archived_at is null
    for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'list_not_found');
  end if;
  select v.consent_confirmed_at into v_done from public.email_list_versions v
   where v.id = p_version_id and v.list_id = p_list_id and v.tenant_id = p_tenant_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'version_not_found');
  end if;
  if v_done is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_recorded');
  end if;
  select v.id into v_latest from public.email_list_versions v
   where v.list_id = p_list_id and v.tenant_id = p_tenant_id
   order by v.created_at desc, v.id desc limit 1;
  if v_latest is distinct from p_version_id then
    return jsonb_build_object('ok', false, 'reason', 'superseded');
  end if;

  update public.email_list_versions v
     set consent_text = p_consent_text, consent_confirmed_by = p_user_id, consent_confirmed_at = now()
   where v.id = p_version_id and v.list_id = p_list_id and v.tenant_id = p_tenant_id
     and v.consent_confirmed_at is null;
  update public.email_lists l set active_version_id = p_version_id
   where l.id = p_list_id and l.tenant_id = p_tenant_id;
  return jsonb_build_object('ok', true, 'active_version_id', p_version_id);
end $$;
revoke all on function public.email_list_record_consent(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.email_list_record_consent(uuid, uuid, uuid, uuid, text) to service_role;

create or replace function public.email_list_summaries(p_tenant_id uuid)
returns jsonb
language sql stable security definer
set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(s.item order by s.item->>'created_at' desc), '[]'::jsonb)
    from (
      select jsonb_build_object(
        'id', l.id,
        'name', l.name,
        'created_at', l.created_at,
        'active_version_id', l.active_version_id,
        'latest', (
          select jsonb_build_object(
                   'id', v.id, 'source_kind', v.source_kind, 'source_ref', v.source_ref,
                   'contact_count', v.contact_count, 'created_at', v.created_at,
                   'consented', v.consent_confirmed_at is not null)
            from public.email_list_versions v
           where v.tenant_id = l.tenant_id and v.list_id = l.id
           order by v.created_at desc, v.id desc limit 1),
        'active', (
          select jsonb_build_object(
                   'id', v.id, 'source_kind', v.source_kind, 'contact_count', v.contact_count,
                   'consented_at', v.consent_confirmed_at,
                   'blocked', (
                     select count(*)
                       from public.email_list_version_contacts m
                       join public.email_contacts c on c.tenant_id = m.tenant_id and c.id = m.contact_id
                      where m.tenant_id = v.tenant_id and m.version_id = v.id
                        and (c.erased_at is not null
                             or public.email_bulk_block_reason(v.tenant_id, c.email_norm) is not null)))
            from public.email_list_versions v
           where v.tenant_id = l.tenant_id and v.list_id = l.id and v.id = l.active_version_id)
      ) as item
        from public.email_lists l
       where l.tenant_id = p_tenant_id and l.archived_at is null
    ) s;
$$;
revoke all on function public.email_list_summaries(uuid) from public, anon, authenticated;
grant execute on function public.email_list_summaries(uuid) to service_role;

create or replace function public.email_list_contacts_page(
  p_tenant_id  uuid,
  p_list_id    uuid,
  p_version_id uuid,
  p_limit      int,
  p_offset     int
) returns jsonb
language sql stable security definer
set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'total', (select count(*) from public.email_list_version_contacts m
               join public.email_list_versions v on v.tenant_id = m.tenant_id and v.id = m.version_id
              where m.tenant_id = p_tenant_id and m.version_id = p_version_id and v.list_id = p_list_id),
    'contacts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', x.id, 'email', x.email_norm,
               'status', case when x.erased_at is not null then 'erased'
                              else coalesce(public.email_bulk_block_reason(p_tenant_id, x.email_norm), 'ok') end)
             order by x.email_norm nulls last, x.id)
        from (
          select c.id, c.email_norm, c.erased_at
            from public.email_list_version_contacts m
            join public.email_list_versions v on v.tenant_id = m.tenant_id and v.id = m.version_id
            join public.email_contacts c on c.tenant_id = m.tenant_id and c.id = m.contact_id
           where m.tenant_id = p_tenant_id and m.version_id = p_version_id and v.list_id = p_list_id
           order by c.email_norm nulls last, c.id
           limit least(greatest(coalesce(p_limit, 50), 1), 200)
          offset greatest(coalesce(p_offset, 0), 0)
        ) x), '[]'::jsonb));
$$;
revoke all on function public.email_list_contacts_page(uuid, uuid, uuid, int, int) from public, anon, authenticated;
grant execute on function public.email_list_contacts_page(uuid, uuid, uuid, int, int) to service_role;

create or replace function public.email_list_version_emails(
  p_tenant_id  uuid,
  p_list_id    uuid,
  p_version_id uuid,
  p_limit      int
) returns jsonb
language sql stable security definer
set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(x.email_norm order by x.email_norm), '[]'::jsonb)
    from (
      select c.email_norm
        from public.email_list_version_contacts m
        join public.email_list_versions v on v.tenant_id = m.tenant_id and v.id = m.version_id
        join public.email_contacts c on c.tenant_id = m.tenant_id and c.id = m.contact_id
       where m.tenant_id = p_tenant_id and m.version_id = p_version_id and v.list_id = p_list_id
         and c.erased_at is null and c.email_norm is not null
       order by c.email_norm
       limit least(greatest(coalesce(p_limit, 1001), 1), 10001)
    ) x;
$$;
revoke all on function public.email_list_version_emails(uuid, uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.email_list_version_emails(uuid, uuid, uuid, int) to service_role;

create or replace function public.email_contact_erase(p_tenant_id uuid, p_contact_id uuid)
returns boolean
language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_email text;
begin
  if p_tenant_id is null or p_contact_id is null then
    raise exception 'email_contact_erase: null argument' using errcode = '22023';
  end if;
  select c.email_norm into v_email from public.email_contacts c
   where c.id = p_contact_id and c.tenant_id = p_tenant_id and c.erased_at is null
   for update;
  if v_email is null then
    return false;
  end if;
  insert into public.email_suppression (tenant_id, email, reason)
  values (p_tenant_id, v_email, 'erased')
  on conflict (tenant_id, email) do nothing;
  update public.email_bulk_send_recipients r
     set status = 'skipped', skip_reason = 'erased', stamped_at = now()
   where r.tenant_id = p_tenant_id and r.contact_id = p_contact_id and r.status in ('pending', 'sending');
  update public.email_bulk_send_recipients r
     set email_at_send = null
   where r.tenant_id = p_tenant_id and r.contact_id = p_contact_id;
  update public.email_contacts c
     set erased_at = now(), email_norm = null, display_name = null, updated_at = now()
   where c.id = p_contact_id and c.tenant_id = p_tenant_id;
  return true;
end $$;
revoke all on function public.email_contact_erase(uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_contact_erase(uuid, uuid) to service_role;

create or replace function public.email_bulk_freeze_send(
  p_tenant_id    uuid,
  p_decision_id  uuid,
  p_list_id      uuid,
  p_version_id   uuid,
  p_subject      text,
  p_body_text    text,
  p_from_address text,
  p_reply_to     text,
  p_cap          int
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_send  public.email_bulk_sends%rowtype;
  v_total int;
  v_cap   int := least(coalesce(p_cap, 0), 1000);
begin
  if p_tenant_id is null or p_decision_id is null or p_list_id is null or p_version_id is null
     or p_subject is null or p_body_text is null or p_from_address is null
     or p_cap is null or p_cap < 1 then
    raise exception 'email_bulk_freeze_send: invalid argument' using errcode = '22023';
  end if;

  select * into v_send from public.email_bulk_sends s
   where s.decision_id = p_decision_id and s.tenant_id = p_tenant_id;
  if found then
    return jsonb_build_object('ok', true, 'created', false, 'send_id', v_send.id,
                              'total', v_send.total, 'status', v_send.status);
  end if;

  if exists (select 1 from public.email_bulk_abuse_holds a
              where a.tenant_id = p_tenant_id and a.cleared_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'abuse_hold');
  end if;
  if not exists (select 1 from public.decisions d
                  where d.id = p_decision_id and d.tenant_id = p_tenant_id
                    and d.decision_class = 'bulk_outbound.send'
                    and d.approved_by is not null
                    and d.status in ('approved', 'dispatching')) then
    return jsonb_build_object('ok', false, 'reason', 'not_approved');
  end if;
  if not exists (select 1 from public.email_lists l
                  where l.id = p_list_id and l.tenant_id = p_tenant_id and l.archived_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'list_archived');
  end if;
  if not exists (select 1 from public.email_list_versions v
                  where v.id = p_version_id and v.list_id = p_list_id and v.tenant_id = p_tenant_id
                    and v.consent_confirmed_at is not null) then
    return jsonb_build_object('ok', false, 'reason', 'version_not_consented');
  end if;

  insert into public.email_bulk_sends
    (tenant_id, decision_id, list_id, list_version_id, subject, body_text, from_address, reply_to)
  values
    (p_tenant_id, p_decision_id, p_list_id, p_version_id, p_subject, p_body_text, p_from_address, p_reply_to)
  on conflict (decision_id) do nothing
  returning * into v_send;
  if v_send.id is null then
    select * into v_send from public.email_bulk_sends s
     where s.decision_id = p_decision_id and s.tenant_id = p_tenant_id;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'not_approved');
    end if;
    return jsonb_build_object('ok', true, 'created', false, 'send_id', v_send.id,
                              'total', v_send.total, 'status', v_send.status);
  end if;

  insert into public.email_bulk_send_recipients (send_id, tenant_id, contact_id, email_at_send)
  select v_send.id, p_tenant_id, x.id, x.email_norm
    from (
      select c.id, c.email_norm
        from public.email_list_version_contacts m
        join public.email_contacts c on c.tenant_id = m.tenant_id and c.id = m.contact_id
       where m.tenant_id = p_tenant_id and m.version_id = p_version_id
         and c.erased_at is null and c.email_norm is not null
       order by c.email_norm
       limit v_cap
    ) x;
  get diagnostics v_total = row_count;
  update public.email_bulk_sends s set total = v_total
   where s.id = v_send.id and s.tenant_id = p_tenant_id;

  return jsonb_build_object('ok', true, 'created', true, 'send_id', v_send.id,
                            'total', v_total, 'status', 'sending');
end $$;
revoke all on function public.email_bulk_freeze_send(uuid, uuid, uuid, uuid, text, text, text, text, int) from public, anon, authenticated;
grant execute on function public.email_bulk_freeze_send(uuid, uuid, uuid, uuid, text, text, text, text, int) to service_role;

create or replace function public.email_bulk_claim_next(
  p_tenant_id uuid,
  p_send_id   uuid,
  p_daily_cap int
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_status    text;
  v_from      text;
  v_domain    text;
  v_day       date := (now() at time zone 'utc')::date;
  v_day_index int;
  v_w_index   int;
  v_w_last    date;
  v_warmup    int;
  v_cap       int;
  v_contact   uuid;
  v_email     text;
  v_erased    timestamptz;
  v_reason    text;
  v_count     int;
begin
  if p_tenant_id is null or p_send_id is null or p_daily_cap is null or p_daily_cap < 0 then
    raise exception 'email_bulk_claim_next: invalid argument' using errcode = '22023';
  end if;
  select s.status, s.from_address into v_status, v_from from public.email_bulk_sends s
   where s.id = p_send_id and s.tenant_id = p_tenant_id
   for update;
  if v_status is distinct from 'sending' then
    return jsonb_build_object('outcome', 'held');
  end if;
  if not exists (
    select 1
      from public.email_bulk_sends s
      join public.email_lists l on l.tenant_id = s.tenant_id and l.id = s.list_id
      join public.email_list_versions lv
        on lv.tenant_id = s.tenant_id and lv.list_id = s.list_id and lv.id = s.list_version_id
     where s.id = p_send_id and s.tenant_id = p_tenant_id
       and l.archived_at is null and lv.consent_confirmed_at is not null
  ) then
    return jsonb_build_object('outcome', 'held');
  end if;
  if exists (select 1 from public.email_bulk_abuse_holds a
              where a.tenant_id = p_tenant_id and a.cleared_at is null) then
    return jsonb_build_object('outcome', 'held');
  end if;

  select r.contact_id, r.email_at_send, c.erased_at
    into v_contact, v_email, v_erased
    from public.email_bulk_send_recipients r
    join public.email_contacts c on c.tenant_id = r.tenant_id and c.id = r.contact_id
   where r.send_id = p_send_id and r.tenant_id = p_tenant_id and r.status = 'pending'
   order by r.contact_id
   limit 1
   for update of r skip locked;
  if v_contact is null then
    return jsonb_build_object('outcome', 'none_pending');
  end if;

  if v_erased is not null or v_email is null then
    v_reason := 'erased';
  else
    v_reason := public.email_bulk_block_reason(p_tenant_id, v_email);
  end if;
  if v_reason is not null then
    update public.email_bulk_send_recipients r
       set status = 'skipped', skip_reason = v_reason, stamped_at = now()
     where r.send_id = p_send_id and r.tenant_id = p_tenant_id and r.contact_id = v_contact;
    return jsonb_build_object('outcome', 'skipped', 'reason', v_reason);
  end if;

  v_domain := nullif(lower(split_part(coalesce(v_from, ''), '@', 2)), '');
  if v_domain is null then
    raise exception 'email_bulk_claim_next: send has no sending domain' using errcode = '22023';
  end if;
  select w.day_index, w.last_sent_on into v_w_index, v_w_last
    from public.email_domain_warmup w
   where w.tenant_id = p_tenant_id and w.domain = v_domain
   for update;
  v_day_index := case
    when v_w_index is null then 0
    when v_w_last is null or v_w_last < v_day then v_w_index + 1
    else v_w_index
  end;
  v_warmup := case when v_day_index >= 10 then 0 else 50 * (2 ^ greatest(v_day_index, 0))::int end;
  v_cap := case
    when v_warmup > 0 and p_daily_cap > 0 then least(v_warmup, p_daily_cap)
    when v_warmup > 0 then v_warmup
    else p_daily_cap
  end;

  insert into public.email_send_counters (tenant_id, day)
  values (p_tenant_id, v_day)
  on conflict (tenant_id, day) do nothing;
  update public.email_send_counters
     set sent_count = sent_count + 1, updated_at = now()
   where tenant_id = p_tenant_id and day = v_day
     and (v_cap = 0 or sent_count + 1 <= v_cap)
  returning sent_count into v_count;
  if v_count is null then
    return jsonb_build_object('outcome', 'allowance_exhausted', 'day_index', v_day_index);
  end if;

  update public.email_bulk_send_recipients r
     set status = 'sending', stamped_at = now()
   where r.send_id = p_send_id and r.tenant_id = p_tenant_id and r.contact_id = v_contact;
  return jsonb_build_object('outcome', 'claimed', 'contact_id', v_contact, 'email', v_email, 'day_index', v_day_index);
end $$;
revoke all on function public.email_bulk_claim_next(uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.email_bulk_claim_next(uuid, uuid, int) to service_role;

create or replace function public.email_bulk_skip_if_blocked(
  p_tenant_id  uuid,
  p_send_id    uuid,
  p_contact_id uuid
) returns text
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_status text; v_skip text; v_email text; v_erased timestamptz; v_reason text;
begin
  if p_tenant_id is null or p_send_id is null or p_contact_id is null then
    raise exception 'email_bulk_skip_if_blocked: null argument' using errcode = '22023';
  end if;
  select r.status, r.skip_reason, r.email_at_send, c.erased_at
    into v_status, v_skip, v_email, v_erased
    from public.email_bulk_send_recipients r
    join public.email_contacts c on c.tenant_id = r.tenant_id and c.id = r.contact_id
   where r.send_id = p_send_id and r.tenant_id = p_tenant_id and r.contact_id = p_contact_id
   for update of r;
  if not found then
    return 'not_found';
  end if;
  if v_status = 'skipped' then
    return coalesce(v_skip, 'skipped');
  end if;
  if v_status <> 'sending' then
    return 'not_claimed';
  end if;
  if v_erased is not null or v_email is null then
    v_reason := 'erased';
  else
    v_reason := public.email_bulk_block_reason(p_tenant_id, v_email);
  end if;
  if v_reason is not null then
    update public.email_bulk_send_recipients r
       set status = 'skipped', skip_reason = v_reason, stamped_at = now()
     where r.send_id = p_send_id and r.tenant_id = p_tenant_id and r.contact_id = p_contact_id;
  end if;
  return v_reason;
end $$;
revoke all on function public.email_bulk_skip_if_blocked(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_bulk_skip_if_blocked(uuid, uuid, uuid) to service_role;

create or replace function public.email_bulk_settle_recipient(
  p_tenant_id  uuid,
  p_send_id    uuid,
  p_contact_id uuid,
  p_status     text
) returns boolean
language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_n int; v_domain text;
begin
  if p_tenant_id is null or p_send_id is null or p_contact_id is null
     or p_status not in ('sent', 'failed', 'unknown') then
    raise exception 'email_bulk_settle_recipient: invalid argument' using errcode = '22023';
  end if;
  update public.email_bulk_send_recipients r
     set status = p_status, skip_reason = null, stamped_at = now()
   where r.send_id = p_send_id and r.tenant_id = p_tenant_id and r.contact_id = p_contact_id
     and (r.status = 'sending'
          or (r.status = 'unknown' and p_status in ('sent', 'failed'))
          or (r.status = 'skipped' and r.skip_reason = 'erased'));
  get diagnostics v_n = row_count;
  if v_n > 0 and p_status in ('sent', 'unknown') then
    select nullif(lower(split_part(s.from_address, '@', 2)), '') into v_domain
      from public.email_bulk_sends s
     where s.id = p_send_id and s.tenant_id = p_tenant_id;
    if v_domain is not null then
      perform public.touch_domain_warmup(p_tenant_id, v_domain, (now() at time zone 'utc')::date);
    end if;
  end if;
  return v_n > 0;
end $$;
revoke all on function public.email_bulk_settle_recipient(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.email_bulk_settle_recipient(uuid, uuid, uuid, text) to service_role;

create or replace function public.email_bulk_requeue_claimed(
  p_tenant_id  uuid,
  p_send_id    uuid,
  p_contact_id uuid
) returns boolean
language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_n int;
begin
  if p_tenant_id is null or p_send_id is null or p_contact_id is null then
    raise exception 'email_bulk_requeue_claimed: null argument' using errcode = '22023';
  end if;
  update public.email_bulk_send_recipients r
     set status = 'pending', stamped_at = now()
   where r.send_id = p_send_id and r.tenant_id = p_tenant_id and r.contact_id = p_contact_id
     and r.status = 'sending';
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;
revoke all on function public.email_bulk_requeue_claimed(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_bulk_requeue_claimed(uuid, uuid, uuid) to service_role;

create or replace function public.email_bulk_mark_stale_unknown(
  p_tenant_id     uuid,
  p_send_id       uuid,
  p_stale_seconds int
) returns int
language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_n int;
begin
  if p_tenant_id is null or p_send_id is null or p_stale_seconds is null or p_stale_seconds < 0 then
    raise exception 'email_bulk_mark_stale_unknown: invalid argument' using errcode = '22023';
  end if;
  update public.email_bulk_send_recipients r
     set status = 'unknown'
   where r.send_id = p_send_id and r.tenant_id = p_tenant_id and r.status = 'sending'
     and r.stamped_at <= now() - make_interval(secs => p_stale_seconds);
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.email_bulk_mark_stale_unknown(uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.email_bulk_mark_stale_unknown(uuid, uuid, int) to service_role;

create or replace function public.email_bulk_settle_send(
  p_tenant_id   uuid,
  p_send_id     uuid,
  p_status      text,
  p_hold_reason text,
  p_next_run_at timestamptz
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v public.email_bulk_sends%rowtype;
  v_pending int; v_sending int; v_sent int; v_skipped int; v_failed int; v_unknown int;
begin
  if p_tenant_id is null or p_send_id is null
     or (p_status is not null and p_status not in ('sending', 'waiting_for_tomorrow', 'held', 'done', 'failed')) then
    raise exception 'email_bulk_settle_send: invalid argument' using errcode = '22023';
  end if;
  select count(*) filter (where r.status = 'pending'),
         count(*) filter (where r.status = 'sending'),
         count(*) filter (where r.status = 'sent'),
         count(*) filter (where r.status = 'skipped'),
         count(*) filter (where r.status = 'failed'),
         count(*) filter (where r.status = 'unknown')
    into v_pending, v_sending, v_sent, v_skipped, v_failed, v_unknown
    from public.email_bulk_send_recipients r
   where r.send_id = p_send_id and r.tenant_id = p_tenant_id;

  if p_status = 'held' and p_hold_reason in ('abuse_complaints', 'abuse_bounces') then
    insert into public.email_bulk_abuse_holds (tenant_id, send_id, reason)
    values (p_tenant_id, p_send_id, p_hold_reason)
    on conflict (tenant_id) do update
      set send_id = excluded.send_id, reason = excluded.reason, created_at = now(),
          cleared_at = null, cleared_by = null
      where public.email_bulk_abuse_holds.cleared_at is not null;
  end if;

  update public.email_bulk_sends s
     set sent = v_sent, skipped = v_skipped, failed = v_failed, unknown = v_unknown,
         status = case
           when p_status is null then s.status
           when s.status in ('done', 'failed') then s.status
           when s.status = 'held' then s.status
           else p_status end,
         hold_reason = case
           when p_status = 'held' and s.status not in ('done', 'failed', 'held') then p_hold_reason
           else s.hold_reason end,
         next_run_at = case
           when p_status = 'waiting_for_tomorrow' and s.status not in ('done', 'failed', 'held') then p_next_run_at
           when p_status is null then s.next_run_at
           else null end,
         finished_at = case
           when p_status in ('done', 'failed') and s.status not in ('done', 'failed', 'held') then now()
           else s.finished_at end
   where s.id = p_send_id and s.tenant_id = p_tenant_id
  returning * into v;
  if v.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  return jsonb_build_object(
    'ok', true, 'status', v.status, 'hold_reason', v.hold_reason, 'next_run_at', v.next_run_at,
    'total', v.total, 'sent', v_sent, 'skipped', v_skipped, 'failed', v_failed,
    'unknown', v_unknown, 'pending', v_pending, 'sending', v_sending,
    'complaints', v.complaints, 'hard_bounces', v.hard_bounces);
end $$;
revoke all on function public.email_bulk_settle_send(uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.email_bulk_settle_send(uuid, uuid, text, text, timestamptz) to service_role;

create or replace function public.email_bulk_record_feedback(
  p_tenant_id uuid,
  p_send_id   uuid,
  p_email     text,
  p_kind      text
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  c_complaints_any constant int := 5;
  c_min_sent       constant int := 200;
  c_complaint_rate constant numeric := 0.003;
  c_bounce_rate    constant numeric := 0.05;
  v public.email_bulk_sends%rowtype;
  v_n int; v_sent int; v_tripped boolean := false; v_reason text;
begin
  if p_tenant_id is null or p_send_id is null or p_email is null
     or p_kind not in ('complaint', 'hard_bounce') then
    raise exception 'email_bulk_record_feedback: invalid argument' using errcode = '22023';
  end if;
  select * into v from public.email_bulk_sends s
   where s.id = p_send_id and s.tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  update public.email_bulk_send_recipients r
     set feedback = p_kind
   where r.send_id = p_send_id and r.tenant_id = p_tenant_id
     and r.email_at_send = lower(trim(p_email)) and r.feedback is null;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('ok', true, 'counted', false, 'tripped', false, 'reason', null,
                              'complaints', v.complaints, 'hard_bounces', v.hard_bounces);
  end if;
  if v_n > 0 then
    update public.email_bulk_sends s
       set complaints = s.complaints + (case when p_kind = 'complaint' then 1 else 0 end),
           hard_bounces = s.hard_bounces + (case when p_kind = 'hard_bounce' then 1 else 0 end)
     where s.id = p_send_id and s.tenant_id = p_tenant_id
    returning * into v;
  end if;

  select count(*) into v_sent from public.email_bulk_send_recipients r
   where r.send_id = p_send_id and r.tenant_id = p_tenant_id and r.status = 'sent';
  if v.complaints >= c_complaints_any then
    v_tripped := true; v_reason := 'abuse_complaints';
  elsif v_sent >= c_min_sent then
    if v.complaints::numeric / v_sent >= c_complaint_rate then
      v_tripped := true; v_reason := 'abuse_complaints';
    elsif v.hard_bounces::numeric / v_sent >= c_bounce_rate then
      v_tripped := true; v_reason := 'abuse_bounces';
    end if;
  end if;
  if v_tripped then
    update public.email_bulk_sends s
       set status = 'held', hold_reason = v_reason, next_run_at = null
     where s.id = p_send_id and s.tenant_id = p_tenant_id
       and s.status in ('sending', 'waiting_for_tomorrow');
    insert into public.email_bulk_abuse_holds (tenant_id, send_id, reason)
    values (p_tenant_id, p_send_id, v_reason)
    on conflict (tenant_id) do update
      set send_id = excluded.send_id, reason = excluded.reason, created_at = now(),
          cleared_at = null, cleared_by = null
      where public.email_bulk_abuse_holds.cleared_at is not null;
  end if;
  return jsonb_build_object('ok', true, 'counted', v_n > 0, 'tripped', v_tripped, 'reason', v_reason,
                            'complaints', v.complaints, 'hard_bounces', v.hard_bounces, 'sent', v_sent);
end $$;
revoke all on function public.email_bulk_record_feedback(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.email_bulk_record_feedback(uuid, uuid, text, text) to service_role;

create or replace function public.tenant_sending_domain_upsert_pending(
  p_tenant_id          uuid,
  p_user_id            uuid,
  p_domain             text,
  p_provider_domain_id text,
  p_dns_records        jsonb
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_released text;
begin
  if p_tenant_id is null or p_user_id is null or p_domain is null or length(trim(p_domain)) = 0
     or p_provider_domain_id is null then
    raise exception 'tenant_sending_domain_upsert_pending: null argument' using errcode = '22023';
  end if;
  if not exists (select 1 from public.tenant_users tu
                  where tu.tenant_id = p_tenant_id and tu.user_id = p_user_id
                    and tu.role in ('owner', 'admin')) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  delete from public.tenant_sending_domain d
   where lower(d.domain) = lower(trim(p_domain)) and d.tenant_id <> p_tenant_id
     and d.verification_status <> 'verified' and d.updated_at < now() - interval '7 days'
  returning d.provider_domain_id into v_released;
  if exists (select 1 from public.tenant_sending_domain d
              where lower(d.domain) = lower(trim(p_domain)) and d.tenant_id <> p_tenant_id) then
    return jsonb_build_object('ok', false, 'reason', 'domain_taken');
  end if;
  insert into public.tenant_sending_domain as cur
    (tenant_id, domain, verification_status, verification_error, dns_records, provider_domain_id, verified_at)
  values
    (p_tenant_id, lower(trim(p_domain)), 'pending', null, coalesce(p_dns_records, '[]'::jsonb), p_provider_domain_id, null)
  on conflict (tenant_id) do update
    set domain = excluded.domain,
        from_address = case when lower(cur.domain) = excluded.domain then cur.from_address else null end,
        verification_status = 'pending',
        verification_error = null,
        dns_records = excluded.dns_records,
        provider_domain_id = excluded.provider_domain_id,
        verified_at = null,
        last_checked_at = null,
        updated_at = now();
  return jsonb_build_object('ok', true, 'released_provider_domain_id', v_released);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'reason', 'domain_taken');
end $$;
revoke all on function public.tenant_sending_domain_upsert_pending(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.tenant_sending_domain_upsert_pending(uuid, uuid, text, text, jsonb) to service_role;

create or replace function public.tenant_sending_domain_check(
  p_tenant_id uuid,
  p_user_id   uuid,
  p_domain    text
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null or p_user_id is null or p_domain is null or length(trim(p_domain)) = 0 then
    raise exception 'tenant_sending_domain_check: null argument' using errcode = '22023';
  end if;
  if not exists (select 1 from public.tenant_users tu
                  where tu.tenant_id = p_tenant_id and tu.user_id = p_user_id
                    and tu.role in ('owner', 'admin')) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if exists (select 1 from public.tenant_sending_domain d
              where lower(d.domain) = lower(trim(p_domain)) and d.tenant_id <> p_tenant_id
                and not (d.verification_status <> 'verified' and d.updated_at < now() - interval '7 days')) then
    return jsonb_build_object('ok', false, 'reason', 'domain_taken');
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.tenant_sending_domain_check(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.tenant_sending_domain_check(uuid, uuid, text) to service_role;

create or replace function public.tenant_sending_domain_release(
  p_tenant_id  uuid,
  p_user_id    uuid,
  p_only_stale boolean
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_provider text; v_found boolean;
begin
  if p_tenant_id is null or p_user_id is null or p_only_stale is null then
    raise exception 'tenant_sending_domain_release: null argument' using errcode = '22023';
  end if;
  if not exists (select 1 from public.tenant_users tu
                  where tu.tenant_id = p_tenant_id and tu.user_id = p_user_id
                    and tu.role in ('owner', 'admin')) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  delete from public.tenant_sending_domain d
   where d.tenant_id = p_tenant_id
     and (not p_only_stale
          or (d.verification_status <> 'verified' and d.updated_at < now() - interval '7 days'))
  returning d.provider_domain_id, true into v_provider, v_found;
  return jsonb_build_object('ok', true, 'released', coalesce(v_found, false), 'provider_domain_id', v_provider);
end $$;
revoke all on function public.tenant_sending_domain_release(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.tenant_sending_domain_release(uuid, uuid, boolean) to service_role;

create or replace function public.tenant_sending_domain_set_status(
  p_tenant_id          uuid,
  p_provider_domain_id text,
  p_domain             text,
  p_status             text,
  p_error              text
) returns boolean
language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_n int;
begin
  if p_tenant_id is null or p_provider_domain_id is null or p_domain is null
     or p_status not in ('pending', 'verified', 'failed') then
    raise exception 'tenant_sending_domain_set_status: invalid argument' using errcode = '22023';
  end if;
  update public.tenant_sending_domain d
     set verification_status = p_status,
         verification_error = case when p_status = 'verified' then null else left(p_error, 500) end,
         verified_at = case when p_status = 'verified' then coalesce(d.verified_at, now()) else null end,
         last_checked_at = now(),
         updated_at = now()
   where d.tenant_id = p_tenant_id and d.provider_domain_id = p_provider_domain_id
     and lower(d.domain) = lower(trim(p_domain));
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;
revoke all on function public.tenant_sending_domain_set_status(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.tenant_sending_domain_set_status(uuid, text, text, text, text) to service_role;

create or replace function public.email_bulk_abuse_switch_off(p_tenant_id uuid)
returns boolean
language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_n int;
begin
  if p_tenant_id is null then
    raise exception 'email_bulk_abuse_switch_off: null argument' using errcode = '22023';
  end if;
  insert into public.tenant_app_setting as t (tenant_id, key, value, updated_at, updated_by)
  values (p_tenant_id, 'bulk_outbound_enabled', 'false'::jsonb, now(), 'system:bulk-email-abuse-shutoff')
  on conflict (tenant_id, key) do update
    set value = 'false'::jsonb, updated_at = now(), updated_by = 'system:bulk-email-abuse-shutoff'
    where t.value is distinct from 'false'::jsonb;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;
revoke all on function public.email_bulk_abuse_switch_off(uuid) from public, anon, authenticated;
grant execute on function public.email_bulk_abuse_switch_off(uuid) to service_role;

create or replace function public.email_bulk_clear_abuse_hold(
  p_tenant_id     uuid,
  p_staff_user_id uuid
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_n int; v_reenabled int;
begin
  if p_tenant_id is null or p_staff_user_id is null then
    raise exception 'email_bulk_clear_abuse_hold: null argument' using errcode = '22023';
  end if;
  if not exists (select 1 from public.staff_users su
                  where su.user_id = p_staff_user_id and su.revoked_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'not_staff');
  end if;
  update public.email_bulk_abuse_holds a
     set cleared_at = now(), cleared_by = p_staff_user_id
   where a.tenant_id = p_tenant_id and a.cleared_at is null;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_open_hold');
  end if;
  delete from public.tenant_app_setting t
   where t.tenant_id = p_tenant_id and t.key = 'bulk_outbound_enabled'
     and t.value = 'false'::jsonb and t.updated_by = 'system:bulk-email-abuse-shutoff';
  get diagnostics v_reenabled = row_count;
  return jsonb_build_object('ok', true, 'bulk_email_reenabled', v_reenabled > 0);
end $$;
revoke all on function public.email_bulk_clear_abuse_hold(uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_bulk_clear_abuse_hold(uuid, uuid) to service_role;

create or replace function public.email_bulk_resume_send(
  p_tenant_id uuid,
  p_send_id   uuid
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v public.email_bulk_sends%rowtype;
  v_pending int;
  v_flag jsonb;
  v_blob jsonb;
  v_domain text;
begin
  if p_tenant_id is null or p_send_id is null then
    raise exception 'email_bulk_resume_send: null argument' using errcode = '22023';
  end if;
  select * into v from public.email_bulk_sends s
   where s.id = p_send_id and s.tenant_id = p_tenant_id
   for update;
  if v.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v.status <> 'held' then
    return jsonb_build_object('ok', false, 'reason', 'not_held');
  end if;
  if coalesce(v.hold_reason, '') not in ('abuse_complaints', 'abuse_bounces', 'provider_refused', 'bulk_check_failed') then
    return jsonb_build_object('ok', false, 'reason', 'not_resumable', 'hold_reason', v.hold_reason);
  end if;
  if exists (select 1 from public.email_bulk_abuse_holds a
              where a.tenant_id = p_tenant_id and a.cleared_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'abuse_hold');
  end if;
  select t.value into v_flag from public.tenant_app_setting t
   where t.tenant_id = p_tenant_id and t.key = 'bulk_outbound_enabled';
  if v_flag = 'false'::jsonb then
    return jsonb_build_object('ok', false, 'reason', 'bulk_outbound_disabled');
  end if;
  select c.blob into v_blob from public.system_config c where c.id = 1;
  if v_blob -> 'bulk_email_send_enabled' = 'false'::jsonb then
    return jsonb_build_object('ok', false, 'reason', 'bulk_sending_paused');
  end if;
  v_domain := nullif(lower(split_part(v.from_address, '@', 2)), '');
  if not exists (select 1 from public.tenant_sending_domain d
                  where d.tenant_id = p_tenant_id and d.verification_status = 'verified'
                    and lower(d.domain) = v_domain) then
    return jsonb_build_object('ok', false, 'reason', 'sending_domain_not_verified');
  end if;
  if not exists (select 1 from public.email_lists l
                  where l.id = v.list_id and l.tenant_id = p_tenant_id and l.archived_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'list_archived');
  end if;
  if not exists (select 1 from public.email_list_versions lv
                  where lv.id = v.list_version_id and lv.list_id = v.list_id and lv.tenant_id = p_tenant_id
                    and lv.consent_confirmed_at is not null) then
    return jsonb_build_object('ok', false, 'reason', 'list_not_consented');
  end if;
  select count(*) into v_pending from public.email_bulk_send_recipients r
   where r.send_id = p_send_id and r.tenant_id = p_tenant_id and r.status = 'pending';
  if v_pending = 0 then
    return jsonb_build_object('ok', false, 'reason', 'nobody_waiting');
  end if;
  update public.email_bulk_sends s
     set status = 'sending', hold_reason = null, next_run_at = null
   where s.id = p_send_id and s.tenant_id = p_tenant_id;
  return jsonb_build_object('ok', true, 'pending', v_pending);
end $$;
revoke all on function public.email_bulk_resume_send(uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_bulk_resume_send(uuid, uuid) to service_role;

commit;
