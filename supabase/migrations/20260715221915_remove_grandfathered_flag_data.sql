update tenant_subscriptions set grandfathered = false, updated_at = now()
where grandfathered = true;
