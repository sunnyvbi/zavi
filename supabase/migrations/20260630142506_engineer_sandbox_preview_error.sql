
alter table public.tenant_sandbox
  add column if not exists preview_error text;

comment on column public.tenant_sandbox.preview_error is
  'Bounded machine reason an ENGINEER preview boot ended dead (no_node_modules:<npm code>|boot_timeout:port_unbound|no_runnable_web_app|boot_error:<sanitized msg>). Whitelisted enum-like token, <=500 chars, NO raw logs/secrets/user content. Set via clear_sandbox_preview(p_preview_error) on the engineer-preview dead path; reset to NULL when a fresh engineer preview transitions starting/live via set_engineer_sandbox_preview. (The product-builder set_sandbox_preview path does not write this column.)';

drop function if exists clear_sandbox_preview(uuid, text);

create or replace function clear_sandbox_preview(
  p_id uuid,
  p_final_status text default 'swapped',
  p_preview_error text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.tenant_sandbox
  set preview_status = p_final_status,
      preview_url    = null,
      preview_port   = null,
      preview_run_id = null,
      preview_error  = case
        when p_preview_error is not null then left(p_preview_error, 500)
        else preview_error
      end,
      updated_at     = now()
  where id = p_id;
end $$;
revoke all on function clear_sandbox_preview(uuid, text, text) from public;
grant execute on function clear_sandbox_preview(uuid, text, text) to service_role;

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
      preview_error      = case
        when p_status in ('starting','live') then null
        else preview_error
      end,
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
