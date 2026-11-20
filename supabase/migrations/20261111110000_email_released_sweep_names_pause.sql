begin;

create or replace function public.email_redispatch_released_sweep(p_limit int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r        record;
  v        jsonb;
  v_out    jsonb := '[]'::jsonb;
  v_paused boolean;
begin
  for r in
    select d.id, d.tenant_id, d.decision_class, d.status, d.approved_at, d.dispatched_at, d.approved_by, d.dispatch_error
      from decisions d
     where d.decision_class in ('email_campaign.create_and_send', 'bulk_outbound.send')
       and ((d.status = 'proposed' and d.approved_by is not null)
         or (d.status = 'approved' and d.dispatch_error like 'email_redispatch:r%'))
       and coalesce(d.dispatched_at, d.approved_at, now()) < now() - interval '5 minutes'
     order by d.dispatched_at nulls first, d.id
     limit greatest(1, least(coalesce(p_limit, 50), 200))
     for update skip locked
  loop
    if coalesce(r.approved_at, r.dispatched_at) < now() - interval '24 hours' then
      v_paused := r.status = 'proposed'
                  and (r.dispatch_error is not distinct from 'email_paused' or public.email_send_paused(r.tenant_id));
      update decisions
         set status = 'dispatch_failed',
             dispatch_error = case when v_paused
               then 'Email was paused for this workspace, so Zavi held this send, and email was not resumed within a day of its approval. Zavi did not send it, so an old email never goes out late. Ask Zavi for a new draft.'
               else 'Zavi could not start this send within a day of its approval, so it did not send it. Ask Zavi for a new draft.' end
       where id = r.id and status in ('proposed', 'approved');
      v_out := v_out || jsonb_build_object('action', 'expired', 'tenant_id', r.tenant_id, 'decision_id', r.id,
                                           'decision_class', r.decision_class, 'paused', v_paused);
    elsif r.status = 'approved' then
      v_out := v_out || jsonb_build_object('action', 'redispatch', 'tenant_id', r.tenant_id, 'decision_id', r.id,
                                           'decision_class', r.decision_class,
                                           'redispatch_key', substring(r.dispatch_error from length('email_redispatch:') + 1));
    elsif not public.email_send_paused(r.tenant_id) then
      v := public._email_redispatch_released(r.tenant_id, r.id);
      if coalesce((v->>'ok')::boolean, false) then
        v_out := v_out || jsonb_build_object('action', 'redispatch', 'tenant_id', r.tenant_id, 'decision_id', r.id,
                                             'decision_class', r.decision_class, 'redispatch_key', v->>'redispatch_key');
      end if;
    end if;
  end loop;
  return v_out;
end $$;
revoke all on function public.email_redispatch_released_sweep(int) from public, anon, authenticated;
grant execute on function public.email_redispatch_released_sweep(int) to service_role;

commit;
