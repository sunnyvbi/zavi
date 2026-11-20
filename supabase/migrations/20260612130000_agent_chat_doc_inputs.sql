
begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'agent-chat-docs',
  'agent-chat-docs',
  false,
  10485760,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/csv',
    'text/plain'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists agent_chat_docs_deny_anon_select on storage.objects;
create policy agent_chat_docs_deny_anon_select on storage.objects
  for select to anon
  using (bucket_id = 'agent-chat-docs' and false);

drop policy if exists agent_chat_docs_deny_anon_insert on storage.objects;
create policy agent_chat_docs_deny_anon_insert on storage.objects
  for insert to anon
  with check (bucket_id = 'agent-chat-docs' and false);

drop policy if exists agent_chat_docs_deny_authenticated_select on storage.objects;
create policy agent_chat_docs_deny_authenticated_select on storage.objects
  for select to authenticated
  using (bucket_id = 'agent-chat-docs' and false);

drop policy if exists agent_chat_docs_deny_authenticated_insert on storage.objects;
create policy agent_chat_docs_deny_authenticated_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'agent-chat-docs' and false);

create or replace function send_agent_chat_turn_v3(
  p_agent_slug text,
  p_agent_hash text,
  p_message text,
  p_thread_id uuid,
  p_image_paths text[],
  p_doc_paths text[]
) returns table (thread_id uuid, user_message_id uuid, run_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_role text;
  v_thread_id uuid;
  v_user_message_id uuid;
  v_run_id uuid;
  v_path text;
  v_image_attachments jsonb;
  v_doc_attachments jsonb;
  v_attachments jsonb;
  v_img_regex text;
  v_doc_regex text;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select active_tenant_id into v_tenant_id from profiles where user_id = v_user_id;
  if v_tenant_id is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;

  select role into v_role from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id;
  if v_role is null then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;

  if v_role = 'member' and not exists (
    select 1 from tenant_member_agents
     where tenant_id = v_tenant_id
       and user_id = v_user_id
       and agent_slug = p_agent_slug
  ) then
    raise exception 'agent % not in member allowlist', p_agent_slug using errcode = '42501';
  end if;

  if (coalesce(p_message, '') = ''
      and coalesce(array_length(p_image_paths, 1), 0) = 0
      and coalesce(array_length(p_doc_paths, 1), 0) = 0)
     or length(coalesce(p_message, '')) > 32000 then
    raise exception 'message length out of bounds' using errcode = '22023';
  end if;

  if coalesce(array_length(p_image_paths, 1), 0) > 4 then
    raise exception 'too many images (max 4)' using errcode = '22023';
  end if;
  if coalesce(array_length(p_doc_paths, 1), 0) > 4 then
    raise exception 'too many docs (max 4)' using errcode = '22023';
  end if;

  v_img_regex := '^' || v_tenant_id::text || '/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$';
  if p_image_paths is not null then
    foreach v_path in array p_image_paths loop
      if v_path !~ v_img_regex then
        raise exception 'image path % does not belong to tenant', v_path using errcode = '42501';
      end if;
    end loop;
  end if;

  v_doc_regex := '^' || v_tenant_id::text || '/[0-9a-f-]{36}\.(pdf|docx|csv|txt)$';
  if p_doc_paths is not null then
    foreach v_path in array p_doc_paths loop
      if v_path !~ v_doc_regex then
        raise exception 'doc path % does not belong to tenant', v_path using errcode = '42501';
      end if;
    end loop;
  end if;

  if p_thread_id is null then
    insert into agent_threads (tenant_id, agent_slug, user_id, title)
    values (v_tenant_id, p_agent_slug, v_user_id,
            left(coalesce(nullif(p_message, ''), 'attachment'), 80))
    returning id into v_thread_id;
  else
    select id into v_thread_id from agent_threads
      where id = p_thread_id
        and tenant_id = v_tenant_id
        and agent_slug = p_agent_slug
        and user_id = v_user_id;
    if v_thread_id is null then
      raise exception 'thread not found or not owned' using errcode = '42501';
    end if;
    update agent_threads set last_message_at = now() where id = v_thread_id;
  end if;

  if p_image_paths is not null and array_length(p_image_paths, 1) > 0 then
    select jsonb_agg(jsonb_build_object('path', p, 'kind', 'image'))
      into v_image_attachments from unnest(p_image_paths) as p;
  else
    v_image_attachments := '[]'::jsonb;
  end if;
  if p_doc_paths is not null and array_length(p_doc_paths, 1) > 0 then
    select jsonb_agg(jsonb_build_object('path', p, 'kind', 'doc'))
      into v_doc_attachments from unnest(p_doc_paths) as p;
  else
    v_doc_attachments := '[]'::jsonb;
  end if;
  v_attachments := v_image_attachments || v_doc_attachments;
  if jsonb_array_length(v_attachments) = 0 then
    v_attachments := null;
  end if;

  insert into agent_runs
    (tenant_id, agent_slug, agent_definition_hash, trigger, status, enqueued_by, payload)
  values
    (v_tenant_id, p_agent_slug, p_agent_hash, 'chat', 'queued', v_user_id,
     jsonb_build_object('thread_id', v_thread_id,
                        'image_paths', coalesce(to_jsonb(p_image_paths), 'null'::jsonb),
                        'doc_paths', coalesce(to_jsonb(p_doc_paths), 'null'::jsonb)))
  returning id into v_run_id;

  insert into agent_thread_messages
    (thread_id, tenant_id, sender_role, body, agent_run_id, attachments)
  values
    (v_thread_id, v_tenant_id, 'user', coalesce(p_message, ''), v_run_id, v_attachments)
  returning id into v_user_message_id;

  update agent_runs
    set payload = jsonb_build_object(
      'thread_id', v_thread_id,
      'user_message_id', v_user_message_id,
      'image_paths', coalesce(to_jsonb(p_image_paths), 'null'::jsonb),
      'doc_paths', coalesce(to_jsonb(p_doc_paths), 'null'::jsonb)
    )
    where id = v_run_id;

  return query select v_thread_id, v_user_message_id, v_run_id;
end $$;

revoke all on function send_agent_chat_turn_v3(text, text, text, uuid, text[], text[]) from public;
grant execute on function send_agent_chat_turn_v3(text, text, text, uuid, text[], text[]) to authenticated;

commit;
