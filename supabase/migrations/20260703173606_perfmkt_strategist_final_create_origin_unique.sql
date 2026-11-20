create unique index if not exists decisions_strategist_origin_uq
  on decisions ((body -> 'strategist_gate' ->> 'origin_pending_decision_id'))
  where decision_class = 'meta_ads.create_ad_set'
    and (body -> 'strategist_gate' ->> 'origin_pending_decision_id') is not null;
