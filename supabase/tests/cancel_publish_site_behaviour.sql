begin;
insert into public.tenants (id, slug, display_name, kind) values
 ('00000000-0000-0000-0000-0000000ca001', 'cancel-publish-a', 'cancel-publish-a', 'test'),
 ('00000000-0000-0000-0000-0000000ca002', 'cancel-publish-b', 'cancel-publish-b', 'test');
insert into public.conductor_runs (id, tenant_id, objective, status, goal_graph) values
 ('00000000-0000-0000-0000-0000000cc001', '00000000-0000-0000-0000-0000000ca001', 'root', 'done', '[]'),
 ('00000000-0000-0000-0000-0000000cc002', '00000000-0000-0000-0000-0000000ca001', 'publish', 'active',
  '[{"payload":{"stage":"deploy","site_id":"00000000-0000-0000-0000-0000000ce001"}}]');
insert into public.sites (id, tenant_id, root_conductor_run_id, label, hostname, status) values
 ('00000000-0000-0000-0000-0000000ce001', '00000000-0000-0000-0000-0000000ca001', '00000000-0000-0000-0000-0000000cc001', 'cancel-publish-a', 'cancel-publish-a.zavi.app', 'publishing'),
 ('00000000-0000-0000-0000-0000000ce002', '00000000-0000-0000-0000-0000000ca002', null, 'cancel-publish-b', 'cancel-publish-b.zavi.app', 'publishing');
create function pg_temp.expect(p_ok boolean, p_label text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %', p_label; end if; end $$;
do $$
declare
 a constant uuid := '00000000-0000-0000-0000-0000000ca001';
 b constant uuid := '00000000-0000-0000-0000-0000000ca002';
 root_id constant uuid := '00000000-0000-0000-0000-0000000cc001';
 run_id constant uuid := '00000000-0000-0000-0000-0000000cc002';
 site_id constant uuid := '00000000-0000-0000-0000-0000000ce001';
 reason text; result jsonb; v_status text; v_error text;
begin
 foreach reason in array array['user_cancel', 'stale_slot_reap'] loop
   update public.conductor_runs set status='active', updated_at=now()-interval '2 hours' where id=run_id;
   update public.sites set status='publishing', live_deploy_id=null where id=site_id;
   result := public.cancel_conductor_run(a, run_id, reason, now()-interval '45 minutes');
   perform pg_temp.expect(result->>'ledger_id' is not null, reason || ': audit receipt returned');
   perform pg_temp.expect(exists(select 1 from pg_locks where locktype='advisory' and pid=pg_backend_pid() and granted), 'tenant slot remains locked through settlement');
   select status,last_error into v_status,v_error from public.sites where id=site_id;
   perform pg_temp.expect(result->>'cancelled' = 'true' and v_status = 'building' and length(v_error)>0, reason || ': unpublished publish recovers');
   update public.conductor_runs set status='active' where id=run_id;
   update public.sites set status='publishing', live_deploy_id='serving-deploy', live_sha='serving-sha', live_url='https://serving.example' where id=site_id;
   perform public.cancel_conductor_run(a, run_id, reason);
   perform pg_temp.expect((select status='live' and live_deploy_id='serving-deploy' and live_sha='serving-sha' and live_url='https://serving.example' from public.sites where id=site_id), reason || ': serving version survives');
 end loop;
 update public.sites set status='publishing', last_error=null where id=site_id;
 result := public.cancel_conductor_run(a, run_id);
 perform pg_temp.expect(result->>'cancelled'='false' and (select status='publishing' and last_error is null from public.sites where id=site_id), 'terminal cancellation is a no-op');
 update public.conductor_runs set status='active', updated_at=now() where id=run_id;
 result := public.cancel_conductor_run(a, run_id, 'stale_slot_reap', now()-interval '45 minutes');
 perform pg_temp.expect(result->>'cancelled'='false' and (select status='publishing' from public.sites where id=site_id), 'lost stale CAS does not settle');
 result := public.cancel_conductor_run(b, run_id);
 perform pg_temp.expect(result->>'ok'='false' and (select status='active' from public.conductor_runs where id=run_id), 'foreign run cannot be cancelled');
 update public.conductor_runs set goal_graph='[{"payload":{"site_id":"00000000-0000-0000-0000-0000000ce002"}}]' where id=run_id;
 perform public.cancel_conductor_run(a, run_id);
 perform pg_temp.expect((select status='publishing' from public.sites where tenant_id=b), 'foreign site pointer is tenant fenced');
 foreach reason in array array['[]', '{}', '[{"payload":{"site_id":"invalid"}}]', '[null]'] loop
   update public.conductor_runs set status='active', goal_graph=reason::jsonb where id=run_id;
   result := public.cancel_conductor_run(a, run_id);
   perform pg_temp.expect(result->>'cancelled'='true', 'old flow / malformed graph cancels');
 end loop;
 update public.conductor_runs set status='provisioning' where id=root_id;
 update public.sites set status='provisioning', live_deploy_id=null where id=site_id;
 perform public.cancel_conductor_run(a, root_id);
 perform pg_temp.expect((select status='failed' from public.sites where id=site_id), 'root provisioning fails');
 foreach v_status in array array['live', 'deleting', 'deleted', 'fell_back_old', 'paused'] loop
   update public.conductor_runs set status='active' where id=root_id;
   update public.sites set status=v_status where id=site_id;
   perform public.cancel_conductor_run(a, root_id);
   perform pg_temp.expect((select status=v_status from public.sites where id=site_id), 'preserve ' || v_status);
 end loop;
 perform pg_temp.expect(not has_function_privilege('anon', 'public.cancel_conductor_run(uuid,uuid,text,timestamptz)', 'EXECUTE'), 'anon denied');
 perform pg_temp.expect(not has_function_privilege('authenticated', 'public.cancel_conductor_run(uuid,uuid,text,timestamptz)', 'EXECUTE'), 'authenticated denied');
 perform pg_temp.expect(has_function_privilege('service_role', 'public.cancel_conductor_run(uuid,uuid,text,timestamptz)', 'EXECUTE'), 'service role allowed');
end $$;
update public.sites set status='publishing' where id='00000000-0000-0000-0000-0000000ce001';
create function pg_temp.reject_site_write() returns trigger language plpgsql as $$
begin raise exception 'injected_site_write_failure'; end $$;
create trigger cancel_publish_failure before update on public.sites for each row execute function pg_temp.reject_site_write();
do $$
declare result jsonb;
begin
 update public.conductor_runs set status='active' where id='00000000-0000-0000-0000-0000000cc001';
 begin
   perform public.cancel_conductor_run('00000000-0000-0000-0000-0000000ca001', '00000000-0000-0000-0000-0000000cc001');
   raise exception 'expected settlement write failure';
 exception when others then
   if sqlerrm <> 'injected_site_write_failure' then raise; end if;
 end;
 perform pg_temp.expect((select status='active' from public.conductor_runs where id='00000000-0000-0000-0000-0000000cc001'), 'site failure rolls back cancellation');
end $$;
rollback;
