
update public.system_config
set blob = jsonb_set(blob, '{higgsfield_user_id}', '"user_3C5XiWGs3xWTIgbbKg3NAfyoIrR"'::jsonb)
where id = 1 and not (blob ? 'higgsfield_user_id');

update public.system_config
set blob = jsonb_set(blob, '{higgsfield_workspace_id}', '"1d851b1d-0640-4283-a652-4f5e2b5dd5ce"'::jsonb)
where id = 1 and not (blob ? 'higgsfield_workspace_id');
