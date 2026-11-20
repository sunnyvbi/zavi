
alter table public.tenant_sandbox
  add column if not exists preview_path text,
  add column if not exists preview_outcome text,
  add column if not exists preview_off_target_reason text;

comment on column public.tenant_sandbox.preview_path is
  'Deep-link route the ENGINEER preview should open (e.g. /tutor/bookings) — the screen the run''s diff actually changed. Sourced agent-emitted-first, then heuristically derived from the diff''s page files; NULL when no single route is derivable (component-only/styling/refactor diffs, or a dynamic [id] segment we refuse to fabricate an ID for). Sanitized to a root-relative pathname+search at BOTH the write and read seams — it is agent-authored text that becomes an iframe src on a first-party origin. NULL ⇒ the preview opens the app root.';

comment on column public.tenant_sandbox.preview_outcome is
  'Did we VERIFY the preview rendered the screen the PR changed? on_target = a marker derived from the diff was found in the rendered body. off_target = we could not verify (auth redirect / route error / marker absent) ⇒ the UI shows NO iframe rather than a misleading root render. NULL = never probed, because preview_path is NULL (no route derivable) ⇒ the UI shows the app root with a neutral caption. NULL is a real third state, NOT a falsy alias for off_target.';

comment on column public.tenant_sandbox.preview_off_target_reason is
  'Bounded machine token explaining an off_target verdict, for OUR logs only — never a UI branch, never raw upstream output (auth_or_redirect|route_error|no_marker). Same whitelist discipline as preview_error. There is deliberately NO no_route token: a route-less run is NULL/never-probed, not off-target.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tenant_sandbox_preview_outcome_chk'
  ) then
    alter table public.tenant_sandbox
      add constraint tenant_sandbox_preview_outcome_chk
      check (preview_outcome is null or preview_outcome in ('on_target','off_target'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'tenant_sandbox_preview_off_target_reason_chk'
  ) then
    alter table public.tenant_sandbox
      add constraint tenant_sandbox_preview_off_target_reason_chk
      check (
        preview_off_target_reason is null
        or preview_off_target_reason in ('auth_or_redirect','route_error','no_marker')
      );
  end if;
end $$;

drop function if exists set_engineer_sandbox_preview(uuid, text, int, text, text);

create or replace function set_engineer_sandbox_preview(
  p_id uuid,
  p_url text,
  p_port int,
  p_status text,
  p_run_id text,
  p_path text default null,
  p_outcome text default null,
  p_off_target_reason text default null
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
      preview_path = case
        when p_status = 'starting' then left(p_path, 500)
        when p_path is not null then left(p_path, 500)
        else preview_path
      end,
      preview_outcome = case
        when p_status = 'starting' then null
        when p_outcome is not null then p_outcome
        else preview_outcome
      end,
      preview_off_target_reason = case
        when p_status = 'starting' then null
        when p_off_target_reason is not null then p_off_target_reason
        else preview_off_target_reason
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
revoke all on function set_engineer_sandbox_preview(uuid, text, int, text, text, text, text, text) from public;
grant execute on function set_engineer_sandbox_preview(uuid, text, int, text, text, text, text, text) to service_role;
