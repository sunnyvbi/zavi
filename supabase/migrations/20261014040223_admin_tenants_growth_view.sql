begin;
create table public.admin_growth_settings (
 id boolean primary key default true check(id), tracking_started_at timestamptz not null default now()
);
insert into public.admin_growth_settings(id) values(true);
create table public.admin_growth_classifications (
 subject_type text not null check(subject_type in ('tenant','user')), subject_id uuid not null,
 is_test boolean not null, reason text not null, actor_user_id uuid not null, updated_at timestamptz not null default now(),
 primary key(subject_type,subject_id)
);
create table public.admin_growth_activity (
 user_id uuid not null references auth.users(id) on delete cascade,
 day date not null, last_at timestamptz not null,
 primary key(user_id,day)
);
create index admin_growth_activity_day on public.admin_growth_activity(day,user_id);
create table public.admin_growth_signup_location (
 user_id uuid primary key references auth.users(id) on delete cascade,
 country text check(country ~ '^[A-Z]{2}$'), city text check(length(city)<=120),
 source text not null check(source='cloudfront'), captured_at timestamptz not null default now()
);
alter table public.tenant_subscriptions add column growth_plan_started_at timestamptz;

alter table public.admin_growth_settings enable row level security;
alter table public.admin_growth_classifications enable row level security;
alter table public.admin_growth_activity enable row level security;
alter table public.admin_growth_signup_location enable row level security;
revoke all on public.admin_growth_settings, public.admin_growth_classifications, public.admin_growth_activity, public.admin_growth_signup_location from public,anon,authenticated;
grant all on public.admin_growth_settings, public.admin_growth_classifications, public.admin_growth_activity, public.admin_growth_signup_location to service_role;

create function public.admin_growth_test_reasons(p_email text,p_name text default '',p_slug text default '') returns text[]
language sql immutable set search_path=public,pg_temp as $$
 select array_remove(array[
 case when lower(split_part(coalesce(p_email,''),'@',2))=any(array['zaviagent.com','upcar.ai','thepraxis.ai']) then 'team email' end,
 case when lower(split_part(coalesce(p_email,''),'@',2))=any(array['mailinator.com','yopmail.com','example.com','example-praxis-qa.test']) then 'test email domain' end,
 case when lower(split_part(coalesce(p_email,''),'@',1)) ~ '\+(test|qa)([^a-z]|$)' then 'test/qa email alias' end,
 case when lower(btrim(coalesce(p_name,''))) like 'test%' then 'workspace name starts with test' end,
 case when p_slug=any(array['upcar-ai','upcar-private','apna-tutor-dogfood']) then 'dogfood workspace' end
 ],null);
$$;
revoke all on function public.admin_growth_test_reasons(text,text,text) from public,anon,authenticated;

create function public.admin_growth_record_signin() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.last_sign_in_at is not null then
  insert into admin_growth_activity(user_id,day,last_at) values(new.id,(new.last_sign_in_at at time zone 'Asia/Kolkata')::date,new.last_sign_in_at)
  on conflict(user_id,day) do update set last_at=greatest(admin_growth_activity.last_at,excluded.last_at);
 end if;
 return new;
exception when others then
 raise warning 'admin growth signin activity skipped: SQLSTATE %', SQLSTATE;
 return new;
end $$;
create trigger admin_growth_signin after insert or update of last_sign_in_at on auth.users
 for each row execute function public.admin_growth_record_signin();
create function public.admin_growth_record_message() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_user uuid;
begin
 if new.sender_role='user' then
  select user_id into v_user from agent_threads where id=new.thread_id and tenant_id=new.tenant_id;
  if v_user is not null then
   insert into admin_growth_activity(user_id,day,last_at) values(v_user,(new.created_at at time zone 'Asia/Kolkata')::date,new.created_at)
   on conflict(user_id,day) do update set last_at=greatest(admin_growth_activity.last_at,excluded.last_at);
  end if;
 end if;
 return new;
exception when others then
 raise warning 'admin growth message activity skipped: SQLSTATE %', SQLSTATE;
 return new;
end $$;
create trigger admin_growth_message after insert on public.agent_thread_messages for each row execute function public.admin_growth_record_message();
insert into admin_growth_activity(user_id,day,last_at)
 select user_id,(at_time at time zone 'Asia/Kolkata')::date,max(at_time) from (
 select id user_id,last_sign_in_at at_time from auth.users where last_sign_in_at is not null
 union all select t.user_id,m.created_at from agent_thread_messages m join agent_threads t on t.id=m.thread_id and t.tenant_id=m.tenant_id where m.sender_role='user' and t.user_id is not null
 ) evidence group by user_id,(at_time at time zone 'Asia/Kolkata')::date
 on conflict(user_id,day) do update set last_at=greatest(admin_growth_activity.last_at,excluded.last_at);

create function public.admin_growth_plan_start() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if new.tier in ('starter','growth','pro') and (case when new.comp_expires_at is not null then new.comp_expires_at>now() else new.status in ('active','trialing','past_due') end) then
  if tg_op='INSERT' then new.growth_plan_started_at:=now();
  elsif new.tier is distinct from old.tier or (new.comp_expires_at is null) is distinct from (old.comp_expires_at is null)
     or old.comp_expires_at<=now()
     or (old.status not in ('active','trialing','past_due') and not coalesce(old.comp_expires_at>now(),false)) then new.growth_plan_started_at:=now();
  end if;
 else new.growth_plan_started_at:=null;
 end if;
 return new;
end $$;
create trigger admin_growth_plan_start before insert or update on public.tenant_subscriptions for each row execute function public.admin_growth_plan_start();
revoke all on function public.admin_growth_record_signin() from public,anon,authenticated;
revoke all on function public.admin_growth_record_message() from public,anon,authenticated;
revoke all on function public.admin_growth_plan_start() from public,anon,authenticated;

create function public.admin_growth_classify(p_subject_type text,p_ids uuid[],p_is_test boolean,p_reason text,p_actor uuid) returns integer
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid; v_email text; v_count integer:=0;
begin
 select u.email into v_email from auth.users u join staff_users s on s.user_id=u.id where u.id=p_actor and s.revoked_at is null;
 if v_email is null then raise exception 'active staff required' using errcode='42501'; end if;
 if p_subject_type not in ('tenant','user') or p_subject_type is null or p_is_test is null or coalesce(cardinality(p_ids),0) not between 1 and 200 or length(trim(coalesce(p_reason,''))) not between 3 and 500 then raise exception 'invalid classification' using errcode='22023'; end if;
 foreach v_id in array p_ids loop
  if v_id is null or (p_subject_type='tenant' and not exists(select 1 from tenants where id=v_id)) or (p_subject_type='user' and not exists(select 1 from auth.users where id=v_id)) then raise exception 'unknown subject' using errcode='22023'; end if;
  insert into staff_audit_log(actor_user_id,actor_email,action,target_table,target_id,meta)
  values(p_actor,v_email,'growth.classify','admin_growth_classifications',v_id::text,jsonb_build_object('subject_type',p_subject_type,'is_test',p_is_test,'reason',p_reason,'before',(select to_jsonb(c) from admin_growth_classifications c where subject_type=p_subject_type and subject_id=v_id)));
  insert into admin_growth_classifications(subject_type,subject_id,is_test,reason,actor_user_id) values(p_subject_type,v_id,p_is_test,p_reason,p_actor)
  on conflict(subject_type,subject_id) do update set is_test=excluded.is_test,reason=excluded.reason,actor_user_id=excluded.actor_user_id,updated_at=now();
  v_count:=v_count+1;
 end loop;
 return v_count;
end $$;
revoke all on function public.admin_growth_classify(text,uuid[],boolean,text,uuid) from public,anon,authenticated;
grant execute on function public.admin_growth_classify(text,uuid[],boolean,text,uuid) to service_role;

create function public.admin_tenants_growth(p_from date,p_to date,p_include_usage boolean default false) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_since date; v_today date:=(now() at time zone 'Asia/Kolkata')::date; v_result jsonb;
begin
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3659 or p_to>v_today then raise exception 'invalid date range' using errcode='22023'; end if;
 v_since:=least(p_from-(p_to-p_from+1),v_today-7);
 with settings as (select tracking_started_at from admin_growth_settings where id),
 people as (
 select u.id,u.email,coalesce(u.raw_user_meta_data->>'full_name',u.raw_user_meta_data->>'name') name,case when u.invited_at is not null then u.email_confirmed_at else u.created_at end signup_at,
 (select max(a.last_at) from admin_growth_activity a where a.user_id=u.id) last_active_at,
 coalesce(c.is_test,u.created_at>=s.tracking_started_at and cardinality(admin_growth_test_reasons(u.email))>0) is_test,
 case when c.subject_id is null then admin_growth_test_reasons(u.email) else array[]::text[] end test_reasons,
 l.country,l.city,coalesce((select jsonb_agg(tu.tenant_id) from tenant_users tu where tu.user_id=u.id),'[]'::jsonb) tenant_ids
 from auth.users u cross join settings s left join admin_growth_classifications c on c.subject_type='user' and c.subject_id=u.id
 left join admin_growth_signup_location l on l.user_id=u.id where not coalesce(u.is_anonymous,false) and u.deleted_at is null and (u.invited_at is null or (u.last_sign_in_at is not null and u.email_confirmed_at is not null))
 ), workspaces as (
 select t.id,t.slug,t.display_name,t.created_at,owner.user_id owner_id,
 (select count(*) from tenant_users where tenant_id=t.id and role='owner') owner_count,
 coalesce(c.is_test,t.kind='test' or (t.created_at>=s.tracking_started_at and cardinality(admin_growth_test_reasons(u.email,t.display_name,t.slug))>0)) is_test,
 case when c.subject_id is null and t.kind<>'test' then admin_growth_test_reasons(u.email,t.display_name,t.slug) else array[]::text[] end test_reasons,
 _tenant_tier(t.id) tier,
 coalesce(sub.comp_expires_at>now(),false) or exists(select 1 from system_config sc where sc.id=1 and sc.blob->'tier_pro_tenants' ? t.id::text) is_comp,
 case when exists(select 1 from system_config sc where sc.id=1 and sc.blob->'tier_pro_tenants' ? t.id::text) then null else sub.growth_plan_started_at end plan_start,case when exists(select 1 from system_config sc where sc.id=1 and sc.blob->'tier_pro_tenants' ? t.id::text) then null else coalesce(sub.comp_expires_at,sub.current_period_end) end plan_end,coalesce(sub.cancel_at_period_end,false) cancels,
 coalesce(
   (select nullif(btrim(f.value_text),'') from tenant_fact f where f.tenant_id=t.id and f.key='domain' and f.source='human_confirmed' limit 1),
   case when jsonb_typeof(t.product_url->'marketing')='string'
     and not exists(select 1 from sites si where si.tenant_id=t.id and lower(rtrim(btrim(si.live_url),'/'))=lower(rtrim(btrim(t.product_url->>'marketing'),'/')))
     and not exists(select 1 from tenant_fact f where f.tenant_id=t.id and f.key='domain' and f.source='provisioned' and lower(rtrim(btrim(f.value_text),'/'))=lower(rtrim(btrim(t.product_url->>'marketing'),'/')))
   then nullif(btrim(t.product_url->>'marketing'),'') end
 ) added_url,
 coalesce((select jsonb_agg(si.live_url order by si.created_at desc) from sites si where si.tenant_id=t.id and si.status='live' and si.live_url is not null),'[]'::jsonb) built_urls,
 coalesce((select jsonb_agg(cm.slug) from connector_metadata cm where cm.tenant_id=t.id and cm.connected_at is not null),'[]'::jsonb) connections,
 coalesce((select jsonb_agg(sa.platform) from social_connected_accounts sa where sa.tenant_id=t.id and sa.status='connected'),'[]'::jsonb) socials,
 coalesce((select jsonb_agg(ms.server_id) from tenant_mcp_servers ms where ms.tenant_id=t.id and ms.enabled and ms.server_id<>'composio'),'[]'::jsonb) mcp_connections,
 (select max(a.last_at) from admin_growth_activity a join tenant_users tu on tu.user_id=a.user_id where tu.tenant_id=t.id) last_active_at
 from tenants t cross join settings s
 left join lateral(select tu.user_id from tenant_users tu where tu.tenant_id=t.id and tu.role='owner' order by tu.created_at,tu.user_id limit 1) owner on true
 left join auth.users u on u.id=owner.user_id left join tenant_subscriptions sub on sub.tenant_id=t.id
 left join admin_growth_classifications c on c.subject_type='tenant' and c.subject_id=t.id
 where t.kind is distinct from 'launch_video_shell'
 ) select jsonb_build_object('today',v_today,'tracking_started_at',(select tracking_started_at from settings),
 'users',coalesce((select jsonb_agg(to_jsonb(p)) from people p),'[]'::jsonb),
 'tenants',coalesce((select jsonb_agg(to_jsonb(w)) from workspaces w),'[]'::jsonb),
 'usage',case when p_include_usage then (
 select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from (
 select t.id tenant_id,coalesce(r.runs,0) runs,coalesce(r.cost_usd,0) cost_usd,case when r.runs>0 then r.ok_runs::numeric/r.runs else null end ok_rate,coalesce(m.messages,0) user_messages
 from tenants t left join (select tenant_id,count(*) runs,count(*) filter(where status='success' and parse_ok) ok_runs,sum(cost_usd) cost_usd from agent_runs where enqueued_at>=p_from::timestamp at time zone 'Asia/Kolkata' and enqueued_at<(p_to+1)::timestamp at time zone 'Asia/Kolkata' group by tenant_id) r on r.tenant_id=t.id
 left join (select tenant_id,count(*) messages from agent_thread_messages where sender_role='user' and created_at>=p_from::timestamp at time zone 'Asia/Kolkata' and created_at<(p_to+1)::timestamp at time zone 'Asia/Kolkata' group by tenant_id) m on m.tenant_id=t.id
 where t.kind is distinct from 'launch_video_shell'
 )x) else null end,
 'activity',coalesce((select jsonb_agg(jsonb_build_object('user_id',a.user_id,'day',a.day)) from admin_growth_activity a where a.day>=v_since and a.day<=greatest(p_to,v_today)),'[]'::jsonb)
 ) into v_result;
 return v_result;
end $$;
revoke all on function public.admin_tenants_growth(date,date,boolean) from public,anon,authenticated;
grant execute on function public.admin_tenants_growth(date,date,boolean) to service_role;
create function public.record_admin_growth_signup_location(p_user_id uuid,p_country text,p_city text,p_issued_at timestamptz) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_issued_at is null or p_issued_at<now()-interval '60 seconds' or p_issued_at>now()+interval '5 seconds' or not exists(select 1 from auth.users where id=p_user_id and created_at>=now()-interval '60 seconds' and abs(extract(epoch from (created_at-p_issued_at)))<=60) then
  raise exception 'signup window expired' using errcode='22023';
 end if;
 insert into admin_growth_signup_location(user_id,country,city,source) values(p_user_id,p_country,p_city,'cloudfront') on conflict(user_id) do nothing;
end $$;
revoke all on function public.record_admin_growth_signup_location(uuid,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.record_admin_growth_signup_location(uuid,text,text,timestamptz) to service_role;
commit;
