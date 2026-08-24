-- Route the existing protected notification worker to the Bahasha Vercel gateway.
-- Keep the existing provider code temporarily so queued-message claim and completion
-- remain compatible while the provider adapter is changed safely.

create extension if not exists pg_net;

do $$
declare
  v_jobid bigint;
begin
  select jobid into v_jobid
  from cron.job
  where jobname = 'wts-school-notification-meta-worker';

  if v_jobid is not null then
    perform cron.unschedule(v_jobid);
  end if;

  select jobid into v_jobid
  from cron.job
  where jobname = 'wts-school-notification-bahasha-worker';

  if v_jobid is not null then
    perform cron.unschedule(v_jobid);
  end if;

  perform cron.schedule(
    'wts-school-notification-bahasha-worker',
    '* * * * *',
    $command$
      select case
        when exists (
          select 1
          from public.school_notification_config
          where singleton = true
            and delivery_enabled = true
            and dry_run = false
            and automatic_queue = true
            and active_provider_code = 'meta_whatsapp_cloud'
        )
        then net.http_post(
          url := 'https://wts-notification-system.vercel.app/api/bahasha-dispatch',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-wts-worker-secret', (
              select decrypted_secret
              from vault.decrypted_secrets
              where name = 'wts_notification_worker_token'
              limit 1
            )
          ),
          body := jsonb_build_object('limit', 25),
          timeout_milliseconds := 50000
        )
        else null
      end;
    $command$
  );
end;
$$;

update public.attendance_notification_providers
set configuration = configuration || jsonb_build_object(
      'delivery_adapter', 'bahasha',
      'dispatch_url', 'https://wts-notification-system.vercel.app/api/bahasha-dispatch',
      'webhook_url', 'https://wts-notification-system.vercel.app/api/bahasha-webhook'
    ),
    updated_at = now()
where provider_code = 'meta_whatsapp_cloud';

update public.school_notification_config
set metadata = metadata || jsonb_build_object(
      'delivery_adapter', 'bahasha',
      'bahasha_worker_schedule', '* * * * *',
      'parent_recipients_only', true,
      'bahasha_worker_installed_at', now()
    ),
    updated_at = now()
where singleton = true;
