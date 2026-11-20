
begin;

create or replace view public.customer_visible_deferred_decisions
with (security_invoker = true) as
  select d.*
  from public.decisions d
  where d.status = 'proposed'
    and d.autonomy_at_emit = 'approval'
    and d.snoozed_until > now();

comment on view public.customer_visible_deferred_decisions is
  'The exact complement of customer_visible_pending_decisions'' snooze clause: decisions the founder deferred whose date has not yet passed. Used to keep a deferral from being counted as finished work. Never a second definition of "open" — if the sibling view''s clause changes, this changes with it.';

grant select on public.customer_visible_deferred_decisions to authenticated, service_role;

create or replace view public.customer_visible_deferred_channel_actions
with (security_invoker = true) as
  select a.*
  from public.channel_actions a
  where a.status = 'snoozed'
    and a.snoozed_until > now();

comment on view public.customer_visible_deferred_channel_actions is
  'The exact complement of customer_visible_open_channel_actions'' snooze clause: channel actions the founder deferred whose date has not yet passed. Note this store has no separate archive — "Didn''t do it" also writes `snoozed` (CHANNEL_ACTION_VERB), so both founder ways of closing without doing land here.';

grant select on public.customer_visible_deferred_channel_actions to authenticated, service_role;

commit;

do $$
begin
  raise notice '20260919220000: deferred (snoozed-not-yet-due) views for both action stores';
end $$;
