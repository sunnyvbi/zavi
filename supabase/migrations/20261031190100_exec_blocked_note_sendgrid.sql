
create or replace function exec_blocked_note(p_exec_class text)
returns text
language sql immutable set search_path = public, pg_temp as $$
  select (case split_part(coalesce(p_exec_class, ''), '.', 1)
            when 'chatgpt_ads'     then 'ChatGPT Ads'
            when 'google_ads'      then 'Google Ads'
            when 'linkedin_ads'    then 'LinkedIn Ads'
            when 'meta_ads'        then 'Meta Ads'
            when 'generated_video' then 'AI UGC Videos'
            when 'creator'         then 'Creator hire'
            when 'email_campaign'  then 'Mailchimp, Klaviyo or SendGrid'
            when 'seo'             then 'GitHub'
            when 'geo'             then 'GitHub'
            else 'These' end)
         || ' refused this change, so Zavi closed the card. We''ve been alerted; nothing for you to do.';
$$;

revoke all on function exec_blocked_note(text) from public, anon, authenticated;
