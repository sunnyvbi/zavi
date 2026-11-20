create or replace function mint_inbox_handle_on_tenant_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.kind = 'launch_video_shell' then
    return null;
  end if;
  begin
    perform mint_inbox_handle(
      new.id,
      coalesce(nullif(btrim(new.display_name), ''), new.slug)
    );
  exception when others then
    raise warning 'inbox handle mint skipped for tenant %: %', new.id, sqlerrm;
  end;
  return null;
end $$;

revoke all on function mint_inbox_handle_on_tenant_insert() from public;
revoke all on function mint_inbox_handle_on_tenant_insert() from authenticated, anon;

drop trigger if exists tenants_mint_inbox_handle on tenants;
create trigger tenants_mint_inbox_handle
  after insert on tenants
  for each row
  execute function mint_inbox_handle_on_tenant_insert();

drop trigger if exists tenants_mint_inbox_handle_on_claim on tenants;
create trigger tenants_mint_inbox_handle_on_claim
  after update of kind on tenants
  for each row
  when (old.kind = 'launch_video_shell' and new.kind <> 'launch_video_shell')
  execute function mint_inbox_handle_on_tenant_insert();

do $$
declare t record;
begin
  for t in
    select id, display_name, slug
    from tenants
    where kind <> 'launch_video_shell'
      and not exists (
      select 1 from tenant_agent_email_identity i
      where i.tenant_id = tenants.id and i.status = 'active'
    )
  loop
    begin
      perform mint_inbox_handle(t.id, coalesce(nullif(btrim(t.display_name), ''), t.slug));
    exception when others then
      raise warning 'inbox handle backfill skipped for tenant %: %', t.id, sqlerrm;
    end;
  end loop;
end $$;
