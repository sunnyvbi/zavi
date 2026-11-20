create or replace function public.admin_tenants_growth(p_from date,p_to date,p_include_usage boolean default false) returns jsonb
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
 coalesce(c.is_test,t.kind='test' or (t.created_at>=s.tracking_started_at and cardinality(admin_growth_test_reasons(null,t.display_name,t.slug))>0)) is_test,
 case when c.subject_id is null and t.kind<>'test' then admin_growth_test_reasons(null,t.display_name,t.slug) else array[]::text[] end test_reasons,
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
 left join tenant_subscriptions sub on sub.tenant_id=t.id
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
