
drop table if exists marketplace_intel_config;

delete from marketplace_geo_category_weekly;

delete from tenant_app_setting where key = 'marketplace_rollup_last_run';
