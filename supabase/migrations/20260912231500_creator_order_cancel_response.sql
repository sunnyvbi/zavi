
begin;

alter table creator_orders
  add column if not exists status_before_cancel_request text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'creator_orders_status_before_cancel_request_check'
  ) then
    alter table creator_orders
      add constraint creator_orders_status_before_cancel_request_check
      check (
        status_before_cancel_request is null
        or status_before_cancel_request in ('in_progress', 'submitted', 'revision_requested')
      );
  end if;
end $$;

comment on column creator_orders.status_before_cancel_request is
  'Status the order held when the business requested cancellation. Restored verbatim if the creator declines or the business revokes (Collabstr: "the order will continue as normal"). Cleared on every exit from cancel_requested. NULL on rows predating this column, treated as in_progress.';

commit;
