-- Preserve effective parent-group consent when the directory is filtered.
-- Status filtering is applied after grouping, never to individual child rows.

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

