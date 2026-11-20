begin;

create or replace function public._email_member_edit_untested(p_tenant_id uuid, p_rail text, p_id uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c record;
begin
  select * into c from public._email_card(p_tenant_id, p_rail, p_id, false);
  if not coalesce(c.o_found, false) or not (c.o_body ? 'member_edited_by') then
    return false;
  end if;
  if jsonb_typeof(c.o_body->'member_edited_variants') = 'array'
     and not (c.o_body->'member_edited_variants' @> '[1]'::jsonb) then
    return false;
  end if;
  return not exists (
    select 1 from email_test_sends t
      join tenant_users tu on tu.tenant_id = t.tenant_id and tu.user_id = t.user_id
     where t.tenant_id = p_tenant_id and t.rail = p_rail and t.card_id = p_id and t.variant = 1
       and t.test_sha = public.email_card_test_sha(c.o_body, 1)
       and tu.role in ('owner', 'admin'));
end $$;
revoke all on function public._email_member_edit_untested(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public._email_member_edit_untested(uuid, text, uuid) to service_role;

create or replace function public.edit_email_card_variant(
  p_tenant_id     uuid,
  p_rail          text,
  p_id            uuid,
  p_variant       int,
  p_user_id       uuid,
  p_expected_body jsonb,
  p_sealed        jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c record;
  v_n int;
  v_body jsonb;
  v_rv text;
  v_rows int;
  v_role text;
begin
  if p_tenant_id is null or p_id is null or p_user_id is null or p_rail not in ('channel_actions', 'decisions') then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select role into v_role from tenant_users where tenant_id = p_tenant_id and user_id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_role is null or v_role not in ('owner', 'admin', 'member') then
    return jsonb_build_object('ok', false, 'code', 'not_authorized');
  end if;
  select * into c from public._email_card(p_tenant_id, p_rail, p_id, true);
  if not c.o_found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  v_n := public._email_card_versions(c.o_body);
  if v_n = 0 then return jsonb_build_object('ok', false, 'code', 'redraft_required'); end if;
  if not c.o_open or c.o_status = 'failed' then
    return jsonb_build_object('ok', false, 'code', 'not_open', 'status', c.o_status);
  end if;
  if p_variant is null or p_variant < 1 or p_variant > v_n then
    return jsonb_build_object('ok', false, 'code', 'bad_variant');
  end if;
  if exists (select 1 from email_planned_sends s
              where s.tenant_id = p_tenant_id and s.card_rail = p_rail and s.card_id = p_id and s.status = 'scheduled') then
    return jsonb_build_object('ok', false, 'code', 'scheduled_send_pending');
  end if;
  if p_expected_body is null or c.o_body <> p_expected_body then
    return jsonb_build_object('ok', false, 'code', 'card_changed');
  end if;
  if jsonb_typeof(p_sealed) = 'object' and jsonb_typeof(p_sealed->'content') = 'object'
     and (not public._email_one_line(p_sealed->'content'->>'subject')
          or not public._email_one_line(p_sealed->'content'->>'preview_text')) then
    return jsonb_build_object('ok', false, 'code', 'bad_content',
      'message', 'The subject and the preview text must each be on one line: remove the line break or hidden character.');
  end if;
  v_rv := c.o_body->>'renderer_version';
  if jsonb_typeof(p_sealed) <> 'object' or jsonb_typeof(p_sealed->'content') <> 'object'
     or coalesce(p_sealed->>'html', '') = '' or coalesce(p_sealed->>'text', '') = ''
     or coalesce(p_sealed->>'render_sha', '') !~ '^[0-9a-f]{64}$'
     or encode(sha256(convert_to(coalesce(v_rv, ''), 'UTF8') || '\x00'::bytea || convert_to(p_sealed->>'html', 'UTF8')
                      || '\x00'::bytea || convert_to(p_sealed->>'text', 'UTF8')), 'hex') <> p_sealed->>'render_sha' then
    return jsonb_build_object('ok', false, 'code', 'bad_variant');
  end if;
  v_body := jsonb_set(c.o_body, array['variants', (p_variant - 1)::text], p_sealed)
            || jsonb_build_object('edited_by', p_user_id, 'edited_at', now())
            || case when v_role in ('owner', 'admin') then '{}'::jsonb
                    else jsonb_build_object('member_edited_by', p_user_id, 'member_edited_at', now(),
                                            'member_edited_variants',
                                            case when jsonb_typeof(c.o_body->'member_edited_variants') = 'array'
                                                   then case when c.o_body->'member_edited_variants' @> to_jsonb(array[p_variant])
                                                             then c.o_body->'member_edited_variants'
                                                             else c.o_body->'member_edited_variants' || to_jsonb(p_variant) end
                                                 when c.o_body ? 'member_edited_by' then
                                                   case when p_variant = 1 then '[1]'::jsonb else jsonb_build_array(1, p_variant) end
                                                 else jsonb_build_array(p_variant) end) end;
  if p_rail = 'channel_actions' then
    update channel_actions set exec_payload = v_body where id = p_id and exec_status is null and approved_by is null;
  else
    update decisions set body = v_body where id = p_id and status = 'proposed' and approved_by is null;
  end if;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return jsonb_build_object('ok', false, 'code', 'not_open'); end if;
  return jsonb_build_object('ok', true, 'test_sha', public.email_card_test_sha(v_body, p_variant));
end $$;
revoke all on function public.edit_email_card_variant(uuid, text, uuid, int, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.edit_email_card_variant(uuid, text, uuid, int, uuid, jsonb, jsonb) to service_role;

commit;
