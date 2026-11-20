begin;
insert into tenants (id, slug, display_name, kind) values
  ('00000000-0000-0000-0000-00000000aaa1', 'tn-a', 'tn-a', 'test'),
  ('00000000-0000-0000-0000-00000000aaa2', 'tn-b', 'tn-b', 'test');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'founder@tn.test'),
  ('00000000-0000-0000-0000-0000000000c2', 'admin@tn.test'),
  ('00000000-0000-0000-0000-0000000000c3', 'outsider@tn.test');
insert into tenant_users (tenant_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000000c1', 'viewer'),
  ('00000000-0000-0000-0000-00000000aaa2', '00000000-0000-0000-0000-0000000000c1', 'member'),
  ('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000000c2', 'owner'),
  ('00000000-0000-0000-0000-00000000aaa2', '00000000-0000-0000-0000-0000000000c3', 'owner');
insert into agent_threads (id, tenant_id, agent_slug, user_id) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-00000000aaa1', 'operator', '00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-00000000aaa2', 'operator', '00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-00000000aaa2', 'operator', '00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-00000000aaa2', 'operator', '00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-0000000000d5', '00000000-0000-0000-0000-00000000aaa1', 'operator', '00000000-0000-0000-0000-0000000000c1');
insert into agent_runs (id, tenant_id, agent_slug, agent_definition_hash, trigger, status) values
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-00000000aaa2', 'operator', 'test', 'chat', 'success');
insert into agent_thread_messages (id, thread_id, tenant_id, sender_role, body, agent_run_id) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-00000000aaa1', 'assistant', 'A bad 1', null),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-00000000aaa1', 'assistant', 'A bad 2', null),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-00000000aaa2', 'assistant', 'B bad 1', null),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-00000000aaa2', 'assistant', 'B bad 2', null),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-00000000aaa2', 'assistant', 'B bad 3', null),
  ('00000000-0000-0000-0000-0000000000ee', '00000000-0000-0000-0000-0000000000d5', '00000000-0000-0000-0000-00000000aaa1', 'assistant', 'mixed', '00000000-0000-0000-0000-0000000000f2');

do $$ begin
  if (select count(*) from _team_note_message_ctx('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000000ee')) <> 0 then
    raise exception 'ctx accepted a message whose run is in another tenant';
  end if;
  if (select count(*) from _team_note_message_ctx('00000000-0000-0000-0000-00000000aaa2', '00000000-0000-0000-0000-0000000000e1')) <> 0 then
    raise exception 'ctx resolved a tenant-A message under tenant B';
  end if;
  if (team_note_offer('00000000-0000-0000-0000-00000000aaa2', '00000000-0000-0000-0000-0000000000e1',
      'run_end', 'other', array['run_failed'], '0123456789abcdef', 'x')->>'offered')::boolean then
    raise exception 'offer accepted a message from another tenant';
  end if;
end $$;

select team_note_offer_v2('00000000-0000-0000-0000-00000000aaa1', id, 'run_end', 'tool_failure', array['tool_repeat_failure'], '0123456789abcdef', 'note', 'strip', id)
  from agent_thread_messages where id in ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e2');
select team_note_offer_v2('00000000-0000-0000-0000-00000000aaa2', id, 'run_end', 'tool_failure', array['tool_repeat_failure'], '0123456789abcdef', 'note', 'strip', id)
  from agent_thread_messages where id in ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b3');
do $$ begin
  if (select count(*) from team_note_offers where shown_at is not null) <> 0 then
    raise exception 'drafting counted as shown';
  end if;
end $$;

do $$ begin
  if not team_note_claim_judgement('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000000e1', 'run_end', array['run_failed']) then
    raise exception 'first claim refused';
  end if;
  if team_note_claim_judgement('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000000e1', 'correction', array['founder_correction']) then
    raise exception 'second claim allowed';
  end if;
end $$;

do $$ begin
  perform team_note_mark_shown('00000000-0000-0000-0000-00000000aaa2', '00000000-0000-0000-0000-0000000000c1', id, 1, 24, 3, 2)
    from agent_thread_messages where id in ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b3');
  if (select count(*) from team_note_offers where tenant_id = '00000000-0000-0000-0000-00000000aaa2' and status = 'shown') <> 3 then
    raise exception 'tenant B did not show 3';
  end if;
end $$;

do $$ begin
  if not (team_note_mark_shown('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000000c1',
          '00000000-0000-0000-0000-0000000000e1', 1, 24, 3, 2)->>'show')::boolean then
    raise exception 'tenant B activity blocked tenant A';
  end if;
  if (team_note_mark_shown('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000000c1',
      '00000000-0000-0000-0000-0000000000e2', 1, 24, 3, 2)->>'reason') <> 'thread_cap' then
    raise exception 'thread cap not enforced';
  end if;
end $$;

do $$ begin
  perform team_note_send('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000000c2',
    '00000000-0000-0000-0000-0000000000e1', 'note', null, 180);
  raise exception 'owner sent on another user''s chat';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform team_note_send('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000000c3',
    '00000000-0000-0000-0000-0000000000e1', 'note', null, 180);
  raise exception 'outsider sent';
exception when insufficient_privilege then null; end $$;

select team_note_send('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000000c1',
  '00000000-0000-0000-0000-0000000000e1', 'The ads tool failed twice.', null, 730);
select team_note_send('00000000-0000-0000-0000-00000000aaa2', '00000000-0000-0000-0000-0000000000c1',
  '00000000-0000-0000-0000-0000000000b1', 'B failed.', null, 181);
do $$ begin
  if exists (select 1 from team_reports where expires_at > now() + interval '180 days') then
    raise exception 'retention exceeded 180 days';
  end if;
  if (select count(*) from team_report_pings) <> 2
     or (select count(distinct tenant_id) from team_report_pings) <> 2 then
    raise exception 'send did not enqueue one ping per tenant window';
  end if;
end $$;

insert into agent_threads (id, tenant_id, agent_slug, user_id) values
  ('00000000-0000-0000-0000-0000000000d6', '00000000-0000-0000-0000-00000000aaa2', 'operator', '00000000-0000-0000-0000-0000000000c1');
insert into agent_thread_messages (id, thread_id, tenant_id, sender_role, body, agent_run_id) values
  ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000d6', '00000000-0000-0000-0000-00000000aaa2', 'assistant', 'B bad 4', null);
select team_note_offer_v2('00000000-0000-0000-0000-00000000aaa2', '00000000-0000-0000-0000-0000000000b4', 'run_end', 'other', array['run_failed'], '0123456789abcdef', 'note', 'strip', '00000000-0000-0000-0000-0000000000b4');
do $$ declare r jsonb; begin
  if (team_note_dismiss('00000000-0000-0000-0000-00000000aaa2', '00000000-0000-0000-0000-0000000000c1',
      '00000000-0000-0000-0000-0000000000b2', false)->>'status') <> 'dismissed' then
    raise exception 'dismiss of a shown strip failed';
  end if;
  perform team_note_dismiss('00000000-0000-0000-0000-00000000aaa2', '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000000b3', false);
  if (team_note_dismiss('00000000-0000-0000-0000-00000000aaa2', '00000000-0000-0000-0000-0000000000c1',
      '00000000-0000-0000-0000-0000000000b3', false)->>'status') <> 'closed' then
    raise exception 'second dismiss of the same strip was not closed';
  end if;
  r := team_note_mark_shown('00000000-0000-0000-0000-00000000aaa2', '00000000-0000-0000-0000-0000000000c1',
         '00000000-0000-0000-0000-0000000000b4', 1, 24, 10, 2);
  if not (r->>'show')::boolean or not (r->>'offer_stop')::boolean or not (r->>'first')::boolean then
    raise exception 'two dismissals in a row did not offer stop: %', r;
  end if;
  r := team_note_mark_shown('00000000-0000-0000-0000-00000000aaa2', '00000000-0000-0000-0000-0000000000c1',
         '00000000-0000-0000-0000-0000000000b4', 1, 24, 10, 2);
  if (r->>'first')::boolean or not (r->>'offer_stop')::boolean then
    raise exception 're-show was not idempotent: %', r;
  end if;
  if (select meta->>'team_note_state' from agent_thread_messages where id = '00000000-0000-0000-0000-0000000000b4') <> 'shown' then
    raise exception 'meta state not shown';
  end if;
end $$;

do $$ declare r1 jsonb; r2 jsonb; begin
  r1 := team_note_send('00000000-0000-0000-0000-00000000aaa2', '00000000-0000-0000-0000-0000000000c1',
          '00000000-0000-0000-0000-0000000000b4', 'Edited.', 'extra', 180);
  r2 := team_note_send('00000000-0000-0000-0000-00000000aaa2', '00000000-0000-0000-0000-0000000000c1',
          '00000000-0000-0000-0000-0000000000b4', 'Edited.', 'extra', 180);
  if (r1->>'report_id') is distinct from (r2->>'report_id') or (r2->>'first')::boolean then
    raise exception 'send not idempotent: % %', r1, r2;
  end if;
  if not (select note_edited from team_reports where id = (r1->>'report_id')::uuid) then
    raise exception 'edited note not flagged';
  end if;
end $$;

update team_reports set expires_at = now() - interval '1 minute'
 where message_id = '00000000-0000-0000-0000-0000000000b4';
do $$ declare r jsonb; begin
  r := purge_expired_team_notes(100, 400);
  if (r->>'deleted')::int < 1 or (r->>'backlog')::int <> 0 then
    raise exception 'purge did not remove the expired report: %', r;
  end if;
end $$;

select team_note_set_suggestions('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000000c1', true);
select team_note_set_suggestions('00000000-0000-0000-0000-00000000aaa2', '00000000-0000-0000-0000-0000000000c1', false);

delete from agent_threads where id = '00000000-0000-0000-0000-0000000000d1';
do $$ begin
  if (select count(*) from team_reports where tenant_id = '00000000-0000-0000-0000-00000000aaa1'
        and thread_id is null and message_id is null) <> 1 then
    raise exception 'report did not survive chat deletion with nulled links';
  end if;
end $$;

insert into agent_threads (id, tenant_id, agent_slug, user_id) values
  ('00000000-0000-0000-0000-0000000000da', '00000000-0000-0000-0000-00000000aaa1', 'operator', '00000000-0000-0000-0000-0000000000c1');
insert into agent_thread_messages (id, thread_id, tenant_id, sender_role, body, agent_run_id) values
  ('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000000da', '00000000-0000-0000-0000-00000000aaa1', 'assistant', 'q1', null),
  ('00000000-0000-0000-0000-0000000001a2', '00000000-0000-0000-0000-0000000000da', '00000000-0000-0000-0000-00000000aaa1', 'assistant', 'q2', null),
  ('00000000-0000-0000-0000-0000000001a3', '00000000-0000-0000-0000-0000000000da', '00000000-0000-0000-0000-00000000aaa1', 'assistant', 'q3', null),
  ('00000000-0000-0000-0000-0000000001a4', '00000000-0000-0000-0000-0000000000da', '00000000-0000-0000-0000-00000000aaa1', 'assistant', 'q4', null),
  ('00000000-0000-0000-0000-0000000001f1', '00000000-0000-0000-0000-0000000000da', '00000000-0000-0000-0000-00000000aaa1', 'user', 'no, wrong', null);
update team_note_prefs set suggestions_off = false where tenant_id = '00000000-0000-0000-0000-00000000aaa1';
do $$
declare r jsonb;
begin
  perform team_note_offer_v2('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000001a1',
    'run_end', 'other', array['run_failed'], '0123456789abcdef', 'n1', 'strip', '00000000-0000-0000-0000-0000000001a1');
  perform team_note_offer_v2('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000001a2',
    'run_end', 'other', array['run_failed'], '0123456789abcdef', 'n2', 'strip', '00000000-0000-0000-0000-0000000001a2');
  perform team_note_offer_v2('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000001a3',
    'run_end', 'other', array['tool_repeat_failure'], '0123456789abcdef', 'n3', 'flag', null);
  begin
    perform team_note_offer_v2('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000001a3',
      'run_end', 'other', array['run_failed'], '0123456789abcdef', 'n', 'strip', null);
    raise exception 'a strip without an anchor was accepted';
  exception when invalid_parameter_value then null; end;

  perform team_note_offer('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000001a4',
    'run_end', 'other', array['tool_repeat_failure'], '0123456789abcdef', 'n4');
  if (select surface from team_note_offers where message_id = '00000000-0000-0000-0000-0000000001a4') <> 'flag' then
    raise exception 'v1 offer drafted a strip';
  end if;
  r := team_note_mark_shown('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000001a4', 9, 24, 9, 1);
  if r->>'reason' is distinct from 'flag_only' then raise exception 'v1 show displayed a flag as a strip: %', r; end if;

  r := team_note_mark_shown_v2('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000001a3', 1, 24, 1, 1, 'strip');
  if r->>'reason' is distinct from 'flag_only' then raise exception 'strip shown for a flag-only note: %', r; end if;

  r := team_note_mark_shown_v2('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000001a1', 1, 24, 1, 1, 'strip');
  if not (r->>'show')::boolean then raise exception 'first run_end strip refused: %', r; end if;
  r := team_note_mark_shown_v2('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000001a2', 1, 24, 1, 1, 'strip');
  if (r->>'show')::boolean then raise exception 'second run_end strip was not capped'; end if;

  r := team_note_mark_shown_v2('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000001a3', 1, 24, 1, 1, 'flag');
  if not (r->>'show')::boolean or r->>'via' <> 'flag' then raise exception 'flag refused under the cap: %', r; end if;

  r := team_note_promote_v2('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000001a2',
    '00000000-0000-0000-0000-0000000001f1', array['founder_correction']);
  if not (r->>'promoted')::boolean or r->>'status' <> 'drafted' then raise exception 'suppressed note not revived: %', r; end if;
  r := team_note_mark_shown_v2('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000001a2', 1, 24, 1, 1, 'strip');
  if not (r->>'show')::boolean then raise exception 'pushback strip was capped: %', r; end if;

  r := team_note_mark_shown_v2('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000001a3', 1, 24, 1, 1, 'strip');
  if r->>'reason' is distinct from 'flag_only' then raise exception 'opened flag came back as a strip: %', r; end if;

  perform team_note_promote_v2('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000001a1',
    '00000000-0000-0000-0000-0000000001f1', array['founder_correction']);
  if (select capped_as from team_note_offers where message_id = '00000000-0000-0000-0000-0000000001a1') is distinct from 'run_end_strip' then
    raise exception 'promote freed the cap';
  end if;

  perform team_note_promote_v2('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000001a3',
    '00000000-0000-0000-0000-0000000001f1', array['founder_correction']);
  if (select shown_via from team_note_offers where message_id = '00000000-0000-0000-0000-0000000001a3') <> 'flag' then
    raise exception 'shown_via changed';
  end if;

  if (team_note_promote_v2('00000000-0000-0000-0000-00000000aaa2', '00000000-0000-0000-0000-0000000001a1',
      '00000000-0000-0000-0000-0000000001f1', '{}')->>'reason') <> 'not_found' then
    raise exception 'promote crossed tenants';
  end if;
  if team_note_claim_judgement_v2('00000000-0000-0000-0000-00000000aaa2', '00000000-0000-0000-0000-0000000001a1',
      'run_end', '{}', false) <> 'not_found' then
    raise exception 'claim crossed tenants';
  end if;
  if team_note_record_judgement_v2('00000000-0000-0000-0000-00000000aaa2', '00000000-0000-0000-0000-0000000001a1',
      'run_end', '{}', 'no', null, null) then
    raise exception 'judgement recorded across tenants';
  end if;
  perform team_note_record_judgement_v2('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000001a1',
    'run_end', array['run_failed'], 'bad', 'other', 'strip');
end $$;
update team_note_prefs set suggestions_off = true where tenant_id = '00000000-0000-0000-0000-00000000aaa1';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{"active_tenant_id":"00000000-0000-0000-0000-00000000aaa1"}}', true);
do $$ begin
  perform count(*) from team_note_offers;
  raise exception 'ledger readable by authenticated';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform count(*) from team_note_judge_claims;
  raise exception 'claims readable by authenticated';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform count(*) from team_note_judgements;
  raise exception 'judgements readable by authenticated';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform count(*) from team_report_pings;
  raise exception 'pings readable by authenticated';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform count(*) from team_note_offer_summary(7);
  raise exception 'authenticated could read the staff summary';
exception when insufficient_privilege then null; end $$;
do $$ begin
  if (select count(*) from team_reports) <> 1 then raise exception 'creator cannot read own report in active tenant A'; end if;
  if (select count(*) from team_note_prefs) <> 1 then raise exception 'prefs: expected only tenant A row while A is active'; end if;
  if (select bool_and(suggestions_off) from team_note_prefs) is not true then raise exception 'prefs: wrong A row'; end if;
end $$;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{"active_tenant_id":"00000000-0000-0000-0000-00000000aaa2"}}', true);
do $$ begin
  if (select count(*) from team_note_prefs) <> 1 or (select bool_or(suggestions_off) from team_note_prefs) then
    raise exception 'prefs: active-tenant switch leaked tenant A row';
  end if;
  if (select count(*) from team_reports where tenant_id = '00000000-0000-0000-0000-00000000aaa1') <> 0 then
    raise exception 'reports: tenant A visible while B active';
  end if;
end $$;
reset role;
delete from tenant_users where tenant_id = '00000000-0000-0000-0000-00000000aaa2' and user_id = '00000000-0000-0000-0000-0000000000c1';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{"active_tenant_id":"00000000-0000-0000-0000-00000000aaa2"}}', true);
do $$ begin
  if (select count(*) from team_note_prefs) <> 0 then raise exception 'prefs readable after membership revoked'; end if;
  if (select count(*) from team_reports) <> 0 then raise exception 'reports readable after membership revoked'; end if;
end $$;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c2","app_metadata":{"active_tenant_id":"00000000-0000-0000-0000-00000000aaa1"}}', true);
do $$ begin
  if (select count(*) from team_reports) <> 0 then raise exception 'tenant owner read a member report'; end if;
end $$;
do $$ begin
  perform team_note_set_suggestions('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000000c2', true);
  raise exception 'authenticated could execute an RPC';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform team_note_promote_v2('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000001a1',
    '00000000-0000-0000-0000-0000000001f1', '{}');
  raise exception 'authenticated could execute a v2 RPC';
exception when insufficient_privilege then null; end $$;
rollback;
