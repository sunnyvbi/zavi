begin;

update public.email_templates as t
   set postal_address = src.postal,
       updated_at = now()
  from (
    select distinct on (s.tenant_id)
           s.tenant_id,
           left(btrim(s.item), 500) as postal
      from public.channel_settings s
      join public.tenants tn on tn.id = s.tenant_id
     where s.channel_slug = 'email_marketing'
       and s.field_id = 'postal_address'
       and (s.status is null or s.status not in ('dismissed', 'paused'))
       and btrim(s.item) <> ''
     order by s.tenant_id, s.position nulls last, s.item
  ) src
 where t.tenant_id = src.tenant_id
   and coalesce(btrim(t.postal_address), '') = '';

commit;
