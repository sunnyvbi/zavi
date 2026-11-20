

alter table public.tenant_sandbox
  add column if not exists preview_ended_at timestamptz;

comment on column public.tenant_sandbox.preview_ended_at is
  'When an ENGINEER preview reached its terminal (dead) state. Set by expire_engineer_sandbox_preview; reset to NULL when a fresh preview transitions into starting/live via set_engineer_sandbox_preview. NULL for product-builder preview rows (they use clear_sandbox_preview, which does not touch this column).';

create or replace function expire_engineer_sandbox_preview(
  p_id uuid,
  p_reason text default null
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.tenant_sandbox
  set preview_status   = 'dead',
      preview_url      = null,
      preview_error    = case
        when p_reason is not null then left(p_reason, 500)
        else preview_error
      end,
      preview_ended_at = now(),
      updated_at       = now()
  where id = p_id;
end $$;
revoke all on function expire_engineer_sandbox_preview(uuid, text) from public;
grant execute on function expire_engineer_sandbox_preview(uuid, text) to service_role;

create or replace function set_engineer_sandbox_preview(
  p_id uuid,
  p_url text,
  p_port int,
  p_status text,
  p_run_id text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.tenant_sandbox
  set preview_url        = p_url,
      preview_port       = p_port,
      preview_status     = p_status,
      preview_run_id     = p_run_id,
      preview_error      = case
        when p_status in ('starting','live') then null
        else preview_error
      end,
      preview_ended_at   = case
        when p_status in ('starting','live') then null
        else preview_ended_at
      end,
      preview_started_at = case
        when p_status = 'starting' then now()
        when p_status = 'live' and preview_started_at is null then now()
        else preview_started_at
      end,
      preview_last_viewed_at = case
        when p_status = 'starting' then now()
        when p_status = 'live' and preview_last_viewed_at is null then now()
        else preview_last_viewed_at
      end,
      updated_at = now()
  where id = p_id;
end $$;
revoke all on function set_engineer_sandbox_preview(uuid, text, int, text, text) from public;
grant execute on function set_engineer_sandbox_preview(uuid, text, int, text, text) to service_role;
