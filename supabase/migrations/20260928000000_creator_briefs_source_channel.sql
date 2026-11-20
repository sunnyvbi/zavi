
alter table public.creator_briefs
  add column if not exists source_channel text
    check (source_channel is null or source_channel in (
      'meta_ads', 'tiktok_ads', 'youtube_ads',
      'tiktok_organic', 'instagram_organic', 'youtube_organic'
    )),
  add column if not exists ad_rights_days integer
    check (ad_rights_days is null or ad_rights_days in (30, 90, 365)),
  add column if not exists filled_by_order_id uuid;

comment on column public.creator_briefs.source_channel is
  'The video channel whose "Get a creator video" card started this brief. Null when started on UGC.';
comment on column public.creator_briefs.ad_rights_days is
  'Ad rights an applicant hire grants, frozen onto the order snapshot at hire. 30, 90 or 365.';
comment on column public.creator_briefs.filled_by_order_id is
  'The applicant order that claimed this brief before capturing. One per brief.';
