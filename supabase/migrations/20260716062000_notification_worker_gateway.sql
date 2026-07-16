-- Consolidate real WhatsApp delivery on the Vercel gateway backed by Supabase Vault.
-- Live delivery remains disabled until Meta configuration, an approved template,
-- a successful test and a verified opted-in pilot recipient are present.

create extension if not exists pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM vault.decrypted_secrets
    WHERE name = 'wts_notification_worker_token'
  ) THEN
    PERFORM vault.create_secret(
      encode(gen_random_bytes(48), 'hex'),
      'wts_notification_worker_token',
      'Private token used only by the scheduled WTS notification dispatcher',
      NULL
    );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.school_notification_worker_token_valid()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'extensions'
AS $function$
DECLARE
  v_headers jsonb;
  v_token text;
  v_secret text;
BEGIN
  BEGIN
    v_headers := COALESCE(NULLIF(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    v_headers := '{}'::jsonb;
  END;

  v_token := NULLIF(v_headers ->> 'x-wts-worker-secret', '');
  SELECT decrypted_secret
  INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'wts_notification_worker_token'
  LIMIT 1;

  IF v_token IS NULL OR v_secret IS NULL THEN
    RETURN false;
  END IF;

  RETURN encode(digest(v_token, 'sha256'), 'hex') = encode(digest(v_secret, 'sha256'), 'hex');
END;
$function$;

CREATE OR REPLACE FUNCTION public.school_meta_whatsapp_runtime_config_worker()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'extensions'
AS $function$
DECLARE
  v_cfg public.school_meta_whatsapp_config%rowtype;
  v_access text;
  v_app text;
  v_verify text;
BEGIN
  IF NOT public.school_notification_worker_token_valid() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'WORKER_AUTH_FAILED');
  END IF;

  SELECT * INTO v_cfg
  FROM public.school_meta_whatsapp_config
  WHERE singleton = true;

  SELECT decrypted_secret INTO v_access
  FROM vault.decrypted_secrets
  WHERE id = v_cfg.access_token_secret_id;

  SELECT decrypted_secret INTO v_app
  FROM vault.decrypted_secrets
  WHERE id = v_cfg.app_secret_secret_id;

  SELECT decrypted_secret INTO v_verify
  FROM vault.decrypted_secrets
  WHERE id = v_cfg.verify_token_secret_id;

  RETURN jsonb_build_object(
    'ok', true,
    'phone_number_id', v_cfg.phone_number_id,
    'business_account_id', v_cfg.business_account_id,
    'graph_version', v_cfg.graph_version,
    'template_map', v_cfg.template_map,
    'access_token', v_access,
    'app_secret', v_app,
    'verify_token', v_verify
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.school_meta_whatsapp_claim_worker(
  p_worker_id text,
  p_limit integer DEFAULT 25
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'extensions'
AS $function$
BEGIN
  IF NOT public.school_notification_worker_token_valid() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'WORKER_AUTH_FAILED');
  END IF;

  RETURN public.claim_school_notifications(
    p_worker_id,
    LEAST(GREATEST(COALESCE(p_limit, 25), 1), 25),
    'meta_whatsapp_cloud'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.school_meta_whatsapp_complete_worker(
  p_message_id uuid,
  p_worker_id text,
  p_success boolean,
  p_provider_reference text DEFAULT NULL,
  p_response jsonb DEFAULT '{}'::jsonb,
  p_error_code text DEFAULT NULL,
  p_error_message text DEFAULT NULL,
  p_retry_after_seconds integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'extensions'
AS $function$
BEGIN
  IF NOT public.school_notification_worker_token_valid() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'WORKER_AUTH_FAILED');
  END IF;

  RETURN public.complete_school_notification_attempt(
    p_message_id,
    p_worker_id,
    p_success,
    p_provider_reference,
    p_response,
    p_error_code,
    p_error_message,
    p_retry_after_seconds
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.school_meta_whatsapp_activate_api(
  p_client_code text,
  p_client_secret text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'extensions'
AS $function$
DECLARE
  v_admin uuid;
  v_cfg public.school_meta_whatsapp_config%rowtype;
BEGIN
  v_admin := public.school_registry_verify_admin(
    p_client_code,
    p_client_secret,
    'notifications.manage'
  );
  IF v_admin IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ADMIN_AUTH_OR_PERMISSION_FAILED');
  END IF;

  SELECT * INTO v_cfg
  FROM public.school_meta_whatsapp_config
  WHERE singleton = true
  FOR UPDATE;

  IF v_cfg.last_test_status <> 'passed' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'META_TEST_REQUIRED',
      'message', 'Send and receive one successful Meta test message before live activation.'
    );
  END IF;

  IF v_cfg.phone_number_id IS NULL
     OR v_cfg.business_account_id IS NULL
     OR v_cfg.graph_version IS NULL
     OR v_cfg.access_token_secret_id IS NULL
     OR v_cfg.app_secret_secret_id IS NULL
     OR v_cfg.verify_token_secret_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'META_CONFIGURATION_INCOMPLETE',
      'message', 'Complete the Meta phone, business account, token and webhook security settings.'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.school_notification_templates
    WHERE status = 'active'
      AND channel = 'whatsapp'
      AND provider_template_status = 'approved'
      AND NULLIF(provider_template_name, '') IS NOT NULL
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'META_APPROVED_TEMPLATE_REQUIRED',
      'message', 'At least one WhatsApp template must be approved by Meta before live activation.'
    );
  END IF;

  IF NOT (
    EXISTS (
      SELECT 1
      FROM public.attendance_guardian_contacts
      WHERE status = 'active'
        AND pilot_enabled = true
        AND whatsapp_opt_in_status = 'opted_in'
        AND whatsapp_verified_at IS NOT NULL
        AND whatsapp_number IS NOT NULL
    )
    OR EXISTS (
      SELECT 1
      FROM public.staff_attendance_profiles
      WHERE employment_status = 'active'
        AND pilot_enabled = true
        AND whatsapp_opt_in_status = 'opted_in'
        AND whatsapp_verified_at IS NOT NULL
        AND whatsapp_number IS NOT NULL
    )
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'VERIFIED_PILOT_RECIPIENT_REQUIRED',
      'message', 'Verify and opt in at least one pilot parent or staff WhatsApp recipient before activation.'
    );
  END IF;

  UPDATE public.attendance_notification_providers
  SET status = 'active', is_default = true, updated_at = now()
  WHERE provider_code = 'meta_whatsapp_cloud';

  UPDATE public.attendance_notification_providers
  SET is_default = false, updated_at = now()
  WHERE channel = 'whatsapp'
    AND provider_code <> 'meta_whatsapp_cloud';

  UPDATE public.school_notification_config
  SET delivery_enabled = true,
      dry_run = false,
      active_provider_code = 'meta_whatsapp_cloud',
      automatic_queue = true,
      production_activation_note = 'Meta WhatsApp Cloud API activated through the protected Vercel/Vault worker after readiness checks.',
      metadata = metadata || jsonb_build_object(
        'delivery_gateway', 'vercel_vault',
        'worker_mode', 'scheduled',
        'activated_at', now()
      ),
      updated_at = now()
  WHERE singleton = true;

  UPDATE public.school_meta_whatsapp_config
  SET activated_at = now(),
      activated_by = p_client_code,
      updated_at = now()
  WHERE singleton = true;

  INSERT INTO public.attendance_admin_audit(
    admin_client_id, action, entity_type, entity_id, details
  ) VALUES (
    v_admin,
    'notification.meta.activate',
    'school_meta_whatsapp_config',
    'singleton',
    jsonb_build_object('provider', 'meta_whatsapp_cloud', 'gateway', 'vercel_vault')
  );

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'META_WHATSAPP_LIVE_ACTIVATED',
    'gateway', 'vercel_vault'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.school_meta_whatsapp_status_api(
  p_client_code text,
  p_client_secret text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'extensions'
AS $function$
DECLARE
  v_admin uuid;
  v_cfg public.school_meta_whatsapp_config%rowtype;
BEGIN
  v_admin := public.school_registry_verify_admin(
    p_client_code,
    p_client_secret,
    'notifications.manage'
  );
  IF v_admin IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ADMIN_AUTH_OR_PERMISSION_FAILED');
  END IF;

  SELECT * INTO v_cfg
  FROM public.school_meta_whatsapp_config
  WHERE singleton = true;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'META_WHATSAPP_STATUS_READY',
    'phone_number_id', v_cfg.phone_number_id,
    'business_account_id', v_cfg.business_account_id,
    'graph_version', v_cfg.graph_version,
    'webhook_url', v_cfg.webhook_url,
    'template_map', v_cfg.template_map,
    'access_token_configured', v_cfg.access_token_secret_id IS NOT NULL,
    'app_secret_configured', v_cfg.app_secret_secret_id IS NOT NULL,
    'verify_token_configured', v_cfg.verify_token_secret_id IS NOT NULL,
    'last_test_at', v_cfg.last_test_at,
    'last_test_status', v_cfg.last_test_status,
    'last_test_details', v_cfg.last_test_details,
    'activated_at', v_cfg.activated_at,
    'activated_by', v_cfg.activated_by,
    'approved_template_count', (
      SELECT count(*)
      FROM public.school_notification_templates
      WHERE status = 'active'
        AND channel = 'whatsapp'
        AND provider_template_status = 'approved'
        AND NULLIF(provider_template_name, '') IS NOT NULL
    ),
    'verified_pilot_count', (
      SELECT
        (SELECT count(*) FROM public.attendance_guardian_contacts
          WHERE status = 'active' AND pilot_enabled = true
            AND whatsapp_opt_in_status = 'opted_in'
            AND whatsapp_verified_at IS NOT NULL
            AND whatsapp_number IS NOT NULL)
        +
        (SELECT count(*) FROM public.staff_attendance_profiles
          WHERE employment_status = 'active' AND pilot_enabled = true
            AND whatsapp_opt_in_status = 'opted_in'
            AND whatsapp_verified_at IS NOT NULL
            AND whatsapp_number IS NOT NULL)
    ),
    'worker_gateway', 'vercel_vault',
    'worker_schedule_installed', EXISTS (
      SELECT 1 FROM cron.job
      WHERE jobname = 'wts-school-notification-meta-worker'
        AND active = true
    ),
    'provider', (
      SELECT jsonb_build_object(
        'status', status,
        'is_default', is_default,
        'last_test_status', last_test_status
      )
      FROM public.attendance_notification_providers
      WHERE provider_code = 'meta_whatsapp_cloud'
    ),
    'delivery', (
      SELECT jsonb_build_object(
        'delivery_enabled', delivery_enabled,
        'dry_run', dry_run,
        'active_provider_code', active_provider_code,
        'automatic_queue', automatic_queue
      )
      FROM public.school_notification_config
      WHERE singleton = true
    ),
    'templates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'event_type', event_type,
        'language_code', language_code,
        'provider_template_name', provider_template_name,
        'provider_template_status', provider_template_status
      ) ORDER BY event_type, language_code)
      FROM public.school_notification_templates
      WHERE status = 'active'
    ), '[]'::jsonb)
  );
END;
$function$;

UPDATE public.attendance_notification_providers
SET status = 'disabled',
    is_default = false,
    configuration = configuration || jsonb_build_object(
      'retired_for_delivery', true,
      'replacement_gateway', 'https://wts-notification-system.vercel.app/api/meta-dispatch'
    ),
    updated_at = now()
WHERE provider_code = 'external_whatsapp_gateway';

UPDATE public.attendance_notification_providers
SET configuration = configuration || jsonb_build_object(
      'gateway', 'vercel_vault',
      'dispatch_url', 'https://wts-notification-system.vercel.app/api/meta-dispatch'
    ),
    updated_at = now()
WHERE provider_code = 'meta_whatsapp_cloud';

UPDATE public.school_notification_config
SET metadata = metadata || jsonb_build_object(
      'delivery_gateway', 'vercel_vault',
      'legacy_edge_dispatch', 'compatibility_proxy_only'
    ),
    updated_at = now()
WHERE singleton = true;

REVOKE ALL ON FUNCTION public.school_notification_worker_token_valid() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.school_notification_worker_token_valid() TO service_role;

REVOKE ALL ON FUNCTION public.school_meta_whatsapp_runtime_config_worker() FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.school_meta_whatsapp_claim_worker(text, integer) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.school_meta_whatsapp_complete_worker(uuid, text, boolean, text, jsonb, text, text, integer) FROM PUBLIC, authenticated;

GRANT EXECUTE ON FUNCTION public.school_meta_whatsapp_runtime_config_worker() TO anon, service_role;
GRANT EXECUTE ON FUNCTION public.school_meta_whatsapp_claim_worker(text, integer) TO anon, service_role;
GRANT EXECUTE ON FUNCTION public.school_meta_whatsapp_complete_worker(uuid, text, boolean, text, jsonb, text, text, integer) TO anon, service_role;
