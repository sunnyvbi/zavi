
begin;

alter function claim_news_scan_day(uuid, date) set search_path = public, pg_temp;
alter function claim_news_digest_send(uuid, date) set search_path = public, pg_temp;

drop function if exists mark_news_digest_sent(uuid, uuid, text);

create or replace function mark_news_digest_sent(
  p_id          uuid,
  p_tenant_id   uuid,
  p_status      text,
  p_finding_ids uuid[] default '{}'
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_id is null or p_tenant_id is null or p_status is null then
    raise exception 'mark_news_digest_sent: null argument' using errcode = '22023';
  end if;
  if p_status not in ('sent', 'failed') then
    raise exception 'mark_news_digest_sent: bad status' using errcode = '22023';
  end if;
  update news_digest_deliveries
     set status  = p_status,
         sent_at = case when p_status = 'sent' then now() else sent_at end
   where id = p_id and tenant_id = p_tenant_id;
  if p_status = 'sent' and p_finding_ids is not null and array_length(p_finding_ids, 1) > 0 then
    update news_findings
       set last_emailed_at = now()
     where tenant_id = p_tenant_id
       and id = any(p_finding_ids)
       and last_emailed_at is null;
  end if;
end;
$$;
revoke all on function mark_news_digest_sent(uuid, uuid, text, uuid[]) from public;
grant execute on function mark_news_digest_sent(uuid, uuid, text, uuid[]) to service_role;

commit;
