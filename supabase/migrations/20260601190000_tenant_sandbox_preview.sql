
alter table public.tenant_sandbox
  add column if not exists preview_url            text,
  add column if not exists preview_port           int,
  add column if not exists preview_status         text,
  add column if not exists preview_last_viewed_at timestamptz,
  add column if not exists preview_started_at      timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tenant_sandbox_preview_status_chk'
  ) then
    alter table public.tenant_sandbox
      add constraint tenant_sandbox_preview_status_chk
      check (preview_status is null or preview_status in ('starting','live','swapped','dead'));
  end if;
end $$;

comment on column public.tenant_sandbox.preview_url is
  'Public e2b getHost URL (<port>-<sandboxId>.e2b.app) serving the instant dev-server preview. Set via set_sandbox_preview; cleared on swap/reap via clear_sandbox_preview.';
comment on column public.tenant_sandbox.preview_status is
  'starting|live|swapped|dead (NULL = none). Only ''live'' is ever emitted as a preview URL by derivePreview.';

create or replace function set_sandbox_preview(
  p_id uuid,
  p_url text,
  p_port int,
  p_status text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.tenant_sandbox
  set preview_url        = p_url,
      preview_port       = p_port,
      preview_status     = p_status,
      preview_started_at = case
        when p_status in ('starting','live')
             and preview_started_at is null then now()
        else preview_started_at
      end,
      preview_last_viewed_at = case
        when p_status = 'live' and preview_last_viewed_at is null then now()
        else preview_last_viewed_at
      end,
      updated_at = now()
  where id = p_id;
end $$;
revoke all on function set_sandbox_preview(uuid, text, int, text) from public;
grant execute on function set_sandbox_preview(uuid, text, int, text) to service_role;

create or replace function touch_sandbox_preview_viewed(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.tenant_sandbox
  set preview_last_viewed_at = now(),
      updated_at = now()
  where id = p_id and preview_status = 'live';
end $$;
revoke all on function touch_sandbox_preview_viewed(uuid) from public;
grant execute on function touch_sandbox_preview_viewed(uuid) to service_role;

create or replace function clear_sandbox_preview(
  p_id uuid,
  p_final_status text default 'swapped'
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.tenant_sandbox
  set preview_status = p_final_status,
      preview_url    = null,
      preview_port   = null,
      updated_at     = now()
  where id = p_id;
end $$;
revoke all on function clear_sandbox_preview(uuid, text) from public;
grant execute on function clear_sandbox_preview(uuid, text) to service_role;
