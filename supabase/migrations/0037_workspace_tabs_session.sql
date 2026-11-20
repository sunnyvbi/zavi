
create table workspace_tabs_session (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tabs jsonb not null default '[]'::jsonb,
  active_tab_id text,
  updated_at timestamptz not null default now()
);

alter table workspace_tabs_session enable row level security;

create policy workspace_tabs_session_self_select on workspace_tabs_session
  for select using (user_id = auth.uid());

create or replace function get_tabs_session()
returns table (tabs jsonb, active_tab_id text)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_tabs jsonb;
  v_active text;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select s.tabs, s.active_tab_id into v_tabs, v_active
  from workspace_tabs_session s
  where s.user_id = v_user_id;

  if v_tabs is null then
    v_tabs := jsonb_build_array(jsonb_build_object(
      'id', 'home-default',
      'kind', 'home',
      'title', 'Home',
      'payload', jsonb_build_object('kind', 'home'),
      'dirty', false,
      'pinned', true
    ));
    v_active := 'home-default';
  end if;

  return query select v_tabs, v_active;
end;
$$;

revoke all on function get_tabs_session() from public;
grant execute on function get_tabs_session() to authenticated;

create or replace function set_tabs_session(
  p_tabs jsonb,
  p_active_tab_id text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_tabs jsonb;
  v_len int;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if jsonb_typeof(p_tabs) <> 'array' then
    raise exception 'p_tabs must be a json array' using errcode = '22023';
  end if;

  v_len := jsonb_array_length(p_tabs);

  if v_len > 20 then
    v_tabs := (
      select coalesce(jsonb_agg(elem), '[]'::jsonb)
      from (
        select elem
        from jsonb_array_elements(p_tabs) with ordinality as t(elem, ord)
        order by ord desc
        limit 20
      ) trimmed
    );
    v_tabs := (
      select coalesce(jsonb_agg(elem order by ord desc), '[]'::jsonb)
      from jsonb_array_elements(v_tabs) with ordinality as t(elem, ord)
    );
  else
    v_tabs := p_tabs;
  end if;

  insert into workspace_tabs_session (user_id, tabs, active_tab_id, updated_at)
  values (v_user_id, v_tabs, p_active_tab_id, now())
  on conflict (user_id) do update
    set tabs = excluded.tabs,
        active_tab_id = excluded.active_tab_id,
        updated_at = excluded.updated_at;
end;
$$;

revoke all on function set_tabs_session(jsonb, text) from public;
grant execute on function set_tabs_session(jsonb, text) to authenticated;
