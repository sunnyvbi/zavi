select count(*) as dead_letter_count
  from decisions
 where status = 'rejected'
   and dispatch_handler in ('gmail.send', 'email.send')
   and (
     dispatch_error ilike '%not yet wired%'
     or dispatch_error ilike '%no registered handler%'
   );

