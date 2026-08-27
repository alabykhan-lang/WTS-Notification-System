-- Parent-level notification groups and class-scoped guardian imports.
-- The child-level attendance contact rows remain intact for audit and
-- attendance delivery.  Only the directory and bulk-send boundary groups
-- them by normalized WhatsApp destination.

create extension if not exists pgcrypto;

alter table public.attendance_guardian_import_batches
  add column if not exists class_key text;

create index if not exists attendance_guardian_contacts_whatsapp_group_idx
  on public.attendance_guardian_contacts (whatsapp_number, status, whatsapp_opt_in_status);

create index if not exists attendance_guardian_contacts_student_status_idx
  on public.attendance_guardian_contacts (student_id, status);

create index if not exists students_class_active_idx
  on public.students (class_key, archived, lifecycle_status);

create or replace function public.school_notification_recipient_admin_read_api(
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
  v_search text := lower(trim(coalesce(p_payload->>'search', '')));
  v_type text := lower(coalesce(nullif(trim(p_payload->>'recipientType'), ''), 'all'));
  v_status text := nullif(trim(coalesce(p_payload->>'status', '')), '');
  v_pilot_only boolean := coalesce((p_payload->>'pilotOnly')::boolean, false);
  v_class_key text := nullif(trim(coalesce(p_payload->>'classKey', '')), '');
  v_limit integer := greatest(1, least(coalesce((p_payload->>'limit')::integer, 1000), 2000));
  v_result jsonb;
begin
  v_admin := public.school_registry_verify_admin(
    p_client_code,
    p_client_secret,
    'notifications.manage'
  );
  if v_admin is null then
    return jsonb_build_object('ok', false, 'code', 'ADMIN_AUTH_OR_PERMISSION_FAILED');
  end if;

  if v_class_key = 'all' then
    v_class_key := null;
  end if;

  if p_action = 'summary' then
    with groups as (
      select
        coalesce(
          public.school_normalize_nigerian_phone(g.whatsapp_number),
          'contact:' || g.id::text
        ) as group_key,
        bool_and(g.pilot_enabled) as pilot_enabled,
        bool_and(g.whatsapp_opt_in_status = 'opted_in') as all_opted_in,
        bool_and(g.whatsapp_verified_at is not null) as all_verified
      from public.attendance_guardian_contacts g
      join public.students s on s.id = g.student_id
      where g.status = 'active'
        and coalesce(s.archived, false) = false
      group by 1
    )
    select jsonb_build_object(
      'ok', true,
      'guardians', jsonb_build_object(
        'total', (select count(*) from groups),
        'pilot', (select count(*) from groups where pilot_enabled),
        'opted_in', (select count(*) from groups where all_opted_in),
        'verified', (select count(*) from groups where all_verified)
      ),
      'staff', jsonb_build_object(
        'total', (select count(*) from public.staff_attendance_profiles where employment_status = 'active'),
        'pilot', (select count(*) from public.staff_attendance_profiles where employment_status = 'active' and pilot_enabled),
        'opted_in', (select count(*) from public.staff_attendance_profiles where employment_status = 'active' and whatsapp_opt_in_status = 'opted_in'),
        'verified', (select count(*) from public.staff_attendance_profiles where employment_status = 'active' and whatsapp_verified_at is not null)
      )
    ) into v_result;
    return v_result;
  end if;

  if p_action = 'classes' then
    select jsonb_build_object(
      'ok', true,
      'classes', coalesce(jsonb_agg(to_jsonb(c) order by c.sort_order, c.display_name), '[]'::jsonb)
    )
    into v_result
    from (
      select
        c.id,
        c.class_key,
        c.display_name,
        c.section,
        c.sort_order,
        c.is_active,
        count(s.id)::integer as student_count
      from public.school_classes c
      left join public.students s
        on s.class_key = c.class_key
       and coalesce(s.archived, false) = false
      where c.is_active = true
      group by c.id, c.class_key, c.display_name, c.section, c.sort_order, c.is_active
    ) c;
    return v_result;
  end if;

  if p_action = 'recipients' then
    with base as (
      select
        g.id as member_id,
        g.student_id,
        g.guardian_name,
        g.relationship,
        g.phone,
        g.whatsapp_number,
        g.whatsapp_opt_in_status,
        g.whatsapp_opt_in_at,
        g.whatsapp_opt_in_source,
        g.whatsapp_verified_at is not null as verified,
        g.preferred_language,
        g.pilot_enabled,
        g.is_primary,
        g.status as record_status,
        s.name as student_name,
        s.class_key,
        coalesce(c.display_name, s.class_key) as class_name,
        s.admno,
        public.school_normalize_nigerian_phone(g.whatsapp_number) as normalized_whatsapp,
        coalesce(
          public.school_normalize_nigerian_phone(g.whatsapp_number),
          'contact:' || g.id::text
        ) as group_key
      from public.attendance_guardian_contacts g
      join public.students s on s.id = g.student_id
      left join public.school_classes c on c.class_key = s.class_key
      where g.status = 'active'
        and coalesce(s.archived, false) = false
        and (v_class_key is null or s.class_key = v_class_key)
        and (
          v_search = ''
          or lower(coalesce(g.guardian_name, '')) like '%' || v_search || '%'
          or lower(coalesce(s.name, '')) like '%' || v_search || '%'
          or lower(coalesce(g.phone, '')) like '%' || v_search || '%'
          or lower(coalesce(g.whatsapp_number, '')) like '%' || v_search || '%'
          or lower(coalesce(s.admno, '')) like '%' || v_search || '%'
          or lower(coalesce(c.display_name, s.class_key, '')) like '%' || v_search || '%'
        )
        and (v_status is null or g.whatsapp_opt_in_status = v_status)
        and (not v_pilot_only or g.pilot_enabled)
    ), grouped as (
      select
        b.group_key,
        (array_agg(b.member_id order by b.is_primary desc, b.guardian_name, b.member_id))[1] as recipient_id,
        (array_agg(b.guardian_name order by b.is_primary desc, b.guardian_name, b.member_id))[1] as display_name,
        (array_agg(b.student_name order by b.class_name, b.student_name, b.member_id))[1] as associated_name,
        string_agg(distinct b.class_name, ', ' order by b.class_name) as group_name,
        (array_agg(b.admno order by b.class_name, b.student_name, b.member_id))[1] as reference_number,
        min(b.phone) as sms_number,
        min(b.normalized_whatsapp) as whatsapp_number,
        case
          when bool_and(b.whatsapp_opt_in_status = 'opted_in') then 'opted_in'
          when bool_or(b.whatsapp_opt_in_status = 'revoked') then 'revoked'
          when bool_or(b.whatsapp_opt_in_status = 'opted_out') then 'opted_out'
          when bool_or(b.whatsapp_opt_in_status = 'opted_in') then 'partial'
          else 'pending'
        end as consent_status,
        bool_and(b.verified) as verified,
        bool_and(b.pilot_enabled) as pilot_enabled,
        bool_and(
          b.normalized_whatsapp is not null
          and b.whatsapp_opt_in_status = 'opted_in'
          and (
            not coalesce((select require_verified_guardian from public.school_notification_config where singleton = true), false)
            or b.verified
          )
        ) as eligible,
        (array_agg(b.preferred_language order by b.is_primary desc, b.member_id))[1] as preferred_language,
        (array_agg(b.record_status order by b.member_id))[1] as record_status,
        (array_agg(b.relationship order by b.is_primary desc, b.member_id))[1] as detail,
        (array_agg(b.student_id order by b.class_name, b.student_name, b.member_id))[1] as linked_person_id,
        array_agg(b.member_id order by b.class_name, b.student_name, b.member_id) as member_ids,
        array_agg(b.student_id order by b.class_name, b.student_name, b.member_id) as student_ids,
        count(*)::integer as member_count,
        count(*)::integer as child_count,
        array_agg(distinct b.class_key order by b.class_key) as classes,
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
          )
          order by b.class_name, b.student_name, b.member_id
        ) as children
      from base b
      group by b.group_key
    ), guardian_rows as (
      select *
      from grouped g
      where v_type in ('all', 'guardian')
        and (v_status is null or g.consent_status = v_status)
      order by g.display_name, g.group_key
      limit v_limit
    ), staff_rows as (
      select jsonb_build_object(
        'group_key', 'staff:' || p.id::text,
        'recipient_id', p.id,
        'recipient_type', 'staff',
        'display_name', p.full_name,
        'associated_name', coalesce(p.designation, p.staff_category),
        'group_name', p.staff_category,
        'reference_number', p.staff_number,
        'sms_number', p.phone,
        'whatsapp_number', public.school_normalize_nigerian_phone(p.whatsapp_number),
        'consent_status', p.whatsapp_opt_in_status,
        'verified', p.whatsapp_verified_at is not null,
        'eligible', p.whatsapp_number is not null
          and p.whatsapp_opt_in_status = 'opted_in'
          and (
            not coalesce((select require_verified_guardian from public.school_notification_config where singleton = true), false)
            or p.whatsapp_verified_at is not null
          ),
        'preferred_language', p.preferred_language,
        'pilot_enabled', p.pilot_enabled,
        'record_status', p.employment_status,
        'detail', p.department,
        'linked_person_id', p.id,
        'member_ids', jsonb_build_array(p.id),
        'student_ids', '[]'::jsonb,
        'member_count', 1,
        'child_count', 0,
        'classes', '[]'::jsonb,
        'children', '[]'::jsonb
      ) as row
      from public.staff_attendance_profiles p
      where p.employment_status = 'active'
        and v_type in ('all', 'staff')
        and (v_status is null or p.whatsapp_opt_in_status = v_status)
        and (not v_pilot_only or p.pilot_enabled)
        and (
          v_search = ''
          or lower(coalesce(p.full_name, '')) like '%' || v_search || '%'
          or lower(coalesce(p.phone, '')) like '%' || v_search || '%'
          or lower(coalesce(p.whatsapp_number, '')) like '%' || v_search || '%'
          or lower(coalesce(p.staff_number, '')) like '%' || v_search || '%'
        )
      order by p.full_name
      limit v_limit
    )
    select jsonb_build_object(
      'ok', true,
      'scope', jsonb_build_object('class_key', coalesce(v_class_key, 'all')),
      'recipients',
        coalesce(
          (select jsonb_agg(
             jsonb_build_object(
               'group_key', g.group_key,
               'recipient_id', g.recipient_id,
               'recipient_type', 'guardian',
               'display_name', g.display_name,
               'associated_name', g.associated_name,
               'group_name', g.group_name,
               'reference_number', g.reference_number,
               'sms_number', g.sms_number,
               'whatsapp_number', g.whatsapp_number,
               'consent_status', g.consent_status,
               'verified', g.verified,
               'eligible', g.eligible,
               'preferred_language', g.preferred_language,
               'pilot_enabled', g.pilot_enabled,
               'record_status', g.record_status,
               'detail', g.detail,
               'linked_person_id', g.linked_person_id,
               'member_ids', to_jsonb(g.member_ids),
               'student_ids', to_jsonb(g.student_ids),
               'member_count', g.member_count,
               'child_count', g.child_count,
               'classes', to_jsonb(g.classes),
               'children', g.children
             ) order by g.display_name, g.group_key
           ) from guardian_rows g),
          '[]'::jsonb
        )
        || coalesce((select jsonb_agg(row) from staff_rows), '[]'::jsonb)
    ) into v_result;
    return v_result;
  end if;

  return jsonb_build_object('ok', false, 'code', 'UNKNOWN_ACTION');
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT_FORMAT');
end;
$function$;

create or replace function public.school_notification_bulk_message_api(
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
  v_batch_id uuid := gen_random_uuid();
  v_audience text := coalesce(nullif(trim(p_payload->>'audience'), ''), 'pilot');
  v_recipient_group text := coalesce(nullif(trim(p_payload->>'recipientGroup'), ''), 'all');
  v_channel text := coalesce(nullif(trim(p_payload->>'channel'), ''), 'whatsapp');
  v_language text := case lower(coalesce(p_payload->>'languageCode', 'en')) when 'yo' then 'yo' when 'both' then 'both' else 'en' end;
  v_purpose text := coalesce(nullif(trim(p_payload->>'purpose'), ''), 'general_announcement');
  v_message text := trim(coalesce(p_payload->>'message', ''));
  v_queue_requested boolean := coalesce((p_payload->>'queueNow')::boolean, false);
  v_selected jsonb := coalesce(p_payload->'selectedRecipients', '[]'::jsonb);
  v_contact_ids jsonb := coalesce(p_payload->'contactIds', '[]'::jsonb);
  v_class_key text := nullif(trim(coalesce(p_payload->>'classKey', '')), '');
  v_template_id uuid := null;
  v_template_name text := nullif(trim(coalesce(p_payload->>'whatsappTemplateName', '')), '');
  v_template_language text := nullif(trim(coalesce(p_payload->>'whatsappTemplateLanguage', '')), '');
  v_status text;
  v_created integer := 0;
  v_queued integer := 0;
  v_groups integer := 0;
begin
  v_admin := public.school_registry_verify_admin(p_client_code, p_client_secret, 'notifications.manage');
  if v_admin is null then
    return jsonb_build_object('ok', false, 'code', 'ADMIN_AUTH_OR_PERMISSION_FAILED');
  end if;

  select * into v_client from public.attendance_admin_clients where id = v_admin;
  select * into v_config from public.school_notification_config where singleton = true;

  if v_class_key = 'all' then v_class_key := null; end if;
  if v_class_key is not null and not exists (
    select 1 from public.school_classes where class_key = v_class_key and is_active = true
  ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CLASS');
  end if;

  begin
    v_template_id := nullif(trim(coalesce(p_payload->>'templateId', '')), '')::uuid;
  exception when invalid_text_representation then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TEMPLATE_ID');
  end;

  if v_audience not in ('pilot', 'all', 'selected') then return jsonb_build_object('ok', false, 'code', 'INVALID_AUDIENCE'); end if;
  if v_recipient_group not in ('all', 'guardian', 'staff') then return jsonb_build_object('ok', false, 'code', 'INVALID_RECIPIENT_GROUP'); end if;
  if v_channel not in ('whatsapp', 'sms') then return jsonb_build_object('ok', false, 'code', 'INVALID_CHANNEL'); end if;
  if v_purpose not in ('general_announcement', 'academic_result', 'academic_performance', 'attendance', 'fees', 'emergency') then return jsonb_build_object('ok', false, 'code', 'INVALID_MESSAGE_PURPOSE'); end if;
  if v_message = '' then return jsonb_build_object('ok', false, 'code', 'MESSAGE_REQUIRED'); end if;
  if length(v_message) > 4000 then return jsonb_build_object('ok', false, 'code', 'MESSAGE_TOO_LONG'); end if;
  if jsonb_typeof(v_selected) <> 'array' or jsonb_typeof(v_contact_ids) <> 'array' then return jsonb_build_object('ok', false, 'code', 'INVALID_SELECTED_RECIPIENT'); end if;
  if v_audience = 'selected' and jsonb_array_length(v_selected) = 0 and jsonb_array_length(v_contact_ids) = 0 then return jsonb_build_object('ok', false, 'code', 'SELECTED_RECIPIENTS_REQUIRED'); end if;
  if v_template_id is not null and not exists (
    select 1 from public.school_notification_templates where id = v_template_id and status = 'active'
  ) then
    return jsonb_build_object('ok', false, 'code', 'ACTIVE_TEMPLATE_NOT_FOUND');
  end if;

  v_status := case
    when v_queue_requested
      and coalesce(v_config.delivery_enabled, false)
      and v_channel = any(v_config.allowed_channels)
    then 'queued'
    else 'draft'
  end;

  with base as (
    select
      g.id as member_id,
      g.student_id,
      g.guardian_name,
      g.relationship,
      g.phone,
      g.whatsapp_number,
      g.whatsapp_opt_in_status,
      g.whatsapp_opt_in_at,
      g.whatsapp_opt_in_source,
      (g.whatsapp_verified_at is not null) as verified,
      g.preferred_channels,
      g.preferred_language,
      g.pilot_enabled,
      g.is_primary,
      s.name as student_name,
      s.class_key,
      coalesce(c.display_name, s.class_key) as class_name,
      s.admno,
      public.school_normalize_nigerian_phone(
        case when v_channel = 'whatsapp' then g.whatsapp_number else g.phone end
      ) as destination,
      case
        when v_channel = 'whatsapp' then g.whatsapp_opt_in_status = 'opted_in'
        else 'sms' = any(g.preferred_channels)
      end as consent_ready
    from public.attendance_guardian_contacts g
    join public.students s on s.id = g.student_id
    left join public.school_classes c on c.class_key = s.class_key
    where g.status = 'active'
      and coalesce(s.archived, false) = false
      and v_recipient_group in ('all', 'guardian')
      and (v_class_key is null or s.class_key = v_class_key)
      and (
        v_audience <> 'pilot'
        or g.pilot_enabled
      )
      and public.school_normalize_nigerian_phone(
        case when v_channel = 'whatsapp' then g.whatsapp_number else g.phone end
      ) is not null
      and (
        v_audience <> 'selected'
        or g.id::text in (select jsonb_array_elements_text(v_contact_ids))
        or exists (
          select 1
          from jsonb_array_elements(v_selected) z
          where (z->>'type' = 'guardian' and z->>'id' = g.id::text)
             or (
               z->>'type' in ('guardian_group', 'parent')
               and z->>'id' = 'phone:' || public.school_normalize_nigerian_phone(g.whatsapp_number)
             )
        )
      )
  ), grouped as (
    select
      'phone:' || b.destination as group_key,
      (array_agg(b.member_id order by b.is_primary desc, b.guardian_name, b.member_id))[1] as recipient_id,
      (array_agg(b.guardian_name order by b.is_primary desc, b.guardian_name, b.member_id))[1] as recipient_name,
      (array_agg(b.student_id order by b.class_name, b.student_name, b.member_id))[1] as linked_id,
      (array_agg(b.student_name order by b.class_name, b.student_name, b.member_id))[1] as associated_name,
      string_agg(distinct b.class_name, ', ' order by b.class_name) as group_name,
      (array_agg(b.admno order by b.class_name, b.student_name, b.member_id))[1] as reference_number,
      min(b.destination) as destination,
      bool_and(b.consent_ready) as all_consent_ready,
      bool_and(b.verified) as all_verified,
      bool_and(b.pilot_enabled) as all_pilot,
      min(b.whatsapp_opt_in_at) as consent_at,
      (array_agg(b.whatsapp_opt_in_source order by b.is_primary desc, b.member_id))[1] as consent_source,
      (array_agg(b.preferred_language order by b.is_primary desc, b.member_id))[1] as preferred_language,
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
          'consent_status', case when b.consent_ready then 'opted_in' else b.whatsapp_opt_in_status end,
          'verified', b.verified
        ) order by b.class_name, b.student_name, b.member_id
      ) as children
    from base b
    group by b.destination
  ), eligible_guardians as (
    select
      g.*,
      'guardian'::text as recipient_type,
      case when v_channel = 'whatsapp' then 'opted_in' else 'ready' end as consent_status,
      (v_channel <> 'whatsapp' or g.all_verified or not coalesce(v_config.require_verified_guardian, false)) as group_verified,
      g.all_pilot as group_pilot
    from grouped g
    where g.all_consent_ready
      and (v_channel <> 'whatsapp' or not coalesce(v_config.require_verified_guardian, false) or g.all_verified)
      and (v_audience <> 'pilot' or g.all_pilot)
  ), eligible_staff as (
    select
      'staff:' || p.id::text as group_key,
      p.id as recipient_id,
      p.full_name as recipient_name,
      p.id as linked_id,
      coalesce(p.designation, p.staff_category) as associated_name,
      p.staff_category as group_name,
      p.staff_number as reference_number,
      public.school_normalize_nigerian_phone(case when v_channel = 'whatsapp' then p.whatsapp_number else p.phone end) as destination,
      true as all_consent_ready,
      (p.whatsapp_verified_at is not null) as all_verified,
      p.pilot_enabled as all_pilot,
      null::timestamptz as consent_at,
      p.whatsapp_opt_in_source as consent_source,
      p.preferred_language,
      array[p.id]::uuid[] as member_ids,
      array[]::uuid[] as student_ids,
      0::integer as member_count,
      ''::text as children_summary,
      '[]'::jsonb as children,
      'staff'::text as recipient_type,
      case when v_channel = 'whatsapp' then p.whatsapp_opt_in_status else 'ready' end as consent_status,
      (v_channel <> 'whatsapp' or p.whatsapp_verified_at is not null or not coalesce(v_config.require_verified_guardian, false)) as group_verified,
      p.pilot_enabled as group_pilot
    from public.staff_attendance_profiles p
    where p.employment_status = 'active'
      and v_recipient_group in ('all', 'staff')
      and (v_audience <> 'pilot' or p.pilot_enabled)
      and public.school_normalize_nigerian_phone(case when v_channel = 'whatsapp' then p.whatsapp_number else p.phone end) is not null
      and (
        v_audience <> 'selected'
        or exists (
          select 1 from jsonb_array_elements(v_selected) z
          where z->>'type' = 'staff' and z->>'id' = p.id::text
        )
      )
      and (v_channel <> 'whatsapp' or p.whatsapp_opt_in_status = 'opted_in')
  ), eligible as (
    select * from eligible_guardians
    union all
    select * from eligible_staff
  ), inserted as (
    insert into public.school_notification_messages(
      source_system, source_event_type, source_event_id, recipient_type, recipient_id, recipient_name,
      channel, destination, template_id, subject, message, payload, status, scheduled_at, next_attempt_at,
      language_code, delivery_mode, consent_snapshot, approved_at, approved_by
    )
    select
      'general',
      v_purpose,
      v_batch_id::text || ':' || e.recipient_type || ':' || md5(e.group_key),
      e.recipient_type,
      e.recipient_id,
      e.recipient_name,
      v_channel,
      e.destination,
      v_template_id,
      null,
      v_message,
      jsonb_strip_nulls(jsonb_build_object(
        'batch_id', v_batch_id,
        'group_key', e.group_key,
        'member_ids', to_jsonb(e.member_ids),
        'student_ids', to_jsonb(e.student_ids),
        'children', e.children,
        'children_summary', e.children_summary,
        'child_count', e.member_count,
        'associated_name', e.associated_name,
        'group_name', e.group_name,
        'reference_number', e.reference_number,
        'audience', v_audience,
        'purpose', v_purpose,
        'class_key', coalesce(v_class_key, 'all'),
        'whatsapp_template_name', case when v_channel = 'whatsapp' then v_template_name end,
        'whatsapp_template_language', case when v_channel = 'whatsapp' then coalesce(v_template_language, v_language) end
      )),
      v_status,
      case when v_status = 'queued' then now() end,
      case when v_status = 'queued' then now() end,
      v_language,
      case when coalesce(v_config.dry_run, true) then 'dry_run' else 'live' end,
      jsonb_build_object(
        'status', e.consent_status,
        'recorded_at', e.consent_at,
        'source', e.consent_source,
        'verified', e.group_verified,
        'channel', v_channel,
        'pilot_enabled', e.group_pilot,
        'member_count', e.member_count,
        'member_ids', to_jsonb(e.member_ids)
      ),
      case when v_status = 'queued' then now() end,
      case when v_status = 'queued' then v_client.client_code end
    from eligible e
    returning status, recipient_type
  )
  select count(*), count(*) filter (where status = 'queued'), count(*) filter (where recipient_type = 'guardian')
  into v_created, v_queued, v_groups
  from inserted;

  insert into public.attendance_admin_audit(admin_client_id, action, entity_type, entity_id, details)
  values(
    v_admin,
    'notification.bulk.create',
    'notification_batch',
    v_batch_id::text,
    jsonb_build_object(
      'audience', v_audience,
      'recipient_group', v_recipient_group,
      'channel', v_channel,
      'language_code', v_language,
      'purpose', v_purpose,
      'class_key', coalesce(v_class_key, 'all'),
      'created', v_created,
      'parent_groups', v_groups,
      'queued', v_queued,
      'queue_requested', v_queue_requested,
      'template_id', v_template_id,
      'whatsapp_template_name', v_template_name,
      'whatsapp_template_language', v_template_language
    )
  );

  return jsonb_build_object(
    'ok', true,
    'code', 'BULK_NOTIFICATION_BATCH_CREATED',
    'batch_id', v_batch_id,
    'created', v_created,
    'parent_groups', v_groups,
    'queued', v_queued,
    'status', v_status,
    'purpose', v_purpose,
    'class_key', coalesce(v_class_key, 'all'),
    'warning', case when v_queue_requested and v_status = 'draft' then 'Messages were created as drafts because live delivery is not enabled for this channel.' end
  );
exception
  when invalid_text_representation then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT_FORMAT');
  when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'DUPLICATE_BULK_BATCH');
end;
$function$;

create or replace function public.school_guardian_import_admin_write_api(
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
  v_batch uuid;
  v_class_key text := nullif(trim(coalesce(p_payload->>'classKey', '')), '');
  v_mismatch integer := 0;
  v_result jsonb;
  v_request uuid := gen_random_uuid();
begin
  v_admin := public.school_registry_verify_admin(p_client_code, p_client_secret, 'notifications.manage');
  if v_admin is null then
    return jsonb_build_object('ok', false, 'code', 'ADMIN_AUTH_OR_PERMISSION_FAILED');
  end if;

  if v_class_key = 'all' then v_class_key := null; end if;
  if v_class_key is not null and not exists (
    select 1 from public.school_classes where class_key = v_class_key and is_active = true
  ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_IMPORT_CLASS');
  end if;

  if p_action = 'validateBatch' then
    v_result := public.create_guardian_import_batch(
      coalesce(nullif(trim(p_payload->>'batchName'), ''), 'Guardian Contact Import ' || to_char(now(), 'YYYY-MM-DD HH24:MI')),
      nullif(trim(p_payload->>'sourceFilename'), ''),
      coalesce(p_payload->'rows', '[]'::jsonb),
      v_admin
    );

    if coalesce((v_result->>'ok')::boolean, false) and v_class_key is not null then
      begin
        v_batch := (v_result->>'batch_id')::uuid;
      exception when invalid_text_representation then
        return v_result || jsonb_build_object('request_id', v_request);
      end;

      update public.attendance_guardian_import_rows r
      set match_status = 'invalid',
          validation_errors = coalesce(r.validation_errors, '[]'::jsonb) || jsonb_build_array('STUDENT_NOT_IN_SELECTED_CLASS'),
          import_notes = concat_ws(' ', r.import_notes, 'The selected class scope does not match this student.')
      where r.batch_id = v_batch
        and r.match_status = 'matched'
        and not exists (
          select 1
          from public.students s
          where s.id = r.matched_student_id
            and s.class_key = v_class_key
            and coalesce(s.archived, false) = false
        );

      get diagnostics v_mismatch = row_count;

      update public.attendance_guardian_import_batches b
      set class_key = v_class_key,
          valid_rows = (select count(*) from public.attendance_guardian_import_rows where batch_id = b.id and match_status = 'matched'),
          invalid_rows = (select count(*) from public.attendance_guardian_import_rows where batch_id = b.id and match_status <> 'matched'),
          status = case
            when not exists (select 1 from public.attendance_guardian_import_rows where batch_id = b.id and match_status = 'matched') then 'invalid'
            when exists (select 1 from public.attendance_guardian_import_rows where batch_id = b.id and match_status <> 'matched') then 'partially_valid'
            else 'validated'
          end,
          notes = concat_ws(' ', notes, 'Class scope:', v_class_key)
      where b.id = v_batch;

      v_result := v_result || jsonb_build_object(
        'class_key', v_class_key,
        'class_mismatch_rows', v_mismatch,
        'status', (select status from public.attendance_guardian_import_batches where id = v_batch),
        'valid_rows', (select valid_rows from public.attendance_guardian_import_batches where id = v_batch),
        'invalid_rows', (select invalid_rows from public.attendance_guardian_import_batches where id = v_batch)
      );
    end if;

    insert into public.attendance_admin_audit(admin_client_id, action, entity_type, entity_id, request_id, details)
    values(v_admin, 'guardian_import.validate', 'attendance_guardian_import_batch', coalesce(v_result->>'batch_id', 'unknown'), v_request, v_result || jsonb_build_object('class_key', v_class_key));
    return v_result || jsonb_build_object('request_id', v_request);
  end if;

  begin
    v_batch := (p_payload->>'batchId')::uuid;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'INVALID_BATCH_ID');
  end;

  if p_action = 'applyBatch' then
    v_result := public.apply_guardian_import_batch(v_batch, v_admin);
    return v_result || jsonb_build_object('request_id', v_request);
  end if;

  if p_action = 'cancelBatch' then
    update public.attendance_guardian_import_batches
    set status = 'cancelled', notes = concat_ws(' ', notes, 'Cancelled by management before application.')
    where id = v_batch and status in ('validated', 'partially_valid', 'invalid');
    if not found then return jsonb_build_object('ok', false, 'code', 'IMPORT_BATCH_NOT_CANCELLABLE'); end if;
    insert into public.attendance_admin_audit(admin_client_id, action, entity_type, entity_id, request_id)
    values(v_admin, 'guardian_import.cancel', 'attendance_guardian_import_batch', v_batch::text, v_request);
    return jsonb_build_object('ok', true, 'code', 'GUARDIAN_IMPORT_CANCELLED', 'batch_id', v_batch, 'request_id', v_request);
  end if;

  return jsonb_build_object('ok', false, 'code', 'UNKNOWN_ACTION');
end;
$function$;
