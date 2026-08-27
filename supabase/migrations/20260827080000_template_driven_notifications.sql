-- Use the approved Bahasha template as the message source.
-- The management screen supplies only the template, class and recipients.

create or replace function public.school_notification_template_send_api(
  p_client_code text,
  p_client_secret text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'extensions'
as $function$
declare
  v_admin uuid;
  v_client public.attendance_admin_clients%rowtype;
  v_config public.school_notification_config%rowtype;
  v_provider public.attendance_notification_providers%rowtype;
  v_batch_id uuid := gen_random_uuid();
  v_class_key text := nullif(trim(coalesce(p_payload->>'classKey', '')), '');
  v_audience text := lower(coalesce(nullif(trim(p_payload->>'audience'), ''), 'all'));
  v_template_name text := nullif(trim(coalesce(p_payload->>'whatsappTemplateName', '')), '');
  v_template_language text := coalesce(nullif(trim(p_payload->>'whatsappTemplateLanguage'), ''), 'en_US');
  v_language_code text := case lower(v_template_language)
    when 'yo' then 'yo'
    when 'both' then 'both'
    else 'en'
  end;
  v_selected jsonb := coalesce(p_payload->'selectedRecipients', '[]'::jsonb);
  v_contact_ids jsonb := coalesce(p_payload->'contactIds', '[]'::jsonb);
  v_created integer := 0;
  v_queued integer := 0;
begin
  v_admin := public.school_registry_verify_admin(
    p_client_code,
    p_client_secret,
    'notifications.manage'
  );
  if v_admin is null then
    return jsonb_build_object('ok', false, 'code', 'ADMIN_AUTH_OR_PERMISSION_FAILED');
  end if;

  select * into v_client
  from public.attendance_admin_clients
  where id = v_admin;

  select * into v_config
  from public.school_notification_config
  where singleton = true;

  if v_class_key is null or v_class_key = 'all' then
    return jsonb_build_object('ok', false, 'code', 'CLASS_REQUIRED');
  end if;
  if not exists (
    select 1 from public.school_classes
    where class_key = v_class_key and is_active = true
  ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CLASS');
  end if;
  if v_audience not in ('all', 'selected') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_AUDIENCE');
  end if;
  if v_audience = 'selected'
     and jsonb_typeof(v_selected) = 'array'
     and jsonb_typeof(v_contact_ids) = 'array'
     and jsonb_array_length(v_selected) = 0
     and jsonb_array_length(v_contact_ids) = 0 then
    return jsonb_build_object('ok', false, 'code', 'SELECTED_RECIPIENTS_REQUIRED');
  end if;
  if v_template_name is null then
    return jsonb_build_object('ok', false, 'code', 'APPROVED_TEMPLATE_REQUIRED');
  end if;
  if jsonb_typeof(v_selected) <> 'array' or jsonb_typeof(v_contact_ids) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_SELECTED_RECIPIENT');
  end if;

  -- The shared provider row keeps its historical code for compatibility with
  -- the existing claim/complete routines; its delivery adapter is Bahasha.
  select * into v_provider
  from public.attendance_notification_providers
  where provider_code = 'meta_whatsapp_cloud';

  if not found
     or v_provider.status <> 'active'
     or coalesce(v_provider.configuration->>'delivery_adapter', '') <> 'bahasha' then
    return jsonb_build_object('ok', false, 'code', 'BAHASHA_LIVE_PROVIDER_NOT_READY');
  end if;
  if not coalesce(v_config.delivery_enabled, false)
     or coalesce(v_config.dry_run, true) then
    return jsonb_build_object('ok', false, 'code', 'BAHASHA_LIVE_DELIVERY_NOT_ENABLED');
  end if;
  if not ('whatsapp' = any(v_config.allowed_channels)) then
    return jsonb_build_object('ok', false, 'code', 'WHATSAPP_CHANNEL_NOT_ALLOWED');
  end if;

  with base as (
    select
      g.id as member_id,
      g.student_id,
      g.guardian_name,
      g.relationship,
      g.whatsapp_number,
      g.whatsapp_opt_in_status,
      g.whatsapp_opt_in_at,
      g.whatsapp_opt_in_source,
      g.whatsapp_verified_at is not null as verified,
      g.pilot_enabled,
      g.is_primary,
      s.name as student_name,
      s.class_key,
      coalesce(c.display_name, s.class_key) as class_name,
      s.admno,
      public.school_normalize_nigerian_phone(g.whatsapp_number) as destination
    from public.attendance_guardian_contacts g
    join public.students s on s.id = g.student_id
    left join public.school_classes c on c.class_key = s.class_key
    where g.status = 'active'
      and coalesce(s.archived, false) = false
      and s.class_key = v_class_key
      and public.school_normalize_nigerian_phone(g.whatsapp_number) is not null
      and g.whatsapp_opt_in_status = 'opted_in'
      and (
        v_audience <> 'selected'
        or g.id::text in (select jsonb_array_elements_text(v_contact_ids))
        or exists (
          select 1
          from jsonb_array_elements(v_selected) z
          where z->>'type' in ('guardian_group', 'guardian', 'parent')
            and (
              z->>'id' = public.school_normalize_nigerian_phone(g.whatsapp_number)
              or z->>'id' = 'phone:' || public.school_normalize_nigerian_phone(g.whatsapp_number)
              or z->>'id' = g.id::text
            )
        )
      )
  ), grouped as (
    select
      b.destination as group_key,
      (array_agg(b.member_id order by b.is_primary desc, b.guardian_name, b.member_id))[1] as recipient_id,
      (array_agg(b.guardian_name order by b.is_primary desc, b.guardian_name, b.member_id))[1] as recipient_name,
      (array_agg(b.student_id order by b.class_name, b.student_name, b.member_id))[1] as linked_id,
      (array_agg(b.student_name order by b.class_name, b.student_name, b.member_id))[1] as associated_name,
      string_agg(distinct b.class_name, ', ' order by b.class_name) as group_name,
      min(b.destination) as destination,
      bool_and(b.verified) as all_verified,
      min(b.whatsapp_opt_in_at) as consent_at,
      (array_agg(b.whatsapp_opt_in_source order by b.is_primary desc, b.member_id))[1] as consent_source,
      array_agg(b.member_id order by b.class_name, b.student_name, b.member_id) as member_ids,
      array_agg(b.student_id order by b.class_name, b.student_name, b.member_id) as student_ids,
      count(*)::integer as member_count,
      string_agg(b.student_name || ' (' || b.class_name || ')', ', ' order by b.class_name, b.student_name) as children_summary,
      jsonb_agg(
        jsonb_build_object(
          'contact_id', b.member_id,
          'student_id', b.student_id,
          'name', b.student_name,
          'class_key', b.class_key,
          'class_name', b.class_name,
          'admno', b.admno,
          'relationship', b.relationship,
          'consent_status', b.whatsapp_opt_in_status,
          'verified', b.verified
        ) order by b.class_name, b.student_name, b.member_id
      ) as children
    from base b
    group by b.destination
  ), eligible as (
    select g.*
    from grouped g
    where not coalesce(v_config.require_verified_guardian, false) or g.all_verified
  ), inserted as (
    insert into public.school_notification_messages(
      source_system,
      source_event_type,
      source_event_id,
      recipient_type,
      recipient_id,
      recipient_name,
      channel,
      destination,
      template_id,
      subject,
      message,
      payload,
      status,
      scheduled_at,
      next_attempt_at,
      language_code,
      delivery_mode,
      consent_snapshot,
      approved_at,
      approved_by
    )
    select
      'general',
      'template_send',
      v_batch_id::text || ':guardian:' || md5(e.group_key),
      'guardian',
      e.recipient_id,
      e.recipient_name,
      'whatsapp',
      e.destination,
      null,
      null,
      v_template_name,
      jsonb_strip_nulls(jsonb_build_object(
        'template_only', true,
        'batch_id', v_batch_id,
        'group_key', e.group_key,
        'member_ids', to_jsonb(e.member_ids),
        'student_ids', to_jsonb(e.student_ids),
        'children', e.children,
        'children_summary', e.children_summary,
        'child_count', e.member_count,
        'associated_name', e.associated_name,
        'group_name', e.group_name,
        'audience', v_audience,
        'class_key', v_class_key,
        'whatsapp_template_name', v_template_name,
        'whatsapp_template_language', v_template_language
      )),
      'queued',
      now(),
      now(),
      v_language_code,
      'live',
      jsonb_build_object(
        'status', 'opted_in',
        'recorded_at', e.consent_at,
        'source', e.consent_source,
        'verified', e.all_verified,
        'channel', 'whatsapp',
        'member_count', e.member_count,
        'member_ids', to_jsonb(e.member_ids)
      ),
      now(),
      v_client.client_code
    from eligible e
    returning id
  )
  select count(*)::integer, count(*)::integer
  into v_created, v_queued
  from inserted;

  if v_created = 0 then
    return jsonb_build_object(
      'ok', false,
      'code', 'NO_ELIGIBLE_PARENT_GROUPS',
      'class_key', v_class_key,
      'audience', v_audience
    );
  end if;

  insert into public.attendance_admin_audit(
    admin_client_id,
    action,
    entity_type,
    entity_id,
    details
  ) values (
    v_admin,
    'notification.template_send.create',
    'notification_batch',
    v_batch_id::text,
    jsonb_build_object(
      'audience', v_audience,
      'class_key', v_class_key,
      'template_name', v_template_name,
      'template_language', v_template_language,
      'created', v_created,
      'queued', v_queued
    )
  );

  return jsonb_build_object(
    'ok', true,
    'code', 'TEMPLATE_MESSAGES_QUEUED',
    'batch_id', v_batch_id,
    'created', v_created,
    'queued', v_queued,
    'parent_groups', v_created,
    'status', 'queued',
    'class_key', v_class_key,
    'template_name', v_template_name,
    'template_language', v_template_language
  );
exception
  when invalid_text_representation then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT_FORMAT');
  when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'DUPLICATE_TEMPLATE_SEND');
end;
$function$;

-- Draft cleanup is deliberately separate from the send API. It cannot delete
-- queued, sending, sent or failed delivery records.
create or replace function public.school_notification_message_admin_write_api(
  p_client_code text,
  p_client_secret text,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'extensions'
as $function$
declare
  v_admin uuid;
  v_message_id uuid;
  v_keep_id uuid;
  v_deleted integer := 0;
  v_request uuid := gen_random_uuid();
begin
  v_admin := public.school_registry_verify_admin(
    p_client_code,
    p_client_secret,
    'notifications.manage'
  );
  if v_admin is null then
    return jsonb_build_object('ok', false, 'code', 'ADMIN_AUTH_OR_PERMISSION_FAILED');
  end if;

  if p_action = 'deleteMessage' then
    begin
      v_message_id := nullif(trim(p_payload->>'messageId'), '')::uuid;
    exception when others then
      return jsonb_build_object('ok', false, 'code', 'INVALID_MESSAGE_ID');
    end;

    delete from public.school_notification_messages
    where id = v_message_id
      and status in ('draft', 'cancelled', 'skipped');
    get diagnostics v_deleted = row_count;
    if v_deleted = 0 then
      return jsonb_build_object('ok', false, 'code', 'MESSAGE_NOT_DELETABLE');
    end if;

    insert into public.attendance_admin_audit(
      admin_client_id, action, entity_type, entity_id, request_id
    ) values (
      v_admin, 'notification.message.delete', 'notification_message',
      v_message_id::text, v_request
    );
    return jsonb_build_object(
      'ok', true,
      'code', 'NOTIFICATION_MESSAGE_DELETED',
      'deleted', v_deleted,
      'message_id', v_message_id,
      'request_id', v_request
    );
  end if;

  if p_action = 'deleteDrafts' then
    begin
      v_keep_id := nullif(trim(p_payload->>'keepMessageId'), '')::uuid;
    exception when others then
      v_keep_id := null;
    end;

    delete from public.school_notification_messages
    where status in ('draft', 'cancelled', 'skipped')
      and (v_keep_id is null or id <> v_keep_id);
    get diagnostics v_deleted = row_count;

    insert into public.attendance_admin_audit(
      admin_client_id, action, entity_type, entity_id, request_id, details
    ) values (
      v_admin, 'notification.message.delete_drafts', 'notification_messages',
      'drafts', v_request, jsonb_build_object('deleted', v_deleted, 'kept', v_keep_id)
    );
    return jsonb_build_object(
      'ok', true,
      'code', 'NOTIFICATION_DRAFTS_DELETED',
      'deleted', v_deleted,
      'request_id', v_request
    );
  end if;

  return jsonb_build_object('ok', false, 'code', 'UNKNOWN_ACTION');
exception
  when invalid_text_representation then
    return jsonb_build_object('ok', false, 'code', 'INVALID_MESSAGE_ID');
end;
$function$;

grant execute on function public.school_notification_template_send_api(text, text, jsonb) to anon, authenticated;
grant execute on function public.school_notification_message_admin_write_api(text, text, text, jsonb) to anon, authenticated;
