
insert into decision_classes (slug, description, default_autonomy, dispatch_handler)
values (
  'cgo.dispatch-specialist',
  'cgo hands one move toward a founder goal to a specialist agent. Approved inline on the Growth page; approving enqueues the target agent via praxis.dispatch_specialist.',
  'approval',
  'praxis.dispatch_specialist'
)
on conflict (slug) do nothing;

update decision_classes
   set never_auto = true,
       target_key_paths = array['goal_id', 'goal_rev', 'target_agent_slug'],
       single_open_per_target = true
 where slug = 'cgo.dispatch-specialist';

create or replace view public.customer_visible_pending_decisions
with (security_invoker = true) as
  select d.*
  from public.decisions d
  where d.status = 'proposed'
    and d.autonomy_at_emit = 'approval'
    and (d.snoozed_until is null or d.snoozed_until <= now())
    and d.decision_class <> all (array['cgo.dispatch-specialist']);
