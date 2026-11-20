
begin;

alter table tenant_feedback
  add column status text not null default 'received'
    check (status in ('received', 'working', 'done', 'wont_do')),
  add column staff_note text,
  add column status_updated_at timestamptz,
  add column sender_seen_at timestamptz;

drop policy if exists tenant_feedback_select on tenant_feedback;
create policy tenant_feedback_select on tenant_feedback for select to authenticated using (
  created_by = auth.uid()
  and tenant_id in (select tenant_id from tenant_users where user_id = auth.uid())
);

create or replace function mark_my_tenant_feedback_seen(p_tenant_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'unauthenticated';
  end if;
  if p_tenant_id is null or not exists (
    select 1 from tenant_users tu
    where tu.tenant_id = p_tenant_id and tu.user_id = v_user_id
  ) then
    raise exception 'unauthorized';
  end if;

  update tenant_feedback
     set sender_seen_at = now()
   where tenant_id = p_tenant_id
     and created_by = v_user_id
     and status_updated_at is not null
     and (sender_seen_at is null or sender_seen_at < status_updated_at);
end;
$$;

revoke all on function mark_my_tenant_feedback_seen(uuid) from public, anon, authenticated;
grant execute on function mark_my_tenant_feedback_seen(uuid) to authenticated;

commit;
