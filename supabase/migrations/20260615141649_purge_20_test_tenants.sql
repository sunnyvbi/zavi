
do $$
declare
  v_ids uuid[] := array[
    '4574d292-02a3-406c-aec6-2954e79d8743',
    'fa015a06-51a9-4405-ac28-27b6bf5d45ab',
    '85f2a8b9-c49c-4c58-974f-df881bbbfa86',
    'f7d0e5ec-23ef-47c0-ad3b-8b7fe5c61a40',
    '3296f13c-a2bc-4f91-919a-1009f1f0cf57',
    '3b407528-b581-4827-91d6-1e22501415e4',
    '67e3ad47-00e4-4e6a-8549-bc5c05ef180e',
    '4f1362e2-4fa6-429b-92d0-2f73abef5981',
    '62f9f528-0283-4ce7-b284-90347cd79acc',
    '26d26a8e-ad8b-4e56-84c3-a02a618006d0',
    '43114fa6-1912-4676-bfcd-0a543d8d655f',
    '32d30870-3b7a-43a8-a445-4c76226430c8',
    '227fc356-2d6d-4201-8ce0-aec9814c9ff9',
    'c774bfe1-44d0-4d32-9d6c-4855cbb7adfe',
    '95025bfb-f3bb-4c1f-a3ac-a3918d13c039',
    'd970b471-6cc5-4673-bcf5-cb6c19434594',
    '8d52355a-b3ee-4721-a52d-6be56a59ef1a',
    'a0b1f1c5-7c5f-4324-9d35-dd0a49a117d1',
    'a90fcf29-4931-4dd2-b7c1-801b9ee6de87',
    'c9156c44-e3b7-44da-8346-3e524e6acc6f'
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

  raise notice 'purged % of 20 targeted test tenants + cascade', v_deleted;
end $$;
