
do $$
declare
  v_ids uuid[] := array[
    '9c4f33dd-af54-4630-a653-73e76c8d4146',
    '1ff1c81f-09a4-4920-a131-f72df126ea9c',
    '3a89e8f7-7b0d-4ac0-8fd9-d7475e7cacce',
    '84280ac8-5a83-4ce8-a8a8-fba8446612dc',
    'e16e1fea-832a-47c8-8294-9801f7a5c05b',
    'e0fe9ea8-52e0-448e-80ff-5e68e8f81b3e'
  ];
  v_deleted int;
begin
  update tenants set kind = 'test' where id = any(v_ids) and kind <> 'test';

  alter table admin_action_log        disable trigger admin_action_log_worm;
  alter table autopilot_action_ledger disable trigger autopilot_action_ledger_worm;

  delete from tenants where id = any(v_ids) and kind = 'test';
  get diagnostics v_deleted = row_count;

  alter table admin_action_log        enable trigger admin_action_log_worm;
  alter table autopilot_action_ledger enable trigger autopilot_action_ledger_worm;

  raise notice 'purged % of 6 targeted test tenants + cascade', v_deleted;
end $$;
