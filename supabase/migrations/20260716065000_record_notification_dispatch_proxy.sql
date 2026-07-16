update public.school_notification_config
set metadata = metadata || jsonb_build_object(
  'legacy_edge_dispatch', 'compatibility_proxy_only',
  'legacy_edge_dispatch_updated_at', now()
), updated_at = now()
where singleton = true;
