create or replace function _reserve_estimate_for(p_slug text)
returns int
language sql
immutable
as $$
  select case p_slug
    when 'engineer'             then 2000
    when 'product-builder'      then 2400
    when 'meta_ads'             then 720
    when 'fundraising'          then 500
    when 'growth-lead'          then 320
    when 'research'             then 320
    when 'advisor'              then 320
    when 'cgo'                  then 320
    when 'browser-operator'     then 240
    when 'performance-marketer' then 160
    when 'operator'             then 160
    when 'pm'                   then 160
    when 'support-lead'         then 160
    when 'dispute-response'     then 160
    when 'chief-of-staff'       then 160
    when 'qa'                   then 160
    else 340
  end;
$$;
