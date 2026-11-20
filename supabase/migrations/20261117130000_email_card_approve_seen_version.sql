create or replace function public.approve_email_card_seen(
  p_tenant_id         uuid,
  p_rail              text,
  p_id                uuid,
  p_variant           int,
  p_actor_user_id     uuid,
  p_event_key         text,
  p_approved_count    int,
  p_expected_variant  jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pre record;
  c     record;
begin
  select * into v_pre from public._email_card(p_tenant_id, p_rail, p_id, false);
  if coalesce(v_pre.o_found, false)
     and exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor_user_id) then
    perform public._email_test_list_marked(p_tenant_id, public._email_test_list_key(v_pre.o_class, v_pre.o_body));
    select * into c from public._email_card(p_tenant_id, p_rail, p_id, true);
    if coalesce(c.o_found, false)
       and (p_expected_variant is null or p_variant is null or p_variant < 1
            or (c.o_body->'variants'->(p_variant - 1)) is distinct from p_expected_variant) then
      return jsonb_build_object('ok', false, 'code', 'version_changed');
    end if;
  end if;
  return public.approve_email_card(p_tenant_id, p_rail, p_id, p_variant, p_actor_user_id, p_event_key, p_approved_count);
end $$;
revoke all on function public.approve_email_card_seen(uuid, text, uuid, int, uuid, text, int, jsonb) from public, anon, authenticated;
grant execute on function public.approve_email_card_seen(uuid, text, uuid, int, uuid, text, int, jsonb) to service_role;
