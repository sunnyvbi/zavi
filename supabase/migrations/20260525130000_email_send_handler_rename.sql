
begin;

update decision_classes
   set dispatch_handler = 'email.send',
       description = 'customer-support-inbox sends a reply to an incoming support email via the operator''s SendGrid connector. Body: { to, subject, body_text, body_html?, reply_to?, artifact_id? }. Handler: email.send.'
 where slug = 'customer-support-inbox.send-reply'
   and dispatch_handler = 'gmail.send';

commit;
