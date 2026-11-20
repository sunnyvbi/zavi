
begin;

alter table growth_plan_bets
  add column if not exists sort_order int not null default 100;

update growth_plan_bets
   set sort_order = 100 - least(greatest(priority, 0), 100)
 where sort_order = 100;

drop index if exists growth_plan_bets_plan_idx;
create index if not exists growth_plan_bets_plan_idx
  on growth_plan_bets (plan_id, status, sort_order);

alter table growth_plan_bets drop column if exists priority;

comment on column growth_plan_bets.sort_order is
  'Ascending, lower = more important — same polarity as tenant_channels.priority '
  'and tenant_channels.plan_sort_order. Derived from the accepted payload''s array '
  'position at commit time, never taken from a model-supplied number, so the model '
  'cannot hand back an order that contradicts its own list.';

alter table tenant_channels
  add column if not exists plan_selected   boolean not null default false,
  add column if not exists plan_sort_order int,
  add column if not exists autorun         boolean not null default false,
  add column if not exists autorun_set_by  text
    check (autorun_set_by is null or autorun_set_by in ('plan', 'founder'));

comment on column tenant_channels.plan_selected is
  'The live growth plan chose this channel. Set only by commit_growth_plan.';
comment on column tenant_channels.autorun is
  'The founder permits unattended runs on this channel. A re-accept never flips '
  'this back on once a founder has turned it off — see autorun_set_by.';

create index if not exists tenant_channels_autorun_idx
  on tenant_channels (tenant_id, plan_selected, autorun, plan_sort_order);

drop function if exists set_growth_plan_bet(uuid, uuid, uuid, text, text, text, text, text, text, int, text, text);

create or replace function set_growth_plan_bet(
  p_tenant_id       uuid,
  p_plan_id         uuid,
  p_bet_id          uuid,
  p_channel_slug    text,
  p_intent          text,
  p_expected_effect text,
  p_falsifier       text,
  p_status          text,
  p_rejected_reason text,
  p_sort_order      int,
  p_actor_kind      text,
  p_actor_ref       text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id              uuid;
  v_prev_st         text;
  v_prev_reason     text;
  v_prev_sort_order int;
begin
  if p_bet_id is null then
    if not exists (
      select 1 from growth_plan
      where id = p_plan_id and tenant_id = p_tenant_id
    ) then
      return null;
    end if;

    insert into growth_plan_bets (
      plan_id, tenant_id, channel_slug, intent, expected_effect,
      falsifier, status, rejected_reason, sort_order
    ) values (
      p_plan_id, p_tenant_id, p_channel_slug, p_intent, p_expected_effect,
      p_falsifier, coalesce(p_status, 'proposed'), p_rejected_reason,
      coalesce(p_sort_order, 100)
    ) returning id into v_id;

    perform log_growth_plan_change(
      p_tenant_id, p_plan_id, 'bet', v_id, 'created',
      null, p_intent, p_actor_kind, p_actor_ref, null
    );
    return v_id;
  end if;

  select status, rejected_reason, sort_order
    into v_prev_st, v_prev_reason, v_prev_sort_order
    from growth_plan_bets
    where id = p_bet_id and tenant_id = p_tenant_id;
  if not found then
    return null;
  end if;

  update growth_plan_bets
    set status          = coalesce(p_status, status),
        rejected_reason = coalesce(p_rejected_reason, rejected_reason),
        sort_order      = coalesce(p_sort_order, sort_order),
        updated_at      = now()
    where id = p_bet_id and tenant_id = p_tenant_id;

  if p_status is not null and p_status is distinct from v_prev_st then
    perform log_growth_plan_change(
      p_tenant_id, p_plan_id, 'bet', p_bet_id, 'status',
      v_prev_st, p_status, p_actor_kind, p_actor_ref, p_rejected_reason
    );
  end if;

  if p_rejected_reason is not null
     and p_rejected_reason is distinct from v_prev_reason then
    perform log_growth_plan_change(
      p_tenant_id, p_plan_id, 'bet', p_bet_id, 'rejected_reason',
      v_prev_reason, p_rejected_reason, p_actor_kind, p_actor_ref, null
    );
  end if;

  if p_sort_order is not null and p_sort_order is distinct from v_prev_sort_order then
    perform log_growth_plan_change(
      p_tenant_id, p_plan_id, 'bet', p_bet_id, 'sort_order',
      v_prev_sort_order::text, p_sort_order::text, p_actor_kind, p_actor_ref, null
    );
  end if;

  return p_bet_id;
end $$;

revoke all on function set_growth_plan_bet(uuid, uuid, uuid, text, text, text, text, text, text, int, text, text) from public, anon, authenticated;

commit;
