
begin;

create table tenant_feedback (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  body text not null,
  attachments jsonb not null default '[]'::jsonb,
  source text not null default 'settings',
  created_at timestamptz not null default now()
);

comment on table tenant_feedback is
  'Free-form product feedback (launch bug #29). Contains CUSTOMER-WRITTEN TEXT — treat as PII. '
  'Writes only via submit_tenant_feedback; reads are tenant-scoped by RLS.';

create index tenant_feedback_tenant_created_idx
  on tenant_feedback (tenant_id, created_at desc);

alter table tenant_feedback enable row level security;

create policy tenant_feedback_select on tenant_feedback for select to authenticated using (
  tenant_id in (select tenant_id from tenant_users where user_id = auth.uid())
);

revoke insert, update, delete on tenant_feedback from authenticated, anon;

create or replace function submit_tenant_feedback(
  p_body text,
  p_attachments jsonb,
  p_source text,
  p_tenant_id uuid default null
) returns table (
  feedback_id uuid,
  tenant_id uuid
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_body text;
  v_attachments jsonb;
  v_source text;
  v_feedback_id uuid;
begin
  if v_user_id is null then
    raise exception 'unauthenticated';
  end if;

  v_tenant_id := p_tenant_id;
  if v_tenant_id is null then
    select p.active_tenant_id into v_tenant_id
      from profiles p
      where p.user_id = v_user_id;
  end if;

  if v_tenant_id is null then
    raise exception 'no active tenant';
  end if;

  if not exists (
    select 1 from tenant_users tu
    where tu.tenant_id = v_tenant_id and tu.user_id = v_user_id
  ) then
    raise exception 'unauthorized';
  end if;

  v_body := btrim(coalesce(p_body, ''));
  if v_body = '' then
    raise exception 'feedback is empty';
  end if;
  v_body := left(v_body, 4000);

  v_attachments := coalesce(p_attachments, '[]'::jsonb);
  if jsonb_typeof(v_attachments) <> 'array' or jsonb_array_length(v_attachments) > 10 then
    v_attachments := '[]'::jsonb;
  end if;

  v_source := case
    when coalesce(p_source, '') in ('settings', 'menu') then p_source
    else 'settings'
  end;

  insert into tenant_feedback (tenant_id, created_by, body, attachments, source)
  values (v_tenant_id, v_user_id, v_body, v_attachments, v_source)
  returning id into v_feedback_id;

  return query select v_feedback_id, v_tenant_id;
end;
$$;

grant execute on function submit_tenant_feedback(text, jsonb, text, uuid) to authenticated;

commit;
