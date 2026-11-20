
begin;

create or replace function public.site_shard_placement_pause_unless_held(
  p_id             uuid,
  p_reason         text,
  p_adopt_prefixes text[]
) returns table (taken boolean, held_reason text)
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_row    public.site_shards;
  v_active boolean;
begin
  if p_id is null or p_reason is null or length(p_reason) = 0 or length(p_reason) > 300 then
    raise exception 'site_shard_placement_pause_unless_held: id and a 1..300 char reason are required' using errcode = '22023';
  end if;
  select * into v_row from public.site_shards s where s.id = p_id for update;
  if not found then
    raise exception 'site_shard_placement_pause_unless_held: shard % not found', p_id using errcode = 'P0002';
  end if;
  v_active := v_row.placement_paused_until is not null and v_row.placement_paused_until > now();
  if v_active
     and v_row.placement_paused_reason is distinct from p_reason
     and not exists (
       select 1 from unnest(coalesce(p_adopt_prefixes, array[]::text[])) as p(prefix)
        where length(p.prefix) > 0
          and left(coalesce(v_row.placement_paused_reason, ''), length(p.prefix)) = p.prefix
     ) then
    return query select false, coalesce(nullif(v_row.placement_paused_reason, ''), '(no reason)');
    return;
  end if;
  update public.site_shards s set
    placement_paused_until  = 'infinity'::timestamptz,
    placement_paused_reason = p_reason,
    placement_paused_at     = case when v_active and v_row.placement_paused_reason is not distinct from p_reason
                                   then coalesce(v_row.placement_paused_at, now()) else now() end,
    updated_at              = now()
  where s.id = p_id;
  return query select true, null::text;
end $$;

revoke all on function public.site_shard_placement_pause_unless_held(uuid, text, text[]) from public, anon, authenticated;
grant execute on function public.site_shard_placement_pause_unless_held(uuid, text, text[]) to service_role;

commit;
