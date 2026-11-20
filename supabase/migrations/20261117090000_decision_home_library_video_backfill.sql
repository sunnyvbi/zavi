begin;

update public.decisions set home = null
 where decision_class = 'social.publish.v2'
   and body->>'channel' in ('instagram_video', 'linkedin_video')
   and home_channel is null;

commit;
