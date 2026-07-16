-- Install the protected scheduled Meta dispatcher after the Vercel worker route is deployed.
-- The job is inert unless real Meta delivery is explicitly activated.

create extension if not exists pg_net;

DO $$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid
  FROM cron.job
  WHERE jobname = 'wts-school-notification-meta-worker';

  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;

  PERFORM cron.schedule(
    'wts-school-notification-meta-worker',
    '* * * * *',
    $command$
      SELECT CASE
        WHEN EXISTS (
          SELECT 1
          FROM public.school_notification_config
          WHERE singleton = true
            AND delivery_enabled = true
            AND dry_run = false
            AND automatic_queue = true
            AND active_provider_code = 'meta_whatsapp_cloud'
        )
        THEN net.http_post(
          url := 'https://wts-notification-system.vercel.app/api/meta-dispatch',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-wts-worker-secret', (
              SELECT decrypted_secret
              FROM vault.decrypted_secrets
              WHERE name = 'wts_notification_worker_token'
              LIMIT 1
            )
          ),
          body := jsonb_build_object('limit', 25),
          timeout_milliseconds := 50000
        )
        ELSE NULL
      END;
    $command$
  );
END;
$$;

UPDATE public.school_notification_config
SET metadata = metadata || jsonb_build_object(
      'meta_worker_schedule', '* * * * *',
      'meta_worker_installed_at', now()
    ),
    updated_at = now()
WHERE singleton = true;
