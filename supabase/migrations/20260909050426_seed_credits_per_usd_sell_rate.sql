
insert into system_config (id, blob)
values (1, jsonb_build_object('credits_per_usd', 400))
on conflict (id) do update
  set blob = jsonb_build_object('credits_per_usd', 400) || system_config.blob,
      updated_at = now();

do $$
declare v_rate text;
begin
  select blob->>'credits_per_usd' into v_rate from system_config where id = 1;
  raise notice '20260909050426: credits_per_usd = % (credits per $1, global sell rate)', v_rate;
end $$;
