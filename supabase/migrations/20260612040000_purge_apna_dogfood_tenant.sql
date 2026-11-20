
do $$
begin
  if exists (
    select 1 from tenants
    where id = '5f05d826-7793-45d1-88f9-c5c5bb3f0347'
      and slug = 'apna-tutor-dogfood'
      and kind = 'test'
  ) then
    alter table admin_action_log        disable trigger admin_action_log_worm;
    alter table autopilot_action_ledger disable trigger autopilot_action_ledger_worm;

    delete from tenants
      where id = '5f05d826-7793-45d1-88f9-c5c5bb3f0347'
        and slug = 'apna-tutor-dogfood'
        and kind = 'test';

    alter table admin_action_log        enable trigger admin_action_log_worm;
    alter table autopilot_action_ledger enable trigger autopilot_action_ledger_worm;

    raise notice 'purged tenant apna-tutor-dogfood (5f05d826) + cascade';
  else
    raise notice 'apna-tutor-dogfood (5f05d826) not present as kind=test — no-op';
  end if;
end $$;
