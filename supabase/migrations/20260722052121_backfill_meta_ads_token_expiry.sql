
update connector_metadata
   set token_expires_at = connected_at + interval '60 days'
 where slug = 'meta_ads'
   and token_expires_at is null
   and connected_at is not null;
