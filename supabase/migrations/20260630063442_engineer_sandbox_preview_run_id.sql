
alter table public.tenant_sandbox
  add column if not exists preview_run_id text;

comment on column public.tenant_sandbox.preview_run_id is
  'The engineer agent_runs.run_id that owns this live preview (NULL for product-builder previews and rows with no preview). Set via set_engineer_sandbox_preview; nulled by clear_sandbox_preview. Used by the authed-proxy poll endpoint to match a preview to a run, and by the 5-min preview-reaper to scope idle/ceiling reaps to engineer previews only.';

create or replace function set_engineer_sandbox_preview(
  p_id uuid,
  p_url text,
  p_port int,
  p_status text,
  p_run_id text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.tenant_sandbox
  set preview_url        = p_url,
      preview_port       = p_port,
      preview_status     = p_status,
      preview_run_id     = p_run_id,
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
revoke all on function set_engineer_sandbox_preview(uuid, text, int, text, text) from public;
grant execute on function set_engineer_sandbox_preview(uuid, text, int, text, text) to service_role;

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
      preview_run_id = null,
      updated_at     = now()
  where id = p_id;
end $$;
revoke all on function clear_sandbox_preview(uuid, text) from public;
grant execute on function clear_sandbox_preview(uuid, text) to service_role;
