
update public.decisions
   set status = 'dispatch_failed'
 where status = 'rejected'
   and dispatch_error is not null
   and dispatch_error <> ''
   and rejected_by is null;
