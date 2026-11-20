create sequence if not exists public.stream_draft_generation;
alter table public.agent_run_stream_drafts
  add column if not exists writer_generation bigint not null default 0,
  add column if not exists writer_seq bigint not null default 0;

create or replace function public.begin_stream_draft_writer(p_run_id uuid, p_tenant_id uuid)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare v_generation bigint;
begin
  perform 1 from public.agent_runs where id=p_run_id and tenant_id=p_tenant_id and status='running';
  if not found then return null; end if;
  v_generation := nextval('public.stream_draft_generation');
  return v_generation;
end $$;

create or replace function public.write_stream_draft(
  p_run_id uuid, p_tenant_id uuid, p_generation bigint, p_seq bigint,
  p_text text, p_status text, p_thread_id uuid, p_agent_slug text
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_slug text; v_count integer;
begin
  if p_generation is null or p_generation<=0 or p_seq is null or p_seq<=0
     or p_status is null or p_status not in ('streaming','complete','failed','cancelled')
     or p_text is null then return false; end if;
  select agent_slug into v_slug from public.agent_runs where id=p_run_id and tenant_id=p_tenant_id;
  if not found or v_slug is distinct from p_agent_slug then return false; end if;
  if p_thread_id is not null and not exists (
    select 1 from public.agent_threads where id=p_thread_id and tenant_id=p_tenant_id
  ) then return false; end if;
  insert into public.agent_run_stream_drafts as d
    (run_id,tenant_id,thread_id,agent_slug,seq,text,status,updated_at,writer_generation,writer_seq)
  values (p_run_id,p_tenant_id,p_thread_id,v_slug,1,p_text,p_status,clock_timestamp(),p_generation,p_seq)
  on conflict (run_id) do update set
    thread_id=excluded.thread_id, agent_slug=excluded.agent_slug,
    seq=d.seq+1, text=excluded.text, status=excluded.status, updated_at=excluded.updated_at,
    writer_generation=excluded.writer_generation, writer_seq=excluded.writer_seq
  where d.tenant_id=p_tenant_id and
    (d.writer_generation<p_generation or (d.writer_generation=p_generation and d.writer_seq<p_seq));
  get diagnostics v_count = row_count;
  return v_count=1;
end $$;

revoke insert, update on public.agent_run_stream_drafts from service_role;
revoke all on sequence public.stream_draft_generation from public, anon, authenticated, service_role;
revoke all on function public.begin_stream_draft_writer(uuid,uuid) from public,anon,authenticated;
revoke all on function public.write_stream_draft(uuid,uuid,bigint,bigint,text,text,uuid,text) from public,anon,authenticated;
grant execute on function public.begin_stream_draft_writer(uuid,uuid) to service_role;
grant execute on function public.write_stream_draft(uuid,uuid,bigint,bigint,text,text,uuid,text) to service_role;
