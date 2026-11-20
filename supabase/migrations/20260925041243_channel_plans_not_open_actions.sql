
create or replace view public.customer_visible_open_channel_actions
with (security_invoker = true) as
  select a.*
  from public.channel_actions a
  where (
    a.status = 'pending'
    or (a.status = 'snoozed' and (a.snoozed_until is null or a.snoozed_until <= now()))
  )
  and coalesce(a.body->'step'->'deliverable'->>'kind', '') <> 'strategy';

comment on view public.customer_visible_open_channel_actions is
  'Single source of truth for "a channel action the founder still needs to see": pending, or snoozed past its date, and not a channel plan (deliverable kind strategy, shown above the list, never a card). Every customer-facing count reads THIS, never a hand-rolled status filter. Mirrors isOpenAction in services/channels/rank-actions.ts plus isPlanBody in services/channels/channel-actions.ts.';

grant select on public.customer_visible_open_channel_actions to authenticated, service_role;
