begin;

do $$
declare
  fn oid;
  definition text;
  before_text text;
  after_text text;
begin
  select oid into strict fn from pg_proc where pronamespace = 'public'::regnamespace and proname = 'reserve_ad_spend';
  definition := pg_get_functiondef(fn);
  before_text := $old$  v_delta := ceil(p_daily_delta_usd * case when p_platform in ('chatgpt', 'x') then 2 else 1 end * 100) / 100;$old$;
  after_text := $new$  -- TikTok dynamic daily exposure is mode-specific, supplied by the server.
  v_factor := case when p_platform = 'tiktok' then coalesce(p_factor, 1) else null end;
  v_delta := ceil(p_daily_delta_usd * case when p_platform = 'tiktok' then v_factor when p_platform in ('chatgpt', 'x') then 2 else 1 end * 100) / 100;$new$;
  if (length(definition) - length(replace(definition, before_text, ''))) / length(before_text) <> 1 then
    raise exception 'tiktok_dynamic_delivery_holds: reserve function drift';
  end if;
  execute replace(definition, before_text, after_text);
end $$;

do $$
declare
  fn oid;
  definition text;
  pair text[];
  pairs text[][] := array[
    array[
      'max(ends_on) as ends_on, max(coalesce(hold_factor, 1)) as factor,',
      'max(ends_on) as ends_on, max(coalesce(hold_factor, 1)) as factor, min(coalesce(hold_factor, 1)) as cut_factor,'
    ],
    array[
      $old$v_new := ceil(p_new_daily_usd * case when p_platform in ('chatgpt', 'x') then 2 else 1 end * 100) / 100;$old$,
      $new$v_new := ceil(p_new_daily_usd * case when p_platform = 'tiktok' then v_bnd.factor when p_platform in ('chatgpt', 'x') then 2 else 1 end * 100) / 100;$new$
    ],
    array[
      $old$v_new := greatest(v_held - floor(p_cut_usd * case when p_platform in ('chatgpt', 'x') then 2 else 1 end * 100) / 100, 0);$old$,
      $new$v_new := greatest(v_held - floor(p_cut_usd * case when p_platform = 'tiktok' then v_bnd.cut_factor when p_platform in ('chatgpt', 'x') then 2 else 1 end * 100) / 100, 0);$new$
    ],
    array[
      $old$  insert into ad_budget_reservations
    (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd, status)
  values
    (v_budget.id, p_tenant_id, p_idem_key, p_platform, p_object_id, 'rebase', v_new,$old$,
      $new$  insert into ad_budget_reservations
    (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, hold_factor, amount_usd, status)
  values
    (v_budget.id, p_tenant_id, p_idem_key, p_platform, p_object_id, 'rebase', v_new,
     case when p_platform = 'tiktok' then v_bnd.factor else null end,$new$
    ]
  ];
begin
  select oid into strict fn from pg_proc where pronamespace = 'public'::regnamespace and proname = 'rebase_ad_spend_for_object';
  definition := pg_get_functiondef(fn);
  foreach pair slice 1 in array pairs loop
    if (length(definition) - length(replace(definition, pair[1], ''))) / length(pair[1]) <> 1 then
      raise exception 'tiktok_dynamic_delivery_holds: rebase function drift (%)', left(pair[1], 60);
    end if;
    definition := replace(definition, pair[1], pair[2]);
  end loop;
  execute definition;
end $$;

commit;
