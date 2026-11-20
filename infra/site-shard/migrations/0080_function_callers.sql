
begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';

create or replace function zsite.request_fn() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare c jsonb := zsite.claims();
begin
  if pg_catalog.current_setting('role', true) is distinct from 'authenticated' then return null; end if;
  if (c->>'role') = 'authenticated' and zsite.is_uuid(c->>'site_id') and zsite.is_uuid(c->>'sub')
     and pg_catalog.jsonb_typeof(c->'zfn') = 'string' and (c->>'zfn') ~ '^[a-z][a-z0-9-]{0,47}$' then
    return pg_catalog.jsonb_build_object('fn', c->>'zfn', 'admin', coalesce(c->'zfn_admin' = 'true'::jsonb, false));
  end if;
  return null;
end $$;

create or replace function zsite.request_ctx() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare v_site uuid := zsite.request_site(); v_usr uuid; v_uid uuid; v_role text; v_fn jsonb;
begin
  if v_site is not null then
    v_fn := zsite.request_fn();
    if v_fn is not null then
      return pg_catalog.jsonb_build_object('site', v_site, 'uid', null, 'role', null,
                                           'fn', v_fn->>'fn', 'fn_admin', (v_fn->>'admin')::boolean);
    end if;
    v_usr := zsite.request_user();
    if v_usr is not null then
      select mm.user_id, mm.role into v_uid, v_role
      from zsite.members mm
      join zsite.identities i on i.site_id = mm.site_id and i.auth_user_id = mm.user_id
      where mm.site_id = v_site and mm.user_id = v_usr and mm.status = 'active'
        and i.state in ('active', 'email_change_pending');
    end if;
  end if;
  return pg_catalog.jsonb_build_object('site', v_site, 'uid', v_uid, 'role', v_role);
end $$;

create or replace function zsite.valid_principals(p jsonb, p_allow_anyone boolean) returns boolean
language sql immutable security invoker set search_path = '' as $$
  select jsonb_typeof(p) = 'array'
     and jsonb_array_length(p) <= 8
     and not exists (
       select 1 from jsonb_array_elements(p) e
       where jsonb_typeof(e) <> 'string'
          or not (
               (e #>> '{}') in ('signed_in', 'owner', 'admin', 'recipient')
            or ((e #>> '{}') = 'anyone' and p_allow_anyone)
            or (e #>> '{}') ~ '^role:[a-z][a-z0-9_]{0,31}$'
            or (e #>> '{}') ~ '^fn:[a-z][a-z0-9-]{0,47}$'
          )
     )
$$;

create or replace function zsite.ctx_match(p_ctx jsonb, p_principals jsonb, p_owner uuid, p_recipient uuid)
returns boolean
language plpgsql immutable security invoker set search_path = '' as $$
declare v_uid text := p_ctx->>'uid'; v_role text := p_ctx->>'role'; v_fn text := p_ctx->>'fn';
begin
  if jsonb_typeof(p_principals) is distinct from 'array' then return false; end if;
  if v_fn is not null then
    return p_principals ? ('fn:' || v_fn)
        or (coalesce((p_ctx->>'fn_admin')::boolean, false) and p_principals ? 'admin');
  end if;
  if p_principals ? 'anyone' then return true; end if;
  if v_uid is null then return false; end if;
  return p_principals ? 'signed_in'
      or (p_owner is not null and p_owner::text = v_uid and p_principals ? 'owner')
      or (p_recipient is not null and p_recipient::text = v_uid and p_principals ? 'recipient')
      or (v_role = 'admin' and p_principals ? 'admin')
      or (v_role is not null and p_principals ? ('role:' || v_role));
end $$;

create or replace function zsite.request_grants() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  c jsonb := zsite.request_ctx();
  v_signed boolean := (c->>'uid') is not null or (c->>'fn') is not null;
  v_uid uuid := (c->>'uid')::uuid;
  x record; s record;
  la text[] := '{}'; lo text[] := '{}'; ga text[] := '{}'; go text[] := '{}'; cr text[] := '{}';
  ua text[] := '{}'; uo text[] := '{}'; da text[] := '{}'; dw text[] := '{}';
  lr text[] := '{}'; gr text[] := '{}'; ur text[] := '{}'; dr text[] := '{}';
  sc text[] := '{}'; sa text[] := '{}'; so text[] := '{}'; sr text[] := '{}';
begin
  if (c->>'site') is not null then
    for x in select y.name, y.rules, y.states from zsite.collections y
             where y.site_id = (c->>'site')::uuid and y.kind = 'records' and y.archived_at is null loop
      if zsite.ctx_match(c, x.rules->'list', null) then la := la || x.name; end if;
      if zsite.ctx_match(c, x.rules->'get', null) then ga := ga || x.name; end if;
      if zsite.ctx_match(c, x.rules->'create', v_uid) then cr := cr || x.name; end if;
      if v_signed then
        if coalesce(x.rules->'list' ? 'owner', false) then lo := lo || x.name; end if;
        if coalesce(x.rules->'get' ? 'owner', false) then go := go || x.name; end if;
        if zsite.ctx_match(c, x.rules->'update', null) then ua := ua || x.name; end if;
        if coalesce(x.rules->'update' ? 'owner', false) then uo := uo || x.name; end if;
        if zsite.ctx_match(c, x.rules->'delete', null) then da := da || x.name; end if;
        if coalesce(x.rules->'delete' ? 'owner', false) then dw := dw || x.name; end if;
        if coalesce(x.rules->'list' ? 'recipient', false) then lr := lr || x.name; end if;
        if coalesce(x.rules->'get' ? 'recipient', false) then gr := gr || x.name; end if;
        if coalesce(x.rules->'update' ? 'recipient', false) then ur := ur || x.name; end if;
        if coalesce(x.rules->'delete' ? 'recipient', false) then dr := dr || x.name; end if;
      end if;
      if x.states is not null and x.states ? 'read' then
        sc := sc || x.name;
        for s in select e.key, e.value from jsonb_each(x.states->'read') e loop
          if zsite.ctx_match(c, s.value, null) then sa := sa || (x.name || '/' || s.key); end if;
          if v_signed and s.value ? 'owner' then so := so || (x.name || '/' || s.key); end if;
          if v_signed and s.value ? 'recipient' then sr := sr || (x.name || '/' || s.key); end if;
        end loop;
      end if;
    end loop;
  end if;
  return jsonb_build_object('uid', c->'uid',
    'list_all', to_jsonb(la), 'list_own', to_jsonb(lo), 'get_all', to_jsonb(ga), 'get_own', to_jsonb(go),
    'create', to_jsonb(cr), 'update_all', to_jsonb(ua), 'update_own', to_jsonb(uo),
    'delete_all', to_jsonb(da), 'delete_own', to_jsonb(dw),
    'list_rcpt', to_jsonb(lr), 'get_rcpt', to_jsonb(gr), 'update_rcpt', to_jsonb(ur), 'delete_rcpt', to_jsonb(dr),
    'state_colls', to_jsonb(sc), 'state_all', to_jsonb(sa), 'state_own', to_jsonb(so), 'state_rcpt', to_jsonb(sr));
end $$;

revoke all on function zsite.request_fn() from public;
grant execute on function zsite.request_fn() to anon, authenticated, service_role, zsite_facade, zsite_kernel;

insert into zsite.migrations (version) values ('0080_function_callers') on conflict do nothing;

commit;
