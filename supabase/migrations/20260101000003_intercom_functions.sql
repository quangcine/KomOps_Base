-- Hàm của mô đun Intercom. Trình duyệt, máy chủ chỉ gọi qua các hàm này. Ba nhóm: `_intercom_*` nội bộ; hàm nhân
-- viên tự kiểm quyền theo `auth.uid()`; hàm `p_gate` chỉ chạy khi máy chủ đưa đúng chuỗi cổng
-- INTERCOM_DRIVE_GATE (bảng `intercom_drive_gate` chỉ giữ băm).

set check_function_bodies = off;

CREATE FUNCTION public._intercom_board_json(p_project uuid, p_with_share boolean) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select jsonb_build_object(
    'project', jsonb_build_object(
      'id', p.id, 'name', p.name, 'start_date', p.start_date, 'end_date', p.end_date,
      'group_count', p.group_count, 'day_count', p.day_count
    ) || case when p_with_share
         then jsonb_build_object('share_token', p.share_token, 'share_revoked_at', p.share_revoked_at)
         else '{}'::jsonb end,
    'today', (now() at time zone 'Asia/Ho_Chi_Minh')::date,
    'units', coalesce((
      select jsonb_agg(jsonb_build_object('id', u.id, 'prefix', u.prefix, 'seq', u.seq, 'code', u.code,
                                          'tag_note', us.tag_note, 'is_master', u.seq = 0)
                       order by u.prefix, u.seq)
        from public.intercom_unit u
        left join public.intercom_unit_set us on us.project_id = u.project_id and us.prefix = u.prefix
       where u.project_id = p.id
    ), '[]'::jsonb),
    'sets', coalesce((
      select jsonb_agg(jsonb_build_object('prefix', s.prefix, 'model_id', s.model_id, 'model_name', m.name,
                                          'is_hub', s.is_hub, 'has_master', s.has_master)
                       || case when p_with_share
                            then jsonb_build_object('unit_hours', s.unit_hours, 'master_hours_min', s.master_hours_min,
                                                    'master_hours_max', s.master_hours_max, 'hub_hours', s.hub_hours)
                            else '{}'::jsonb end
                       order by s.prefix)
        from public.intercom_unit_set s
        left join public.intercom_unit_model m on m.id = s.model_id
       where s.project_id = p.id
    ), '[]'::jsonb),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object('id', pe.id, 'full_name', pe.full_name, 'department', pe.department,
                                          'group_no', pe.group_no)
                       || case when p_with_share then jsonb_build_object('phone', pe.phone) else '{}'::jsonb end
                       order by pe.group_no, pe.department, pe.full_name)
        from public.intercom_person pe where pe.project_id = p.id
    ), '[]'::jsonb),
    'issues', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'unit_id', i.unit_id, 'unit_code', u.code, 'work_date', i.work_date,
               'day_number', i.work_date - p.start_date + 1, 'person_id', i.person_id, 'department', i.department,
               'group_no', i.group_no, 'deliver_handover_id', i.deliver_handover_id,
               'collect_handover_id', i.collect_handover_id, 'collected_at', i.collected_at,
               'fault_reason', i.fault_reason)
             order by i.work_date, u.prefix, u.seq)
        from public.intercom_issue i
        join public.intercom_unit u on u.id = i.unit_id
       where i.project_id = p.id
    ), '[]'::jsonb),
    'handovers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', h.id, 'kind', h.kind, 'work_date', h.work_date, 'person_id', h.person_id,
               'department', h.department, 'group_no', h.group_no, 'taken_at', h.taken_at, 'created_at', h.created_at)
             order by h.created_at)
        from public.intercom_handover h
       where h.project_id = p.id and h.status = 'done'
    ), '[]'::jsonb)
  )
  from public.intercom_project p
  where p.id = p_project
$$;

CREATE FUNCTION public._intercom_drive_gate_ok(p_gate text) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  -- Cổng null, rỗng, ngắn hơn 32 ký tự luôn bị từ chối, kể cả khi băm trong bảng khớp.
  select coalesce(char_length(p_gate) >= 32
    and (select encode(sha256(convert_to(p_gate, 'UTF8')), 'hex') = g.gate_hash from public.intercom_drive_gate g), false);
$$;

CREATE FUNCTION public._intercom_handover_result(p_handover uuid) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select jsonb_build_object(
    'handover_id', h.id,
    'kind', h.kind,
    'codes', coalesce((
      select jsonb_agg(u.code order by u.prefix, u.seq)
        from public.intercom_issue i
        join public.intercom_unit u on u.id = i.unit_id
       where (h.kind = 'deliver' and i.deliver_handover_id = h.id)
          or (h.kind = 'collect' and i.collect_handover_id = h.id)
    ), '[]'::jsonb),
    'already_collected', case when h.kind = 'collect' then coalesce((
      select jsonb_agg(u.code order by u.prefix, u.seq)
        from public.intercom_issue i
        join public.intercom_unit u on u.id = i.unit_id
       where i.id = any (h.issue_ids)
         and i.collect_handover_id is distinct from h.id
    ), '[]'::jsonb) else '[]'::jsonb end
  )
  from public.intercom_handover h
  where h.id = p_handover
$$;

CREATE FUNCTION public._intercom_phone_normalize(p_phone text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $_$
  select case
           when s = '' then null
           when s ~ '^\+?84[0-9]{9}$' then '0' || right(s, 9)
           when s ~ '^[1-9][0-9]{8}$' then '0' || s
           else s
         end
    from (select regexp_replace(coalesce(p_phone, ''), '[[:space:].()-]', '', 'g') as s) t
$_$;

CREATE FUNCTION public._intercom_unit_model_validate(p_name text, p_max_units integer, p_has_master boolean, p_is_hub boolean, p_unit_hours numeric, p_master_min numeric, p_master_max numeric, p_hub_hours numeric) RETURNS void
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if p_name is null or char_length(p_name) < 1 or char_length(p_name) > 60 then
    raise exception 'Tên Model từ 1 tới 60 ký tự' using errcode = '22023';
  end if;
  if p_has_master is null or p_is_hub is null then
    raise exception 'Thiếu cờ tai chủ hoặc cờ Hub' using errcode = '22023';
  end if;
  if p_is_hub and p_has_master then
    raise exception 'Bộ Hub không có tai chủ' using errcode = '22023';
  end if;
  if p_has_master and (p_max_units is null or p_max_units < 2 or p_max_units > 21) then
    raise exception 'Bộ có tai chủ: số tai từ 2 tới 21 (tai chủ cộng tối đa 20 tai thường)' using errcode = '22023';
  end if;
  if not p_has_master and (p_max_units is null or p_max_units < 1 or p_max_units > 20) then
    raise exception 'Số tai từ 1 tới 20' using errcode = '22023';
  end if;
  if p_unit_hours is null or p_unit_hours < 0.5 or p_unit_hours > 48 then
    raise exception 'Giờ pin tai thường từ 0,5 tới 48' using errcode = '22023';
  end if;
  if p_has_master then
    if p_master_min is null or p_master_max is null
       or p_master_min < 0.5 or p_master_min > 48 or p_master_max < 0.5 or p_master_max > 48 then
      raise exception 'Giờ pin tai chủ Từ, Đến từ 0,5 tới 48' using errcode = '22023';
    end if;
    if p_master_min > p_master_max then
      raise exception 'Giờ pin tai chủ: Từ không lớn hơn Đến' using errcode = '22023';
    end if;
  end if;
  if p_hub_hours is not null and (p_hub_hours < 0.5 or p_hub_hours > 48) then
    raise exception 'Giờ pin Hub từ 0,5 tới 48' using errcode = '22023';
  end if;
end
$$;

CREATE FUNCTION public.intercom_board(p_project uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_board jsonb;
begin
  if auth.uid() is null or not public.intercom_can_access(p_project) then
    raise exception 'Không có quyền xem giao nhận intercom' using errcode = '42501';
  end if;
  v_board := public._intercom_board_json(p_project, true);
  if v_board is null then
    raise exception 'Không tìm thấy dự án' using errcode = 'P0002';
  end if;
  return v_board;
end
$$;

CREATE FUNCTION public.intercom_can_access(p_project uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select auth.uid() is not null
     and public.is_active_profile(auth.uid())
     and (public.intercom_is_manager()
          or exists (select 1 from public.intercom_member m
                      where m.project_id = p_project and m.profile_id = auth.uid()));
$$;

CREATE FUNCTION public.intercom_can_delete() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select auth.uid() is not null
     and public.is_active_profile(auth.uid())
     and (public.is_admin() or exists (select 1 from public.intercom_deleter d where d.profile_id = auth.uid()));
$$;

CREATE FUNCTION public.intercom_can_use(p_project uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select auth.uid() is not null
     and case when p_project is null then public.is_staff()
              else public.intercom_can_access(p_project) end;
$$;

CREATE FUNCTION public.intercom_cleanup_originals(p_project uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_rows jsonb;
begin
  if not coalesce(public.intercom_can_delete(), false) or not coalesce(public.intercom_can_use(p_project), false) then
    raise exception 'Bạn không có quyền dọn intercom' using errcode = '42501';
  end if;

  with gone as (
    update public.intercom_handover h
       set photo_purged_at = now()
      from public.intercom_project p
     where p.id = h.project_id
       and p.storage_kind <> 'drive'
       and h.status = 'done'
       and h.photo_purged_at is null
       and p.start_date + p.day_count - 1 + 7 < v_today
       and (p_project is null or h.project_id = p_project)
       and coalesce(public.intercom_can_use(h.project_id), false)
    returning h.id, h.photo_key, h.size_bytes
  )
  select coalesce(jsonb_agg(jsonb_build_object('handover_id', g.id, 'photo_key', g.photo_key, 'size_bytes', g.size_bytes)), '[]'::jsonb)
    into v_rows
    from gone g;
  return v_rows;
end
$$;

CREATE FUNCTION public.intercom_cleanup_pending(p_project uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_rows jsonb;
begin
  if not coalesce(public.intercom_can_delete(), false) or not coalesce(public.intercom_can_use(p_project), false) then
    raise exception 'Bạn không có quyền dọn intercom' using errcode = '42501';
  end if;

  with gone as (
    delete from public.intercom_handover h
     where h.status = 'pending'
       and h.created_at < now() - interval '1 hour'
       and (p_project is null or h.project_id = p_project)
       and coalesce(public.intercom_can_use(h.project_id), false)
    returning h.id, h.photo_key, h.thumb_key
  )
  select coalesce(jsonb_agg(jsonb_build_object('handover_id', g.id, 'photo_key', g.photo_key, 'thumb_key', g.thumb_key)), '[]'::jsonb)
    into v_rows
    from gone g;
  return v_rows;
end
$$;

CREATE FUNCTION public.intercom_drive_account_cipher(p_gate text, p_account uuid) RETURNS TABLE(refresh_token_cipher text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if not public._intercom_drive_gate_ok(p_gate) then
    return;
  end if;
  return query select a.refresh_token_cipher from public.intercom_drive_account a where a.id = p_account;
end
$$;

CREATE FUNCTION public.intercom_drive_account_list() RETURNS TABLE(id uuid, google_email text, status text, project_count bigint)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if not coalesce(public.intercom_is_manager(), false) then
    raise exception 'Không có quyền quản lý Drive' using errcode = '42501';
  end if;
  return query
    select a.id, a.google_email, a.status,
           (select count(*) from public.intercom_project p where p.drive_account_id = a.id)
      from public.intercom_drive_account a
     order by a.created_at;
end
$$;

CREATE FUNCTION public.intercom_drive_account_mark_revoked(p_gate text, p_account uuid) RETURNS TABLE(id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if not public._intercom_drive_gate_ok(p_gate) then
    return;
  end if;
  return query
    update public.intercom_drive_account a
       set status = 'revoked', revoked_at = now()
     where a.id = p_account and a.status <> 'revoked'
    returning a.id;
end
$$;

CREATE FUNCTION public.intercom_drive_account_options() RETURNS TABLE(id uuid, google_email text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if not (
    coalesce(public.intercom_can_use(null), false)
    or coalesce(public.intercom_is_manager(), false)
    or (public.is_active_profile(auth.uid())
        and exists (select 1 from public.intercom_member m where m.profile_id = auth.uid()))
  ) then
    raise exception 'Không có quyền xem tài khoản Drive' using errcode = '42501';
  end if;
  return query
    select a.id, a.google_email
      from public.intercom_drive_account a
     where a.status = 'active'
     order by a.created_at;
end
$$;

CREATE FUNCTION public.intercom_drive_account_save(p_gate text, p_sub text, p_email text, p_cipher text) RETURNS TABLE(id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_id uuid;
begin
  if not public._intercom_drive_gate_ok(p_gate) or not coalesce(public.intercom_is_manager(), false) then
    return;
  end if;
  if coalesce(btrim(p_sub), '') = '' or coalesce(btrim(p_email), '') = '' or coalesce(btrim(p_cipher), '') = '' then
    return;
  end if;
  insert into public.intercom_drive_account as a (google_sub, google_email, refresh_token_cipher, status, connected_by)
  values (p_sub, p_email, p_cipher, 'active', auth.uid())
  on conflict (google_sub) do update
    set google_email = excluded.google_email,
        refresh_token_cipher = excluded.refresh_token_cipher,
        status = 'active',
        connected_by = excluded.connected_by,
        revoked_at = null
  returning a.id into v_id;
  update public.intercom_drive_delete_queue q set attempts = 0 where q.account_id = v_id and q.done_at is null;
  return query select v_id;
end
$$;

CREATE FUNCTION public.intercom_drive_bench_log(p_run uuid, p_project uuid, p_account uuid, p_seq integer, p_bytes integer, p_ms integer, p_attempts integer, p_outcome text, p_error text, p_device text, p_network text, p_upload_mode text, p_file_id text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_id uuid;
begin
  if not coalesce(public.intercom_is_manager(), false) then
    raise exception 'Không có quyền quản lý Drive' using errcode = '42501';
  end if;
  if p_run is null then
    raise exception 'Thiếu mã lượt đo' using errcode = '22023';
  end if;
  if not exists (select 1 from public.intercom_drive_account a where a.id = p_account) then
    raise exception 'Không tìm thấy tài khoản Drive' using errcode = '22023';
  end if;
  insert into public.intercom_drive_bench (run_id, project_id, account_id, seq, bytes, ms, attempts, outcome, error, device, network, upload_mode, file_id)
  values (p_run, p_project, p_account, p_seq, p_bytes, p_ms, p_attempts, left(p_outcome, 40), left(p_error, 500), left(p_device, 120), left(p_network, 40), left(p_upload_mode, 20), left(p_file_id, 200))
  returning id into v_id;
  return v_id;
end
$$;

CREATE FUNCTION public.intercom_drive_bench_trash(p_run uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_count integer;
begin
  if not coalesce(public.intercom_is_manager(), false) then
    raise exception 'Không có quyền quản lý Drive' using errcode = '42501';
  end if;
  insert into public.intercom_drive_delete_queue (account_id, file_id, project_id, was_done)
  select distinct b.account_id, b.file_id, b.project_id, false
    from public.intercom_drive_bench b
   where b.run_id = p_run
     and b.file_id is not null
     and b.account_id is not null
     and not exists (select 1 from public.intercom_drive_delete_queue q where q.account_id = b.account_id and q.file_id = b.file_id);
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

CREATE FUNCTION public.intercom_drive_monitor() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_result jsonb;
begin
  if not coalesce(public.intercom_is_manager(), false) then
    raise exception 'Không có quyền quản lý Drive' using errcode = '42501';
  end if;
  select jsonb_build_object(
           'waiting_count', count(*) filter (where not (q.was_done and q.last_error is not null)),
           'missed_count', count(*) filter (where q.was_done and q.last_error is not null),
           'reasons', coalesce((
             select jsonb_agg(jsonb_build_object('reason', r.last_error, 'count', r.n) order by r.n desc, r.last_error)
               from (select m.last_error, count(*) as n
                       from public.intercom_drive_delete_queue m
                      where m.done_at is null and m.was_done and m.last_error is not null
                      group by m.last_error) r
           ), '[]'::jsonb))
    into v_result
    from public.intercom_drive_delete_queue q
   where q.done_at is null;

  v_result := v_result || jsonb_build_object(
    'fallback_pending', (
      select count(*) from public.intercom_handover h
       where h.status = 'done' and h.storage_fallback_at is not null and h.drive_moved_at is null),
    'place_pending', (
      select count(*) from public.intercom_handover h
       where h.status = 'done' and h.drive_file_id is not null and h.drive_placed_at is null),
    'permission_failed', (
      select count(*) from public.intercom_drive_permission d
       where d.applied_at is null and d.last_error is not null),
    'revoked_projects', (
      select count(*) from (
        select p.id
          from public.intercom_project p
          join public.intercom_drive_account a on a.id = p.drive_account_id and a.status = 'revoked'
         where p.storage_kind = 'drive'
        union
        select d.project_id
          from public.intercom_drive_permission d
          join public.intercom_drive_account a on a.id = d.account_id and a.status = 'revoked'
         where d.applied_at is null
      ) x));
  return v_result;
end
$$;

CREATE FUNCTION public.intercom_drive_move_done(p_gate text, p_handover uuid, p_file_id text, p_thumb_id text) RETURNS TABLE(id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
begin
  if not public._intercom_drive_gate_ok(p_gate) then
    return;
  end if;
  if p_file_id is null or p_thumb_id is null or p_file_id = p_thumb_id
     or p_file_id !~ '^[A-Za-z0-9_-]{1,200}$' or p_thumb_id !~ '^[A-Za-z0-9_-]{1,200}$' then
    return;
  end if;
  return query
    update public.intercom_handover h
       set drive_file_id = p_file_id,
           drive_thumb_file_id = p_thumb_id,
           drive_account_id = p.drive_account_id,
           drive_moved_at = now(),
           drive_placed_at = now(),
           move_last_error = null
      from public.intercom_project p
     where h.id = p_handover
       and p.id = h.project_id
       and p.drive_account_id is not null
       and h.status = 'done'
       and h.storage_fallback_at is not null
       and h.drive_moved_at is null
    returning h.id;
end
$_$;

CREATE FUNCTION public.intercom_drive_move_fail(p_gate text, p_handover uuid, p_error text) RETURNS TABLE(id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if not public._intercom_drive_gate_ok(p_gate) then
    return;
  end if;
  return query
    update public.intercom_handover h
       set move_attempts = least(h.move_attempts + 1, 32767),
           move_last_error = left(coalesce(p_error, 'unexpected'), 500)
     where h.id = p_handover
       and h.storage_fallback_at is not null
       and h.drive_moved_at is null
    returning h.id;
end
$$;

CREATE FUNCTION public.intercom_drive_move_take(p_gate text, p_limit integer DEFAULT 10) RETURNS TABLE(handover_id uuid, project_id uuid, photo_key text, thumb_key text, account_id uuid, folder_id text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if not public._intercom_drive_gate_ok(p_gate) then
    return;
  end if;
  return query
    select h.id, h.project_id, h.photo_key, h.thumb_key, p.drive_account_id, p.drive_folder_id
      from public.intercom_handover h
      join public.intercom_project p on p.id = h.project_id
      join public.intercom_drive_account a on a.id = p.drive_account_id and a.status = 'active'
     where h.status = 'done'
       and h.storage_fallback_at is not null
       and h.drive_moved_at is null
       and h.move_attempts < 8
       and p.storage_kind = 'drive'
       and p.drive_folder_id is not null
     order by h.storage_fallback_at
     limit greatest(1, least(coalesce(p_limit, 10), 100))
     for update of h skip locked;
end
$$;

CREATE FUNCTION public.intercom_drive_permission_done(p_gate text, p_id uuid, p_permission_id text) RETURNS TABLE(id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if not public._intercom_drive_gate_ok(p_gate) then
    return;
  end if;
  return query
    update public.intercom_drive_permission d
       set applied_at = now(),
           permission_id = case when d.want = 'on' then left(p_permission_id, 200) end,
           last_error = null,
           updated_at = now()
     where d.id = p_id and d.applied_at is null
    returning d.id;
end
$$;

CREATE FUNCTION public.intercom_drive_permission_fail(p_gate text, p_id uuid, p_error text) RETURNS TABLE(id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if not public._intercom_drive_gate_ok(p_gate) then
    return;
  end if;
  return query
    update public.intercom_drive_permission d
       set attempts = least(d.attempts + 1, 32767),
           last_error = left(coalesce(p_error, 'unexpected'), 500),
           updated_at = now()
     where d.id = p_id and d.applied_at is null
    returning d.id;
end
$$;

CREATE FUNCTION public.intercom_drive_permission_take(p_gate text, p_project uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 10) RETURNS TABLE(id uuid, account_id uuid, file_id text, purpose text, role text, want text, permission_id text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if not public._intercom_drive_gate_ok(p_gate) then
    return;
  end if;
  return query
    select d.id, d.account_id, d.file_id, d.purpose, d.role, d.want, d.permission_id
      from public.intercom_drive_permission d
      join public.intercom_drive_account a on a.id = d.account_id and a.status = 'active'
     where d.applied_at is null
       and d.attempts < 8
       and d.last_error is distinct from 'cannot_share'
       and (p_project is null or d.project_id = p_project)
     order by d.updated_at
     limit greatest(1, least(coalesce(p_limit, 10), 100))
     for update of d skip locked;
end
$$;

CREATE FUNCTION public.intercom_drive_permission_upsert(p_gate text, p_project uuid, p_account uuid, p_file_id text, p_purpose text, p_role text, p_want text) RETURNS TABLE(id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if not public._intercom_drive_gate_ok(p_gate) then
    return;
  end if;
  return query
    insert into public.intercom_drive_permission as d (project_id, account_id, file_id, purpose, role, want)
    values (p_project, p_account, p_file_id, p_purpose, p_role, p_want)
    on conflict (project_id, purpose, file_id) do update
       set account_id = excluded.account_id,
           role = excluded.role,
           want = excluded.want,
           applied_at = case when (d.want, d.role, d.account_id) is distinct from (excluded.want, excluded.role, excluded.account_id)
                             then null else d.applied_at end,
           attempts = case when (d.want, d.role, d.account_id) is distinct from (excluded.want, excluded.role, excluded.account_id)
                           then 0 else d.attempts end,
           last_error = case when (d.want, d.role, d.account_id) is distinct from (excluded.want, excluded.role, excluded.account_id)
                             then null else d.last_error end,
           updated_at = now()
    returning d.id;
end
$$;

CREATE FUNCTION public.intercom_drive_place_done(p_gate text, p_handover uuid) RETURNS TABLE(id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if not public._intercom_drive_gate_ok(p_gate) then
    return;
  end if;
  return query
    update public.intercom_handover h
       set drive_placed_at = now(),
           move_last_error = null
     where h.id = p_handover
       and h.status = 'done'
       and h.drive_file_id is not null
       and h.drive_placed_at is null
    returning h.id;
end
$$;

CREATE FUNCTION public.intercom_drive_place_fail(p_gate text, p_handover uuid, p_error text) RETURNS TABLE(id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if not public._intercom_drive_gate_ok(p_gate) then
    return;
  end if;
  return query
    update public.intercom_handover h
       set move_attempts = least(h.move_attempts + 1, 32767),
           move_last_error = left(coalesce(p_error, 'unexpected'), 500)
     where h.id = p_handover
       and h.drive_file_id is not null
       and h.drive_placed_at is null
    returning h.id;
end
$$;

CREATE FUNCTION public.intercom_drive_place_take(p_gate text, p_limit integer DEFAULT 10) RETURNS TABLE(handover_id uuid, project_id uuid, account_id uuid, file_id text, thumb_file_id text, folder_id text, staging_folder_id text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if not public._intercom_drive_gate_ok(p_gate) then
    return;
  end if;
  return query
    select h.id, h.project_id, h.drive_account_id, h.drive_file_id, h.drive_thumb_file_id, p.drive_folder_id, p.drive_staging_folder_id
      from public.intercom_handover h
      join public.intercom_project p on p.id = h.project_id
      join public.intercom_drive_account a on a.id = h.drive_account_id and a.status = 'active'
     where h.status = 'done'
       and h.drive_file_id is not null
       and h.drive_placed_at is null
       and h.move_attempts < 8
       and p.drive_folder_id is not null
     order by h.created_at
     limit greatest(1, least(coalesce(p_limit, 10), 100))
     for update of h skip locked;
end
$$;

CREATE FUNCTION public.intercom_drive_queue_done(p_gate text, p_id uuid, p_error text DEFAULT NULL::text) RETURNS TABLE(id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if not public._intercom_drive_gate_ok(p_gate) then
    return;
  end if;
  if p_error is null then
    return query
      update public.intercom_drive_delete_queue q
         set done_at = now(), last_error = null
       where q.id = p_id and q.done_at is null
      returning q.id;
  else
    return query
      update public.intercom_drive_delete_queue q
         set attempts = q.attempts + 1, last_error = left(p_error, 500)
       where q.id = p_id and q.done_at is null
      returning q.id;
  end if;
end
$$;

CREATE FUNCTION public.intercom_drive_queue_reset(p_account uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_count integer;
begin
  if not coalesce(public.intercom_is_manager(), false) then
    raise exception 'Không có quyền quản lý Drive' using errcode = '42501';
  end if;
  update public.intercom_drive_delete_queue q set attempts = 0 where q.account_id = p_account and q.done_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

CREATE FUNCTION public.intercom_drive_queue_take(p_gate text, p_limit integer DEFAULT 20) RETURNS TABLE(id uuid, account_id uuid, file_id text, was_done boolean, attempts integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if not public._intercom_drive_gate_ok(p_gate) then
    return;
  end if;
  return query
    select q.id, q.account_id, q.file_id, q.was_done, q.attempts
      from public.intercom_drive_delete_queue q
     where q.done_at is null and q.attempts < 5
     order by q.created_at
     limit greatest(1, least(coalesce(p_limit, 20), 100))
     for update of q skip locked;
end
$$;

CREATE FUNCTION public.intercom_drive_sheet_schedule(p_gate text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_closed integer := 0;
  v_reopened integer := 0;
begin
  if not public._intercom_drive_gate_ok(p_gate) then
    return null;
  end if;

  with due as (
    select s.project_id, s.template_file_id
      from public.intercom_people_sheet s
      join public.intercom_project p on p.id = s.project_id
     where s.kind = 'template'
       and s.template_file_id is not null
       and p.end_date < v_today
       and exists (select 1 from public.intercom_drive_permission d
                    where d.project_id = s.project_id and d.purpose = 'sheet_edit'
                      and d.file_id = s.template_file_id and d.want = 'on')
     for update of s skip locked
  ), perm as (
    update public.intercom_drive_permission d
       set want = 'off', applied_at = null, attempts = 0, last_error = null, updated_at = now()
      from due
     where d.project_id = due.project_id and d.purpose = 'sheet_edit' and d.file_id = due.template_file_id and d.want = 'on'
    returning d.id
  )
  update public.intercom_people_sheet s
     set edit_closed_reason = 'ended', updated_at = now()
    from due
   where s.project_id = due.project_id;
  get diagnostics v_closed = row_count;

  with due as (
    select s.project_id, s.template_file_id
      from public.intercom_people_sheet s
      join public.intercom_project p on p.id = s.project_id
     where s.kind = 'template'
       and s.template_file_id is not null
       and s.edit_closed_reason = 'ended'
       and p.end_date >= v_today
     for update of s skip locked
  ), perm as (
    update public.intercom_drive_permission d
       set want = 'on', applied_at = null, attempts = 0, last_error = null, updated_at = now()
      from due
     where d.project_id = due.project_id and d.purpose = 'sheet_edit' and d.file_id = due.template_file_id and d.want <> 'on'
    returning d.id
  )
  update public.intercom_people_sheet s
     set edit_closed_reason = null, updated_at = now()
    from due
   where s.project_id = due.project_id;
  get diagnostics v_reopened = row_count;

  return jsonb_build_object('closed', v_closed, 'reopened', v_reopened);
end
$$;

CREATE FUNCTION public.intercom_drive_staging_set(p_gate text, p_project uuid, p_folder text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  v_current text;
begin
  if not public._intercom_drive_gate_ok(p_gate) or p_project is null then
    return null;
  end if;
  if p_folder is null or p_folder !~ '^[A-Za-z0-9_-]{1,200}$' then
    return null;
  end if;
  select p.drive_staging_folder_id into v_current
    from public.intercom_project p
   where p.id = p_project and p.storage_kind = 'drive'
   for update;
  if not found then
    return null;
  end if;
  if v_current is null then
    update public.intercom_project p set drive_staging_folder_id = p_folder where p.id = p_project;
    v_current := p_folder;
  end if;
  return v_current;
end
$_$;

CREATE FUNCTION public.intercom_handover_abort(p_handover uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_uid uuid := auth.uid();
  v_deleted integer;
begin
  if v_uid is null then
    raise exception 'Không có quyền ghi giao nhận intercom' using errcode = '42501';
  end if;
  delete from public.intercom_handover
   where id = p_handover and status = 'pending' and created_by = v_uid
     and public.intercom_can_access(project_id);
  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end
$$;

CREATE FUNCTION public.intercom_handover_add_units(p_handover uuid, p_unit_ids uuid[]) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_handover public.intercom_handover%rowtype;
  v_units uuid[];
  v_new uuid[];
  v_count integer;
  v_bad text;
  v_codes jsonb;
begin
  if auth.uid() is null then
    raise exception 'Không có quyền ghi giao nhận intercom' using errcode = '42501';
  end if;
  select * into v_handover from public.intercom_handover where id = p_handover for update;
  if not found or not public.intercom_can_access(v_handover.project_id) then
    raise exception 'Không tìm thấy lượt giao' using errcode = 'P0002';
  end if;
  if v_handover.kind <> 'deliver' or v_handover.status <> 'done' then
    raise exception 'Chỉ sửa được lượt giao đã lưu' using errcode = '22023';
  end if;

  select array_agg(distinct x) into v_units from unnest(p_unit_ids) as x where x is not null;
  if v_units is null then
    raise exception 'Chưa chọn mã tai mới' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(v_units) as x
     where not exists (select 1 from public.intercom_unit u where u.id = x and u.project_id = v_handover.project_id)
  ) then
    raise exception 'Có mã tai không thuộc dự án' using errcode = '22023';
  end if;

  -- Mã đã nằm trong lượt thì bỏ qua.
  v_new := array(
    select x from unnest(v_units) as x
     where not (x = any (coalesce(v_handover.unit_ids, '{}'::uuid[])))
  );
  if cardinality(v_new) = 0 then
    raise exception 'Chưa chọn mã tai mới' using errcode = '22023';
  end if;

  select string_agg(u.code, ', ' order by u.prefix, u.seq) into v_bad
    from public.intercom_issue i
    join public.intercom_unit u on u.id = i.unit_id
   where i.unit_id = any (v_new) and i.collect_handover_id is null;
  if v_bad is not null then
    raise exception 'Mã đang ở ngoài, chưa thu: %', v_bad using errcode = 'P0001';
  end if;

  begin
    insert into public.intercom_issue (
      project_id, unit_id, work_date, person_id, department, group_no, deliver_handover_id
    )
    select v_handover.project_id, u.id, v_handover.work_date, v_handover.person_id, v_handover.department,
           v_handover.group_no, v_handover.id
      from public.intercom_unit u
     where u.id = any (v_new) and u.project_id = v_handover.project_id;
    get diagnostics v_count = row_count;
  exception when unique_violation then
    select string_agg(u.code, ', ' order by u.prefix, u.seq) into v_bad
      from public.intercom_issue i
      join public.intercom_unit u on u.id = i.unit_id
     where i.unit_id = any (v_new) and i.collect_handover_id is null;
    raise exception 'Mã đang ở ngoài, chưa thu: %', coalesce(v_bad, '(máy khác vừa giao)') using errcode = 'P0001';
  end;
  if v_count <> cardinality(v_new) then
    raise exception 'Có mã tai không còn trong dự án' using errcode = '22023';
  end if;

  update public.intercom_handover
     set unit_ids = coalesce(unit_ids, '{}'::uuid[]) || v_new
   where id = v_handover.id;

  select coalesce(jsonb_agg(u.code order by u.prefix, u.seq), '[]'::jsonb) into v_codes
    from public.intercom_unit u
   where u.id = any (v_new);
  return jsonb_build_object('handover_id', v_handover.id, 'codes', v_codes);
end
$$;

CREATE FUNCTION public.intercom_handover_begin(p_handover uuid, p_project uuid, p_kind text, p_unit_ids uuid[], p_issue_ids uuid[], p_person uuid, p_department text, p_group integer, p_source text, p_taken_at timestamp with time zone, p_work_date date DEFAULT NULL::date) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_uid uuid := auth.uid();
  v_old public.intercom_handover%rowtype;
  v_has_old boolean := false;
  v_proj public.intercom_project%rowtype;
  v_date date;
  v_units uuid[];
  v_issues uuid[];
  v_person uuid;
  v_dept text;
  v_group smallint;
  v_bad text;
  v_key text;
  v_thumb text;
begin
  if v_uid is null or not public.intercom_can_access(p_project) then
    raise exception 'Không có quyền ghi giao nhận intercom' using errcode = '42501';
  end if;
  if p_handover is null then
    raise exception 'Thiếu mã lượt chụp' using errcode = '22023';
  end if;

  select * into v_old from public.intercom_handover where id = p_handover for update;
  v_has_old := found;
  if v_has_old then
    if v_old.status = 'done' then
      if v_old.project_id is distinct from p_project or v_old.kind is distinct from p_kind then
        raise exception 'Mã lượt chụp đã dùng cho lượt khác, chụp lại giúp tôi' using errcode = '22023';
      end if;
      return jsonb_build_object(
        'handover_id', v_old.id, 'photo_key', v_old.photo_key, 'thumb_key', v_old.thumb_key,
        'already_done', true, 'result', public._intercom_handover_result(v_old.id));
    end if;
    if v_old.created_by is distinct from v_uid or v_old.project_id is distinct from p_project then
      raise exception 'Mã lượt chụp đã có người khác dùng, chụp lại giúp tôi' using errcode = '22023';
    end if;
  end if;

  select * into v_proj from public.intercom_project where id = p_project;
  if not found then
    raise exception 'Không tìm thấy dự án' using errcode = 'P0002';
  end if;
  if p_kind is null or p_kind not in ('deliver', 'collect') then
    raise exception 'Loại lượt không hợp lệ: %', p_kind using errcode = '22023';
  end if;
  if p_source is null or p_source not in ('camera', 'library') then
    raise exception 'Nguồn ảnh không hợp lệ: %', p_source using errcode = '22023';
  end if;

  -- Ngày VN lúc chụp; ảnh thư viện có giờ chụp thì lấy ngày của ảnh (nhập ngược ảnh ngày trước).
  if p_source = 'library' and p_work_date is not null then
    v_date := p_work_date;
  else
    v_date := ((case when p_source = 'library' and p_taken_at is not null then p_taken_at else now() end)
               at time zone 'Asia/Ho_Chi_Minh')::date;
  end if;

  if p_kind = 'deliver' then
    select array_agg(distinct x) into v_units from unnest(p_unit_ids) as x where x is not null;
    if v_units is null then
      raise exception 'Chưa chọn mã tai' using errcode = '22023';
    end if;
    if v_date < v_proj.start_date or v_date > v_proj.start_date + v_proj.day_count - 1 then
      raise exception 'Ngày % nằm ngoài các ngày của dự án (% tới %)',
        to_char(v_date, 'DD/MM/YYYY'), to_char(v_proj.start_date, 'DD/MM/YYYY'),
        to_char(v_proj.start_date + v_proj.day_count - 1, 'DD/MM/YYYY')
        using errcode = '22023';
    end if;
    if exists (
      select 1 from unnest(v_units) as x
       where not exists (select 1 from public.intercom_unit u where u.id = x and u.project_id = p_project)
    ) then
      raise exception 'Có mã tai không thuộc dự án' using errcode = '22023';
    end if;
    select string_agg(u.code, ', ' order by u.prefix, u.seq) into v_bad
      from public.intercom_issue i
      join public.intercom_unit u on u.id = i.unit_id
     where i.unit_id = any (v_units) and i.collect_handover_id is null;
    if v_bad is not null then
      raise exception 'Mã đang ở ngoài, chưa thu: %', v_bad using errcode = 'P0001';
    end if;
    if p_person is not null then
      select pe.department, pe.group_no into v_dept, v_group
        from public.intercom_person pe where pe.id = p_person and pe.project_id = p_project;
      if not found then
        raise exception 'Không tìm thấy người nhận trong dự án' using errcode = 'P0002';
      end if;
      v_person := p_person;
    else
      v_dept := nullif(btrim(p_department), '');
      if v_dept is null then
        raise exception 'Chưa chọn người nhận hoặc bộ phận' using errcode = '22023';
      end if;
      if p_group is null or p_group < 1 or p_group > v_proj.group_count then
        raise exception 'Nhóm không hợp lệ: %', p_group using errcode = '22023';
      end if;
      v_group := p_group;
    end if;
  else
    select array_agg(distinct x) into v_issues from unnest(p_issue_ids) as x where x is not null;
    if v_issues is null then
      raise exception 'Chưa chọn tai cần thu' using errcode = '22023';
    end if;
    if exists (
      select 1 from unnest(v_issues) as x
       where not exists (select 1 from public.intercom_issue i where i.id = x and i.project_id = p_project)
    ) then
      raise exception 'Có tai không thuộc dự án' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.intercom_issue i where i.id = any (v_issues) and i.collect_handover_id is null
    ) then
      select string_agg(u.code, ', ' order by u.prefix, u.seq) into v_bad
        from public.intercom_issue i
        join public.intercom_unit u on u.id = i.unit_id
       where i.id = any (v_issues);
      raise exception 'Các tai này đã có người thu trước: %', v_bad using errcode = 'P0001';
    end if;
  end if;

  v_key := 'intercom/' || p_project::text || '/' || p_handover::text || '.jpg';
  v_thumb := 'intercom/' || p_project::text || '/' || p_handover::text || '_t.jpg';

  if v_has_old then
    update public.intercom_handover
       set project_id = p_project, kind = p_kind, work_date = v_date, person_id = v_person,
           department = v_dept, group_no = v_group, unit_ids = v_units, issue_ids = v_issues,
           photo_key = v_key, thumb_key = v_thumb, source = p_source,
           taken_at = coalesce(p_taken_at, now())
     where id = p_handover;
  else
    insert into public.intercom_handover (
      id, project_id, kind, work_date, person_id, department, group_no, unit_ids, issue_ids,
      photo_key, thumb_key, status, source, taken_at, created_by
    ) values (
      p_handover, p_project, p_kind, v_date, v_person, v_dept, v_group, v_units, v_issues,
      v_key, v_thumb, 'pending', p_source, coalesce(p_taken_at, now()), v_uid
    );
  end if;

  return jsonb_build_object(
    'handover_id', p_handover, 'photo_key', v_key, 'thumb_key', v_thumb, 'already_done', false, 'result', null);
end
$$;

CREATE FUNCTION public.intercom_handover_delete(p_handover uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_handover public.intercom_handover%rowtype;
  v_codes text;
begin
  if not public.intercom_can_delete() then
    raise exception 'Bạn không có quyền xoá lượt giao nhận intercom' using errcode = '42501';
  end if;
  select * into v_handover from public.intercom_handover where id = p_handover for update;
  if not found or not public.intercom_can_access(v_handover.project_id) then
    raise exception 'Không tìm thấy lượt' using errcode = 'P0002';
  end if;

  if v_handover.kind = 'collect' then
    -- Khoá các tai của lượt thu trước khi trả về ngoài.
    perform 1 from public.intercom_issue where collect_handover_id = p_handover for update;
    select string_agg(u.code, ', ' order by u.prefix, u.seq) into v_codes
      from public.intercom_issue i
      join public.intercom_unit u on u.id = i.unit_id
     where i.collect_handover_id = p_handover
       and exists (
         select 1 from public.intercom_issue o
          where o.unit_id = i.unit_id and o.id <> i.id
            and (o.collect_handover_id is null or o.created_at > i.created_at)
       );
    if v_codes is not null then
      raise exception 'Tai % đã được giao lại sau lượt thu này. Xoá lượt giao sau trước', v_codes using errcode = '22023';
    end if;
    begin
      update public.intercom_issue
         set collect_handover_id = null, collected_at = null, fault_reason = null
       where collect_handover_id = p_handover;
    exception when unique_violation then
      raise exception 'Tai đã được giao lại, không xoá được lượt thu này' using errcode = '22023';
    end;
  else
    perform 1 from public.intercom_issue where deliver_handover_id = p_handover for update;
    select string_agg(u.code, ', ' order by u.prefix, u.seq) into v_codes
      from public.intercom_issue i
      join public.intercom_unit u on u.id = i.unit_id
     where i.deliver_handover_id = p_handover
       and i.collect_handover_id is not null;
    if v_codes is not null then
      raise exception 'Tai % đã thu. Xoá lượt thu của các tai này trước', v_codes using errcode = '22023';
    end if;
    delete from public.intercom_issue where deliver_handover_id = p_handover;
  end if;

  delete from public.intercom_handover where id = p_handover;
  return jsonb_build_object('photo_key', v_handover.photo_key, 'thumb_key', v_handover.thumb_key);
end
$$;

CREATE FUNCTION public.intercom_handover_drive_enqueue() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  insert into public.intercom_drive_delete_queue (account_id, file_id, project_id, was_done)
  select old.drive_account_id, f.file_id, old.project_id, old.status = 'done'
    from (values (old.drive_file_id), (old.drive_thumb_file_id)) as f (file_id)
   where f.file_id is not null;
  return old;
end
$$;

CREATE FUNCTION public.intercom_handover_drive_file(p_handover uuid, p_thumb boolean) RETURNS TABLE(account_id uuid, file_id text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select h.drive_account_id,
         case when coalesce(p_thumb, false) or h.photo_purged_at is not null then h.drive_thumb_file_id else h.drive_file_id end
    from public.intercom_handover h
   where h.id = p_handover
     and h.status = 'done'
     and h.drive_file_id is not null
     and coalesce(public.intercom_can_access(h.project_id), false);
$$;

CREATE FUNCTION public.intercom_handover_drive_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if new.storage_fallback_at is not null then
    return new;
  end if;
  if (select p.storage_kind from public.intercom_project p where p.id = new.project_id) = 'drive' then
    raise exception 'Dự án này lưu Google Drive, tải lại trang rồi gửi lại.' using errcode = 'P0001';
  end if;
  return new;
end
$$;

CREATE FUNCTION public.intercom_handover_fallback_r2(p_handover uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_handover public.intercom_handover%rowtype;
  v_project public.intercom_project%rowtype;
begin
  if auth.uid() is null or p_handover is null then
    raise exception 'Không có quyền với lượt này' using errcode = '42501';
  end if;
  select h.* into v_handover from public.intercom_handover h where h.id = p_handover for update;
  if not found then
    raise exception 'Không tìm thấy lượt' using errcode = 'P0002';
  end if;
  if v_handover.created_by is distinct from auth.uid()
     or not coalesce(public.intercom_can_access(v_handover.project_id), false) then
    raise exception 'Không có quyền với lượt này' using errcode = '42501';
  end if;
  if v_handover.status <> 'pending' then
    raise exception 'Lượt không còn chờ tải' using errcode = 'P0001';
  end if;
  if v_handover.storage_fallback_at is not null then
    return;
  end if;
  select p.* into v_project from public.intercom_project p where p.id = v_handover.project_id;
  -- Dự án chưa nối không rơi về.
  if not found or v_project.storage_kind <> 'drive' or v_project.drive_account_id is null or v_project.drive_folder_id is null then
    raise exception 'Dự án chưa nối xong Google Drive' using errcode = 'P0001';
  end if;

  if v_handover.drive_account_id is not null then
    insert into public.intercom_drive_delete_queue (account_id, file_id, project_id, was_done)
    select v_handover.drive_account_id, f.file_id, v_handover.project_id, false
      from (values (v_handover.drive_file_id), (v_handover.drive_thumb_file_id)) as f (file_id)
     where f.file_id is not null;
  end if;

  update public.intercom_handover h
     set drive_file_id = null,
         drive_thumb_file_id = null,
         storage_fallback_at = now()
   where h.id = p_handover;
end
$$;

CREATE FUNCTION public.intercom_handover_finish(p_handover uuid, p_size_bytes integer, p_width integer, p_height integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_uid uuid := auth.uid();
  v_h public.intercom_handover%rowtype;
  v_count integer;
  v_bad text;
begin
  if v_uid is null then
    raise exception 'Không có quyền ghi giao nhận intercom' using errcode = '42501';
  end if;
  select * into v_h from public.intercom_handover where id = p_handover for update;
  if not found or not public.intercom_can_access(v_h.project_id) then
    raise exception 'Không tìm thấy lượt chụp' using errcode = 'P0002';
  end if;
  if v_h.status = 'done' then
    return public._intercom_handover_result(v_h.id);
  end if;
  if v_h.created_by is distinct from v_uid then
    raise exception 'Lượt chụp này của người khác' using errcode = '42501';
  end if;
  if p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 2097152 then
    raise exception 'Cỡ ảnh không hợp lệ: %', p_size_bytes using errcode = '22023';
  end if;

  if v_h.kind = 'deliver' then
    begin
      insert into public.intercom_issue (
        project_id, unit_id, work_date, person_id, department, group_no, deliver_handover_id
      )
      select v_h.project_id, u.id, v_h.work_date, v_h.person_id, v_h.department, v_h.group_no, v_h.id
        from public.intercom_unit u
       where u.id = any (v_h.unit_ids) and u.project_id = v_h.project_id;
      get diagnostics v_count = row_count;
    exception when unique_violation then
      select string_agg(u.code, ', ' order by u.prefix, u.seq) into v_bad
        from public.intercom_issue i
        join public.intercom_unit u on u.id = i.unit_id
       where i.unit_id = any (v_h.unit_ids) and i.collect_handover_id is null;
      raise exception 'Mã đang ở ngoài, chưa thu: %', coalesce(v_bad, '(máy khác vừa giao)') using errcode = 'P0001';
    end;
    if v_count <> cardinality(v_h.unit_ids) then
      raise exception 'Có mã tai không còn trong dự án' using errcode = '22023';
    end if;
  else
    update public.intercom_issue
       set collect_handover_id = v_h.id, collected_at = now()
     where id = any (v_h.issue_ids) and project_id = v_h.project_id and collect_handover_id is null;
    get diagnostics v_count = row_count;
    if v_count = 0 then
      select string_agg(u.code, ', ' order by u.prefix, u.seq) into v_bad
        from public.intercom_issue i
        join public.intercom_unit u on u.id = i.unit_id
       where i.id = any (v_h.issue_ids);
      raise exception 'Các tai này đã có người thu trước: %', v_bad using errcode = 'P0001';
    end if;
  end if;

  update public.intercom_handover
     set status = 'done', size_bytes = p_size_bytes, width = p_width, height = p_height
   where id = v_h.id;
  return public._intercom_handover_result(v_h.id);
end
$$;

CREATE FUNCTION public.intercom_handover_set_drive_files(p_gate text, p_handover uuid, p_file text, p_thumb text) RETURNS TABLE(file_id text, thumb_file_id text, account_id uuid, folder_id text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  v_handover public.intercom_handover%rowtype;
  v_project public.intercom_project%rowtype;
begin
  if not public._intercom_drive_gate_ok(p_gate) or auth.uid() is null or p_handover is null then
    return;
  end if;
  select h.* into v_handover from public.intercom_handover h where h.id = p_handover for update;
  if not found or v_handover.created_by is distinct from auth.uid() or v_handover.status <> 'pending'
     or not coalesce(public.intercom_can_access(v_handover.project_id), false) then
    return;
  end if;
  select p.* into v_project from public.intercom_project p where p.id = v_handover.project_id;
  if not found or v_project.storage_kind <> 'drive' or v_project.drive_account_id is null then
    return;
  end if;
  if v_handover.drive_file_id is null then
    if p_file is null or p_thumb is null or p_file = p_thumb
       or p_file !~ '^[A-Za-z0-9_-]{1,200}$' or p_thumb !~ '^[A-Za-z0-9_-]{1,200}$' then
      return;
    end if;
    update public.intercom_handover h
       set drive_file_id = p_file, drive_thumb_file_id = p_thumb, drive_account_id = v_project.drive_account_id
     where h.id = p_handover
    returning h.* into v_handover;
  end if;
  return query select v_handover.drive_file_id, v_handover.drive_thumb_file_id, v_handover.drive_account_id, v_project.drive_folder_id;
end
$_$;

CREATE FUNCTION public.intercom_handover_set_person(p_handover uuid, p_person uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_handover public.intercom_handover%rowtype;
  v_person public.intercom_person%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Không có quyền ghi giao nhận intercom' using errcode = '42501';
  end if;
  select * into v_handover from public.intercom_handover where id = p_handover for update;
  if not found or not public.intercom_can_access(v_handover.project_id) then
    raise exception 'Không tìm thấy lượt giao' using errcode = 'P0002';
  end if;
  if v_handover.kind <> 'deliver' or v_handover.status <> 'done' then
    raise exception 'Chỉ điền tên cho lượt giao đã lưu' using errcode = '22023';
  end if;
  select * into v_person from public.intercom_person where id = p_person;
  if not found or v_person.project_id <> v_handover.project_id then
    raise exception 'Người nhận không thuộc dự án của lượt giao' using errcode = '22023';
  end if;
  update public.intercom_handover
     set person_id = v_person.id, department = v_person.department, group_no = v_person.group_no
   where id = p_handover;
  update public.intercom_issue
     set person_id = v_person.id, department = v_person.department, group_no = v_person.group_no
   where deliver_handover_id = p_handover;
end
$$;

CREATE FUNCTION public.intercom_is_manager() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select auth.uid() is not null
     and public.is_active_profile(auth.uid())
     and (public.is_admin()
          or exists (select 1 from public.intercom_manager m where m.profile_id = auth.uid()));
$$;

CREATE FUNCTION public.intercom_issue_mark_fault(p_issue uuid, p_reason text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_collect uuid;
  v_project uuid;
begin
  if auth.uid() is null then
    raise exception 'Không có quyền ghi giao nhận intercom' using errcode = '42501';
  end if;
  if v_reason = '' then
    raise exception 'Chưa nhập lý do Lỗi' using errcode = '22023';
  end if;
  if char_length(v_reason) > 200 then
    raise exception 'Lý do Lỗi dài quá 200 ký tự' using errcode = '22023';
  end if;
  select i.collect_handover_id, i.project_id into v_collect, v_project
    from public.intercom_issue i where i.id = p_issue for update;
  if not found or not public.intercom_can_access(v_project) then
    raise exception 'Không tìm thấy tai' using errcode = 'P0002';
  end if;
  if v_collect is null then
    raise exception 'Tai chưa thu, chưa ghi được tình trạng' using errcode = '22023';
  end if;
  update public.intercom_issue set fault_reason = v_reason where id = p_issue;
end
$$;

CREATE FUNCTION public.intercom_member_add(p_project uuid, p_profile_ids uuid[], p_source text DEFAULT 'manual'::text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_uid uuid := auth.uid();
  v_is_manager boolean;
  v_n integer;
begin
  if v_uid is null then
    raise exception 'Không có quyền thêm thành viên intercom' using errcode = '42501';
  end if;
  v_is_manager := public.intercom_is_manager();
  if not v_is_manager and not public.is_staff() then
    raise exception 'Không có quyền thêm thành viên intercom' using errcode = '42501';
  end if;
  if not exists (select 1 from public.intercom_project pr where pr.id = p_project)
     or (not v_is_manager and not public.intercom_can_access(p_project)) then
    raise exception 'Không tìm thấy dự án' using errcode = 'P0002';
  end if;
  if p_source is distinct from 'manual' then
    raise exception 'Nguồn thành viên không hợp lệ: %', p_source using errcode = '22023';
  end if;
  if p_profile_ids is null or cardinality(p_profile_ids) = 0 then
    raise exception 'Chưa chọn người' using errcode = '22023';
  end if;

  insert into public.intercom_member (project_id, profile_id, source, added_by)
  select p_project, p.id, 'manual', v_uid
    from (select distinct x.id from unnest(p_profile_ids) as x(id) where x.id is not null) ids
    join public.profiles p on p.id = ids.id
   where public.intercom_member_eligible(p.id)
  on conflict (project_id, profile_id) do nothing;
  get diagnostics v_n = row_count;

  return v_n;
end;
$$;

CREATE FUNCTION public.intercom_member_candidates(p_search text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_q text := public.f_unaccent(lower(btrim(coalesce(p_search, ''))));
  v_out jsonb;
begin
  if auth.uid() is null or not (public.intercom_is_manager() or public.is_staff()) then
    raise exception 'Không có quyền tìm người cho intercom' using errcode = '42501';
  end if;
  v_q := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');

  with base as (
    select p.id,
           coalesce(nullif(btrim(p.display_name), ''), p.full_name) as name,
           array_remove(array[case when p.is_staff then 'staff' end, case when p.is_collaborator then 'collaborator' end], null) as roles,
           public.is_active_staff(p.id) as is_staff
      from public.profiles p
     where p.deleted_at is null
       and (v_q = ''
            or public.f_unaccent(lower(coalesce(p.display_name, '') || ' ' || coalesce(p.full_name, '')))
               like '%' || v_q || '%')
  ), picked as (
    select b.*
      from base b
     where public.intercom_member_eligible(b.id)
     order by b.is_staff desc, b.name, b.id
     limit 30
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'profile_id', k.id,
           'name', k.name,
           'roles', to_jsonb(k.roles),
           'is_staff', k.is_staff,
           'has_login', exists (select 1 from auth.users u where u.id = k.id)
         ) order by k.is_staff desc, k.name, k.id), '[]'::jsonb)
    into v_out
    from picked k;

  return v_out;
end;
$$;

CREATE FUNCTION public.intercom_member_eligible(p_profile uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select exists (
    select 1
      from public.profiles p
     where p.id = p_profile
       and p.deleted_at is null
       and (p.is_collaborator or p.is_staff));
$$;

CREATE FUNCTION public.intercom_member_list(p_project uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_out jsonb;
begin
  if auth.uid() is null then
    raise exception 'Không có quyền xem thành viên intercom' using errcode = '42501';
  end if;
  -- Người ngoài danh sách nhận cùng câu với dự án không có: không lộ là có tồn tại.
  if not exists (select 1 from public.intercom_project pr where pr.id = p_project)
     or not public.intercom_can_access(p_project) then
    raise exception 'Không tìm thấy dự án' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'profile_id', m.profile_id,
           'name', coalesce(nullif(btrim(p.display_name), ''), p.full_name),
           'is_staff', p.deleted_at is null and public.is_active_staff(m.profile_id),
           'has_login', exists (select 1 from auth.users u where u.id = m.profile_id),
           'source', m.source,
           'added_at', m.added_at
         ) order by coalesce(nullif(btrim(p.display_name), ''), p.full_name), m.profile_id), '[]'::jsonb)
    into v_out
    from public.intercom_member m
    join public.profiles p on p.id = m.profile_id
   where m.project_id = p_project;

  return v_out;
end;
$$;

CREATE FUNCTION public.intercom_member_remove(p_project uuid, p_profile_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_is_manager boolean;
begin
  if auth.uid() is null then
    raise exception 'Không có quyền bỏ thành viên intercom' using errcode = '42501';
  end if;
  v_is_manager := public.intercom_is_manager();
  if not v_is_manager and not public.is_staff() then
    raise exception 'Không có quyền bỏ thành viên intercom' using errcode = '42501';
  end if;
  if not exists (select 1 from public.intercom_project pr where pr.id = p_project)
     or (not v_is_manager and not public.intercom_can_access(p_project)) then
    raise exception 'Không tìm thấy dự án' using errcode = 'P0002';
  end if;

  delete from public.intercom_member m
   where m.project_id = p_project and m.profile_id = p_profile_id;
end;
$$;

CREATE FUNCTION public.intercom_monitor_stats(p_since timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_since timestamptz := coalesce(p_since, now() - interval '24 hours');
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_projects jsonb;
  v_project_ids jsonb;
  v_recent jsonb;
  v_kind text;
  v_traffic jsonb;
  v_traffic_all jsonb;
  v_kind_recent jsonb;
  v_by_storage jsonb := '{}'::jsonb;
begin
  if not coalesce(public.intercom_can_use(null), false) then
    raise exception 'Chỉ nhân viên được xem' using errcode = '42501';
  end if;
  if v_since > now() then
    v_since := now() - interval '24 hours';
  end if;
  if v_since < now() - interval '31 days' then
    v_since := now() - interval '31 days';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'project_id', p.id,
           'name', p.name,
           'start_date', p.start_date,
           'last_date', p.start_date + p.day_count - 1,
           'originals_open_from', p.start_date + p.day_count - 1 + 8,
           'done_count', s.done_count,
           'pending_count', s.pending_count,
           'pending_stale_count', s.pending_stale_count,
           'done_bytes', s.done_bytes,
           'purged_count', s.purged_count,
           'purgeable_count', case when p.start_date + p.day_count - 1 + 7 < v_today then s.unpurged_count else 0 end,
           'purgeable_bytes', case when p.start_date + p.day_count - 1 + 7 < v_today then s.unpurged_bytes else 0 end
         ) order by p.start_date desc, p.name), '[]'::jsonb)
    into v_projects
    from public.intercom_project p
    cross join lateral (
      select count(*) filter (where h.status = 'done') as done_count,
             count(*) filter (where h.status = 'pending') as pending_count,
             count(*) filter (where h.status = 'pending' and h.created_at < now() - interval '1 hour') as pending_stale_count,
             coalesce(sum(h.size_bytes) filter (where h.status = 'done'), 0) as done_bytes,
             count(*) filter (where h.status = 'done' and h.photo_purged_at is not null) as purged_count,
             count(*) filter (where h.status = 'done' and h.photo_purged_at is null) as unpurged_count,
             coalesce(sum(h.size_bytes) filter (where h.status = 'done' and h.photo_purged_at is null), 0) as unpurged_bytes
        from public.intercom_handover h
       where h.project_id = p.id
    ) s
   where coalesce(public.intercom_can_use(p.id), false);

  select coalesce(jsonb_agg(p.id), '[]'::jsonb) into v_project_ids from public.intercom_project p;

  -- Một CTE cho ba khối: hàm `stable` không tạo bảng tạm được.
  foreach v_kind in array array['all', 'r2', 'drive'] loop
    with r as (
      select l.*
        from public.intercom_upload_log l
       where l.created_at >= v_since - interval '1 day'
         and l.started_at >= v_since
         and (v_kind = 'all'
              or (v_kind = 'r2' and l.method in ('chunk', 'single'))
              or (v_kind = 'drive' and l.method = 'direct'))
         and coalesce(public.intercom_can_use(l.project_id), false)
    ),
    summary as (
      select jsonb_build_object(
               'sends', count(*),
               'ok_count', count(*) filter (where r.outcome = 'ok'),
               'median_ms', percentile_cont(0.5) within group (order by r.duration_ms) filter (where r.outcome = 'ok'),
               'p90_ms', percentile_cont(0.9) within group (order by r.duration_ms) filter (where r.outcome = 'ok'),
               'average_speed', avg((r.photo_bytes + r.thumb_bytes)::numeric / r.duration_ms * 1000 / 1024)
                             filter (where r.outcome = 'ok' and r.duration_ms > 0),
               'mean_attempts', avg(r.attempts)
             ) as j
        from r
    ),
    reasons as (
      select coalesce(jsonb_agg(jsonb_build_object('reason', x.reason, 'count', x.n) order by x.n desc, x.reason), '[]'::jsonb) as j
        from (
          select coalesce(r.fail_reason, 'unknown') as reason, count(*) as n
            from r
           where r.outcome = 'fail'
           group by 1
        ) x
    ),
    devices as (
      select coalesce(jsonb_agg(jsonb_build_object(
               'device', x.device, 'sends', x.sends, 'ok_count', x.ok_count, 'median_ms', x.median_ms, 'average_speed', x.average_speed
             ) order by x.sends desc, x.device), '[]'::jsonb) as j
        from (
          select coalesce(r.device, '(không rõ)') as device,
                 count(*) as sends,
                 count(*) filter (where r.outcome = 'ok') as ok_count,
                 percentile_cont(0.5) within group (order by r.duration_ms) filter (where r.outcome = 'ok') as median_ms,
                 avg((r.photo_bytes + r.thumb_bytes)::numeric / r.duration_ms * 1000 / 1024)
                   filter (where r.outcome = 'ok' and r.duration_ms > 0) as average_speed
            from r
           group by 1
        ) x
    )
    select summary.j || jsonb_build_object('fail_reasons', reasons.j, 'devices', devices.j)
      into v_traffic
      from summary, reasons, devices;

    if v_kind = 'all' then
      v_traffic_all := v_traffic;
    else
      select coalesce(jsonb_agg(jsonb_build_object(
               'started_at', x.started_at,
               'project_name', x.project_name,
               'kind', x.kind,
               'method', x.method,
               'outcome', x.outcome,
               'fail_reason', x.fail_reason,
               'duration_ms', x.duration_ms,
               'photo_bytes', x.photo_bytes,
               'thumb_bytes', x.thumb_bytes,
               'attempts', x.attempts,
               'device', x.device,
               'network', x.network,
               'created_by_name', x.created_by_name
             ) order by x.started_at desc), '[]'::jsonb)
        into v_kind_recent
        from (
          select l.started_at, p.name as project_name, l.kind, l.method, l.outcome, l.fail_reason, l.duration_ms,
                 l.photo_bytes, l.thumb_bytes, l.attempts, l.device, l.network, pr.full_name as created_by_name
            from public.intercom_upload_log l
            left join public.intercom_project p on p.id = l.project_id
            left join public.profiles pr on pr.id = l.created_by
           where coalesce(public.intercom_can_use(l.project_id), false)
             and ((v_kind = 'r2' and l.method in ('chunk', 'single'))
                  or (v_kind = 'drive' and l.method = 'direct'))
           order by l.started_at desc
           limit 50
        ) x;
      v_by_storage := v_by_storage || jsonb_build_object(v_kind, jsonb_build_object('traffic', v_traffic, 'recent', v_kind_recent));
    end if;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object(
           'started_at', x.started_at,
           'project_name', x.project_name,
           'kind', x.kind,
           'method', x.method,
           'outcome', x.outcome,
           'fail_reason', x.fail_reason,
           'duration_ms', x.duration_ms,
           'photo_bytes', x.photo_bytes,
           'thumb_bytes', x.thumb_bytes,
           'attempts', x.attempts,
           'device', x.device,
           'network', x.network,
           'created_by_name', x.created_by_name
         ) order by x.started_at desc), '[]'::jsonb)
    into v_recent
    from (
      select l.started_at, p.name as project_name, l.kind, l.method, l.outcome, l.fail_reason, l.duration_ms,
             l.photo_bytes, l.thumb_bytes, l.attempts, l.device, l.network, pr.full_name as created_by_name
        from public.intercom_upload_log l
        left join public.intercom_project p on p.id = l.project_id
        left join public.profiles pr on pr.id = l.created_by
       where coalesce(public.intercom_can_use(l.project_id), false)
       order by l.started_at desc
       limit 50
    ) x;

  return jsonb_build_object(
    'since', v_since,
    'projects', v_projects,
    'project_ids', v_project_ids,
    'traffic', v_traffic_all,
    'recent', v_recent,
    'by_storage', v_by_storage
  );
end
$$;

CREATE FUNCTION public.intercom_my_access() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select jsonb_build_object(
    'is_manager', public.intercom_is_manager(),
    'project_count', coalesce(cardinality(public.intercom_my_project_ids()), 0)
  );
$$;

CREATE FUNCTION public.intercom_my_project_ids() RETURNS uuid[]
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select case
    when auth.uid() is null or not public.is_active_profile(auth.uid()) then '{}'::uuid[]
    when public.intercom_is_manager() then
      coalesce((select array_agg(pr.id) from public.intercom_project pr), '{}'::uuid[])
    else
      coalesce((select array_agg(m.project_id) from public.intercom_member m where m.profile_id = auth.uid()), '{}'::uuid[])
  end;
$$;

CREATE FUNCTION public.intercom_order_candidates(p_search text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if auth.uid() is null or not public.intercom_is_manager() then
    raise exception 'Không có quyền tạo dự án intercom từ đơn' using errcode = '42501';
  end if;
  return public._intercom_order_candidates_json(p_search);
end;
$$;

CREATE FUNCTION public.intercom_order_prefill(p_order uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_out jsonb;
begin
  if auth.uid() is null or not public.intercom_is_manager() then
    raise exception 'Không có quyền tạo dự án intercom từ đơn' using errcode = '42501';
  end if;
  if p_order is null then
    raise exception 'Chưa chọn đơn' using errcode = '22023';
  end if;
  v_out := public._intercom_order_prefill_json(p_order);
  if v_out is null then
    raise exception 'Không tìm thấy đơn có intercom (hoặc đơn đã huỷ)' using errcode = 'P0002';
  end if;
  if coalesce((v_out->>'end_date')::date < (now() at time zone 'Asia/Ho_Chi_Minh')::date, true) then
    raise exception 'Đơn đã qua ngày hoàn thành' using errcode = 'P0002';
  end if;
  return v_out;
end;
$$;

CREATE FUNCTION public.intercom_people_sheet_drive_enqueue() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  insert into public.intercom_drive_delete_queue (account_id, file_id, project_id, was_done)
  values (old.template_account_id, old.template_file_id, old.project_id, false);
  return old;
end
$$;

CREATE FUNCTION public.intercom_people_sheet_set_link(p_project uuid, p_file_id text, p_gid text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  v_uid uuid := auth.uid();
  v_file text := btrim(coalesce(p_file_id, ''));
  -- Link không có gid thì giữ null: trang đầu không chắc mang gid 0, web bỏ hẳn tham số gid.
  v_gid text := nullif(btrim(coalesce(p_gid, '')), '');
  v_sheet public.intercom_people_sheet%rowtype;
begin
  if v_uid is null or not coalesce(public.intercom_can_access(p_project), false) then
    raise exception 'Không có quyền sửa danh sách người' using errcode = '42501';
  end if;
  if v_file !~ '^[A-Za-z0-9_-]{20,200}$' then
    raise exception 'Link Google Sheet không đúng.' using errcode = '22023';
  end if;
  if v_gid is not null and v_gid !~ '^[0-9]{1,20}$' then
    raise exception 'Link Google Sheet không đúng.' using errcode = '22023';
  end if;
  perform 1 from public.intercom_project p where p.id = p_project for update;
  if not found then
    raise exception 'Không tìm thấy dự án' using errcode = 'P0002';
  end if;

  select * into v_sheet from public.intercom_people_sheet s where s.project_id = p_project for update;
  if not found then
    insert into public.intercom_people_sheet (project_id, kind, file_id, gid, created_by)
    values (p_project, 'link', v_file, v_gid, v_uid);
    return;
  end if;

  update public.intercom_people_sheet s
     set kind = 'link',
         file_id = v_file,
         gid = v_gid,
         edit_closed_reason = case when v_sheet.kind = 'template' then 'replaced' else s.edit_closed_reason end,
         updated_at = now()
   where s.project_id = p_project;

  if v_sheet.template_file_id is not null then
    update public.intercom_drive_permission d
       set want = 'off', applied_at = null, attempts = 0, last_error = null, updated_at = now()
     where d.project_id = p_project
       and d.purpose = 'sheet_edit'
       and d.file_id = v_sheet.template_file_id
       and d.want <> 'off';
  end if;
end
$_$;

CREATE FUNCTION public.intercom_people_sheet_set_template(p_gate text, p_project uuid, p_file_id text, p_account uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  v_uid uuid := auth.uid();
  v_file text := btrim(coalesce(p_file_id, ''));
begin
  if not public._intercom_drive_gate_ok(p_gate) then
    return false;
  end if;
  if v_uid is null or not coalesce(public.intercom_can_access(p_project), false) then
    raise exception 'Không có quyền sửa danh sách người' using errcode = '42501';
  end if;
  if v_file !~ '^[A-Za-z0-9_-]{1,200}$' then
    raise exception 'Mã tệp không hợp lệ' using errcode = '22023';
  end if;
  perform 1 from public.intercom_project p
   where p.id = p_project and p.storage_kind = 'drive' and p.drive_account_id = p_account
   for update;
  if not found then
    raise exception 'Dự án chưa lưu vào tài khoản Google này' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.intercom_people_sheet s where s.project_id = p_project) then
    raise exception 'Dự án đã có Sheet' using errcode = 'P0001';
  end if;

  insert into public.intercom_people_sheet (project_id, kind, file_id, gid, template_file_id, template_account_id, created_by)
  values (p_project, 'template', v_file, null, v_file, p_account, v_uid);

  insert into public.intercom_drive_permission (project_id, account_id, file_id, purpose, role, want)
  values (p_project, p_account, v_file, 'sheet_edit', 'writer', 'on')
  on conflict (project_id, purpose, file_id) do update
     set account_id = excluded.account_id, role = excluded.role, want = excluded.want,
         applied_at = null, attempts = 0, last_error = null, updated_at = now();
  return true;
end
$_$;

CREATE FUNCTION public.intercom_person_bulk_add(p_project uuid, p_rows jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  v_proj public.intercom_project%rowtype;
  v_row jsonb;
  v_index bigint;
  v_name text;
  v_dept text;
  v_group_text text;
  v_group integer;
  v_added integer := 0;
  v_skipped integer := 0;
  v_invalid jsonb := '[]'::jsonb;
begin
  if not public.intercom_can_use(p_project) then
    raise exception 'Không có quyền thêm người nhận' using errcode = '42501';
  end if;
  select * into v_proj from public.intercom_project where id = p_project for update;
  if not found then
    raise exception 'Không tìm thấy dự án' using errcode = 'P0002';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'Chưa có dòng nào' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 300 then
    raise exception 'Tối đa 300 dòng một lượt' using errcode = '22023';
  end if;

  for v_row, v_index in select e, i from jsonb_array_elements(p_rows) with ordinality as t(e, i) loop
    if jsonb_typeof(v_row) <> 'object' then
      v_invalid := v_invalid || jsonb_build_object('row', v_index, 'reason', 'Dòng không đúng khuôn');
      continue;
    end if;
    v_name := btrim(coalesce(v_row ->> 'full_name', ''));
    v_dept := btrim(coalesce(v_row ->> 'department', ''));
    v_group_text := btrim(coalesce(v_row ->> 'group_no', ''));
    v_group := case when v_group_text ~ '^[0-9]{1,2}$' then v_group_text::integer else null end;
    if v_name = '' then
      v_invalid := v_invalid || jsonb_build_object('row', v_index, 'reason', 'Thiếu tên');
      continue;
    end if;
    if char_length(v_name) > 120 then
      v_invalid := v_invalid || jsonb_build_object('row', v_index, 'reason', 'Tên dài quá 120 ký tự');
      continue;
    end if;
    if v_dept = '' then
      v_invalid := v_invalid || jsonb_build_object('row', v_index, 'reason', 'Thiếu bộ phận');
      continue;
    end if;
    if v_group is null or v_group < 1 or v_group > v_proj.group_count then
      v_invalid := v_invalid || jsonb_build_object('row', v_index, 'reason', format('Nhóm phải từ 1 tới %s', v_proj.group_count));
      continue;
    end if;
    -- Cùng luật so tên của `intercom_person_create`; dòng trùng dòng trước trong cùng lượt cũng bỏ qua.
    if exists (
      select 1 from public.intercom_person pe
       where pe.project_id = p_project and lower(btrim(pe.full_name)) = lower(v_name)
    ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    insert into public.intercom_person (project_id, full_name, department, group_no)
    values (p_project, v_name, v_dept, v_group);
    v_added := v_added + 1;
  end loop;

  return jsonb_build_object('added', v_added, 'skipped', v_skipped, 'invalid', v_invalid);
end
$_$;

CREATE FUNCTION public.intercom_person_create(p_project uuid, p_full_name text, p_department text, p_group integer, p_phone text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  v_uid uuid := auth.uid();
  v_proj public.intercom_project%rowtype;
  v_name text := btrim(coalesce(p_full_name, ''));
  v_dept text := btrim(coalesce(p_department, ''));
  v_id uuid;
  v_phone text := public._intercom_phone_normalize(p_phone);
begin
  if v_uid is null or not public.intercom_can_access(p_project) then
    raise exception 'Không có quyền ghi giao nhận intercom' using errcode = '42501';
  end if;
  select * into v_proj from public.intercom_project where id = p_project for update;
  if not found then
    raise exception 'Không tìm thấy dự án' using errcode = 'P0002';
  end if;
  if v_name = '' then
    raise exception 'Chưa nhập tên người nhận' using errcode = '22023';
  end if;
  if char_length(v_name) > 120 then
    raise exception 'Tên người nhận dài quá 120 ký tự' using errcode = '22023';
  end if;
  if v_dept = '' then
    raise exception 'Chưa nhập bộ phận' using errcode = '22023';
  end if;
  if p_group is null or p_group < 1 or p_group > v_proj.group_count then
    raise exception 'Nhóm không hợp lệ: %', p_group using errcode = '22023';
  end if;
  if v_phone is not null and v_phone !~ '^0[1-9][0-9]{8}$' then
    raise exception 'Số điện thoại cần 10 số, bắt đầu bằng 0 hoặc +84.' using errcode = '22023';
  end if;

  select pe.id into v_id
    from public.intercom_person pe
   where pe.project_id = p_project and lower(btrim(pe.full_name)) = lower(v_name)
   order by pe.created_at
   limit 1;
  if found then
    if v_phone is not null then
      update public.intercom_person set phone = v_phone where id = v_id and phone is null;
    end if;
    return v_id;
  end if;

  insert into public.intercom_person (project_id, full_name, department, group_no, phone)
  values (p_project, v_name, v_dept, p_group, v_phone)
  returning id into v_id;
  return v_id;
end
$_$;

CREATE FUNCTION public.intercom_person_delete(p_person uuid) RETURNS TABLE(photo_key text, thumb_key text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
#variable_conflict use_column
declare
  v_deliver uuid[];
  v_collect uuid[];
begin
  if not public.intercom_can_delete() then
    raise exception 'Bạn không có quyền xoá người nhận intercom' using errcode = '42501';
  end if;
  perform 1 from public.intercom_person pe
   where pe.id = p_person and public.intercom_can_access(pe.project_id)
     for update;
  if not found then
    raise exception 'Không tìm thấy người này' using errcode = 'P0002';
  end if;

  -- Khoá lượt giao của người rồi các tai liên quan (chống đua với thu, xoá lượt cùng lúc).
  perform 1 from public.intercom_handover h
   where h.kind = 'deliver' and h.person_id = p_person
   order by h.id
     for update;
  perform 1 from public.intercom_issue i
   where i.person_id = p_person
      or i.deliver_handover_id in (
           select h.id from public.intercom_handover h where h.kind = 'deliver' and h.person_id = p_person)
   order by i.id
     for update;

  select coalesce(array_agg(distinct i.deliver_handover_id), '{}'),
         coalesce(array_agg(distinct i.collect_handover_id) filter (where i.collect_handover_id is not null), '{}')
    into v_deliver, v_collect
    from public.intercom_issue i
   where i.person_id = p_person
      or i.deliver_handover_id in (
           select h.id from public.intercom_handover h where h.kind = 'deliver' and h.person_id = p_person);

  perform 1 from public.intercom_handover h where h.id = any (v_collect) order by h.id for update;

  delete from public.intercom_issue i
   where i.person_id = p_person
      or i.deliver_handover_id in (
           select h.id from public.intercom_handover h where h.kind = 'deliver' and h.person_id = p_person);

  return query
  with removed as (
    delete from public.intercom_handover h
     where h.id = any (v_collect)
       and h.kind = 'collect'
       and not exists (select 1 from public.intercom_issue i where i.collect_handover_id = h.id)
    returning h.photo_key, h.thumb_key
  )
  select r.photo_key, r.thumb_key from removed r;

  return query
  with removed as (
    delete from public.intercom_handover h
     where h.kind = 'deliver'
       and (h.person_id = p_person
            or (h.id = any (v_deliver)
                and not exists (select 1 from public.intercom_issue i where i.deliver_handover_id = h.id)))
    returning h.photo_key, h.thumb_key
  )
  select r.photo_key, r.thumb_key from removed r;

  delete from public.intercom_person pe where pe.id = p_person;
end;
$$;

CREATE FUNCTION public.intercom_person_sheet_apply(p_project uuid, p_rows jsonb, p_overwrite uuid[]) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    SET lock_timeout TO '3s'
    AS $_$
declare
  v_uid uuid := auth.uid();
  v_proj public.intercom_project%rowtype;
  v_row jsonb;
  v_index bigint;
  v_name text;
  v_dept text;
  v_group_text text;
  v_group integer;
  v_phone_raw text;
  v_phone text;
  v_person public.intercom_person%rowtype;
  v_added integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
  v_invalid jsonb := '[]'::jsonb;
begin
  if v_uid is null or not coalesce(public.intercom_can_access(p_project), false) then
    raise exception 'Không có quyền thêm người nhận' using errcode = '42501';
  end if;
  select * into v_proj from public.intercom_project where id = p_project for update;
  if not found then
    raise exception 'Không tìm thấy dự án' using errcode = 'P0002';
  end if;
  perform 1 from public.intercom_people_sheet s where s.project_id = p_project for update;
  if not found then
    raise exception 'Dự án chưa có Sheet' using errcode = 'P0001';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Chưa có dòng nào' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 300 then
    raise exception 'Tối đa 300 dòng một lượt' using errcode = '22023';
  end if;

  for v_row, v_index in select e, i from jsonb_array_elements(p_rows) with ordinality as t(e, i) loop
    if jsonb_typeof(v_row) <> 'object' then
      v_invalid := v_invalid || jsonb_build_object('row', v_index, 'reason', 'Dòng không đúng khuôn');
      continue;
    end if;
    v_name := btrim(coalesce(v_row ->> 'full_name', ''));
    v_dept := btrim(coalesce(v_row ->> 'department', ''));
    v_group_text := btrim(coalesce(v_row ->> 'group_no', ''));
    v_group := case when v_group_text ~ '^[0-9]{1,2}$' then v_group_text::integer else null end;
    v_phone_raw := v_row ->> 'phone';
    v_phone := public._intercom_phone_normalize(v_phone_raw);
    if v_name = '' then
      v_invalid := v_invalid || jsonb_build_object('row', v_index, 'reason', 'Thiếu tên');
      continue;
    end if;
    if char_length(v_name) > 120 then
      v_invalid := v_invalid || jsonb_build_object('row', v_index, 'reason', 'Tên dài quá 120 ký tự');
      continue;
    end if;
    if v_dept = '' then
      v_invalid := v_invalid || jsonb_build_object('row', v_index, 'reason', 'Thiếu bộ phận');
      continue;
    end if;
    if v_group is null or v_group < 1 or v_group > v_proj.group_count then
      v_invalid := v_invalid || jsonb_build_object('row', v_index, 'reason', format('Nhóm phải từ 1 tới %s', v_proj.group_count));
      continue;
    end if;
    if v_phone is not null and v_phone !~ '^0[1-9][0-9]{8}$' then
      v_invalid := v_invalid || jsonb_build_object('row', v_index, 'reason', 'Số điện thoại sai khuôn');
      continue;
    end if;

    -- Cùng luật so tên của `intercom_person_create` (`intercomNameKey` ở máy).
    select * into v_person
      from public.intercom_person pe
     where pe.project_id = p_project and lower(btrim(pe.full_name)) = lower(v_name)
     order by pe.created_at
     limit 1
     for update;
    if not found then
      insert into public.intercom_person (project_id, full_name, department, group_no, phone)
      values (p_project, v_name, v_dept, v_group, v_phone);
      v_added := v_added + 1;
      continue;
    end if;
    if p_overwrite is null or not (v_person.id = any (p_overwrite))
       or (v_person.department = v_dept and v_person.group_no = v_group and (v_phone is null or v_person.phone is not distinct from v_phone)) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    update public.intercom_person
       set department = v_dept, group_no = v_group, phone = coalesce(v_phone, phone)
     where id = v_person.id;
    -- Dashboard đọc bộ phận, nhóm từ lượt và từ tai: cập nhật theo như `intercom_person_update`.
    update public.intercom_issue
       set department = v_dept, group_no = v_group
     where person_id = v_person.id and (department is distinct from v_dept or group_no is distinct from v_group);
    update public.intercom_handover
       set department = v_dept, group_no = v_group
     where person_id = v_person.id and (department is distinct from v_dept or group_no is distinct from v_group);
    v_updated := v_updated + 1;
  end loop;

  update public.intercom_people_sheet s
     set loaded_at = now(), loaded_by = v_uid, updated_at = now()
   where s.project_id = p_project;

  return jsonb_build_object('added', v_added, 'updated', v_updated, 'skipped', v_skipped, 'invalid', v_invalid);
end
$_$;

CREATE FUNCTION public.intercom_person_update(p_person uuid, p_full_name text, p_department text, p_group integer, p_phone text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  v_person public.intercom_person%rowtype;
  v_proj public.intercom_project%rowtype;
  v_name text := btrim(coalesce(p_full_name, ''));
  v_dept text := btrim(coalesce(p_department, ''));
  v_phone text := public._intercom_phone_normalize(p_phone);
begin
  select * into v_person from public.intercom_person where id = p_person;
  if not found then
    raise exception 'Không tìm thấy người nhận' using errcode = 'P0002';
  end if;
  if not public.intercom_can_use(v_person.project_id) then
    raise exception 'Không có quyền sửa người nhận' using errcode = '42501';
  end if;
  select * into v_proj from public.intercom_project where id = v_person.project_id for update;
  select * into v_person from public.intercom_person where id = p_person for update;
  if not found then
    raise exception 'Không tìm thấy người nhận' using errcode = 'P0002';
  end if;
  if v_name = '' then
    raise exception 'Chưa nhập tên người nhận' using errcode = '22023';
  end if;
  if char_length(v_name) > 120 then
    raise exception 'Tên người nhận dài quá 120 ký tự' using errcode = '22023';
  end if;
  if v_dept = '' then
    raise exception 'Chưa nhập bộ phận' using errcode = '22023';
  end if;
  if p_group is null or p_group < 1 or p_group > v_proj.group_count then
    raise exception 'Nhóm không hợp lệ: %', p_group using errcode = '22023';
  end if;
  -- Cùng luật so tên của `intercom_person_create`.
  if exists (
    select 1 from public.intercom_person pe
     where pe.project_id = v_person.project_id and pe.id <> p_person and lower(btrim(pe.full_name)) = lower(v_name)
  ) then
    raise exception 'Đã có người tên "%" trong dự án', v_name using errcode = 'P0001';
  end if;
  if v_phone is not null and v_phone !~ '^0[1-9][0-9]{8}$' then
    raise exception 'Số điện thoại cần 10 số, bắt đầu bằng 0 hoặc +84.' using errcode = '22023';
  end if;

  update public.intercom_person
     set full_name = v_name, department = v_dept, group_no = p_group,
         phone = case when p_phone is null then phone else v_phone end
   where id = p_person;

  -- Dashboard đọc bộ phận, nhóm từ lượt và từ tai: cập nhật theo để khớp.
  update public.intercom_issue
     set department = v_dept, group_no = p_group
   where person_id = p_person and (department is distinct from v_dept or group_no is distinct from p_group);
  update public.intercom_handover
     set department = v_dept, group_no = p_group
   where person_id = p_person and (department is distinct from v_dept or group_no is distinct from p_group);
end
$_$;

CREATE FUNCTION public.intercom_project_apply_order(p_project uuid, p_order uuid, p_member_ids uuid[]) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_project record;
  v_order jsonb;
  v_customer uuid;
  v_other_name text;
  v_requested integer;
  v_added integer;
begin
  if auth.uid() is null or not public.intercom_is_manager() then
    raise exception 'Không có quyền nối đơn vào dự án intercom' using errcode = '42501';
  end if;
  if p_project is null or p_order is null then
    raise exception 'Thiếu dự án hoặc đơn' using errcode = '22023';
  end if;

  select pr.id, pr.name, pr.order_id into v_project
    from public.intercom_project pr where pr.id = p_project for update;
  if not found then
    raise exception 'Không tìm thấy dự án' using errcode = 'P0002';
  end if;
  if v_project.order_id is not null and v_project.order_id <> p_order then
    raise exception 'Dự án đã nối một đơn khác' using errcode = '22023';
  end if;

  v_order := public._intercom_order_prefill_json(p_order);
  if v_order is null then
    raise exception 'Không tìm thấy đơn (hoặc đơn đã huỷ)' using errcode = 'P0002';
  end if;
  v_customer := nullif(v_order->>'customer_id', '')::uuid;

  select pr.name into v_other_name
    from public.intercom_project pr where pr.order_id = p_order and pr.id <> p_project;
  if found then
    raise exception 'Đơn đã nối dự án %', v_other_name using errcode = '23505';
  end if;

  begin
    update public.intercom_project
       set order_id = p_order,
           customer_id = v_customer
     where id = p_project;
  exception when unique_violation then
    select pr.name into v_other_name from public.intercom_project pr where pr.order_id = p_order;
    raise exception 'Đơn đã nối dự án %', coalesce(v_other_name, '(không rõ)') using errcode = '23505';
  end;

  v_requested := coalesce(cardinality(array(select distinct x from unnest(p_member_ids) x where x is not null)), 0);
  insert into public.intercom_member (project_id, profile_id, source, added_by)
  select p_project, p.id, 'order', auth.uid()
    from public.profiles p
   where p.id in (select distinct x from unnest(coalesce(p_member_ids, '{}'::uuid[])) x where x is not null)
     and public.intercom_member_eligible(p.id)
  on conflict (project_id, profile_id) do nothing;
  get diagnostics v_added = row_count;

  return jsonb_build_object(
    'project_id', p_project,
    'order_id', p_order,
    'customer_id', v_customer,
    'members_requested', v_requested,
    'members_added', v_added
  );
end;
$$;

CREATE FUNCTION public.intercom_project_create(p_name text, p_start_date date, p_day_count integer, p_group_count integer, p_storage text DEFAULT NULL::text, p_drive_account uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_storage text := btrim(coalesce(p_storage, ''));
  v_id uuid;
begin
  if not public.intercom_can_use(null) then
    raise exception 'Không có quyền tạo dự án intercom' using errcode = '42501';
  end if;
  if v_name = '' then
    raise exception 'Chưa nhập tên dự án' using errcode = '22023';
  end if;
  if char_length(v_name) > 120 then
    raise exception 'Tên dự án dài quá 120 ký tự' using errcode = '22023';
  end if;
  if p_start_date is null then
    raise exception 'Chưa chọn ngày bắt đầu' using errcode = '22023';
  end if;
  if p_day_count is null or p_day_count < 1 or p_day_count > 60 then
    raise exception 'Số ngày phải từ 1 tới 60' using errcode = '22023';
  end if;
  if p_group_count is null or p_group_count < 1 or p_group_count > 6 then
    raise exception 'Số nhóm phải từ 1 tới 6' using errcode = '22023';
  end if;
  if v_storage = '' then
    raise exception 'Chọn nơi lưu ảnh.' using errcode = '22023';
  end if;
  if v_storage not in ('r2', 'drive') then
    raise exception 'Nơi lưu không hợp lệ' using errcode = '22023';
  end if;
  if v_storage = 'r2' and p_drive_account is not null then
    raise exception 'Nơi lưu không hợp lệ' using errcode = '22023';
  end if;
  if v_storage = 'drive' then
    if p_drive_account is null then
      -- "Thêm Drive": chỉ quản lý nối tài khoản Google.
      if not coalesce(public.intercom_is_manager(), false) then
        raise exception 'Chỉ quản lý intercom nối được tài khoản Google' using errcode = '42501';
      end if;
    else
      -- Người có quyền tạo dự án chọn được tài khoản `active` có sẵn.
      if not exists (select 1 from public.intercom_drive_account a where a.id = p_drive_account and a.status = 'active') then
        raise exception 'Tài khoản Drive không còn hoạt động' using errcode = '22023';
      end if;
    end if;
  end if;

  -- Thư mục Drive tạo ở route: dự án `drive` lúc này chưa nối xong.
  insert into public.intercom_project (name, start_date, end_date, day_count, group_count, created_by, storage_kind, drive_account_id, drive_folder_id)
  values (v_name, p_start_date, p_start_date + p_day_count - 1, p_day_count, p_group_count, auth.uid(),
          v_storage, case when v_storage = 'drive' then p_drive_account end, null)
  returning id into v_id;
  insert into public.intercom_member (project_id, profile_id, source, added_by)
  values (v_id, auth.uid(), 'creator', auth.uid())
  on conflict (project_id, profile_id) do nothing;
  return v_id;
end
$$;

CREATE FUNCTION public.intercom_project_delete(p_project uuid, p_confirm_name text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_name text;
begin
  if not coalesce(public.intercom_can_delete(), false) then
    raise exception 'Bạn không có quyền xoá dự án intercom' using errcode = '42501';
  end if;
  if p_project is null then
    raise exception 'Thiếu mã dự án' using errcode = '22023';
  end if;
  select p.name into v_name from public.intercom_project p where p.id = p_project for update;
  if not found then
    raise exception 'Không tìm thấy dự án' using errcode = 'P0002';
  end if;
  if not coalesce(public.intercom_can_use(p_project), false) then
    raise exception 'Bạn không có quyền xoá dự án intercom' using errcode = '42501';
  end if;
  if p_confirm_name is null or btrim(p_confirm_name) <> btrim(v_name) then
    raise exception 'Tên gõ lại không khớp tên dự án' using errcode = '22023';
  end if;
  delete from public.intercom_project where id = p_project;
  return p_project;
end
$$;

CREATE FUNCTION public.intercom_project_set_cover(p_project uuid, p_key text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare v_old text;
begin
  if not public.intercom_can_use(p_project) then raise exception 'Không có quyền sửa dự án intercom' using errcode = '42501'; end if;
  if p_key is not null and p_key !~ ('^intercom/' || p_project::text || '/cover_[0-9a-f-]{36}\.jpg$') then raise exception 'Khoá ảnh không hợp lệ' using errcode = '22023'; end if;
  select cover_key into v_old from public.intercom_project where id = p_project for update;
  if not found then raise exception 'Không tìm thấy dự án' using errcode = 'P0002'; end if;
  update public.intercom_project set cover_key = p_key where id = p_project;
  return v_old;
end $_$;

CREATE FUNCTION public.intercom_project_set_storage(p_project uuid, p_kind text, p_account uuid, p_folder text, p_gate text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if not coalesce(public.intercom_can_access(p_project), false) then
    raise exception 'Không có quyền đổi nơi lưu của dự án' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('r2', 'drive') then
    raise exception 'Nơi lưu không hợp lệ' using errcode = '22023';
  end if;
  -- Mã thư mục chỉ nhận từ máy chủ (kèm cổng): người dùng gọi thẳng hàm thì không trỏ được vào thư mục của dự án
  -- khác.
  if p_kind = 'drive' and (not public._intercom_drive_gate_ok(p_gate) or p_folder !~ '^[A-Za-z0-9_-]{1,200}$') then
    raise exception 'Nơi lưu không hợp lệ' using errcode = '42501';
  end if;
  perform 1 from public.intercom_project p where p.id = p_project for update;
  if not found then
    raise exception 'Không tìm thấy dự án' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.intercom_handover h where h.project_id = p_project) then
    raise exception 'Dự án đã có lượt, không đổi được nơi lưu.' using errcode = 'P0001';
  end if;
  -- Rời thư mục Drive cũ: gỡ quyền "ai có link đều xem" của nó, nhịp hẹn giờ thi hành.
  update public.intercom_drive_permission d
     set want = 'off', applied_at = null, attempts = 0, last_error = null, updated_at = now()
   where d.project_id = p_project
     and d.purpose = 'folder_share'
     and d.want <> 'off'
     and (p_kind = 'r2' or d.file_id is distinct from p_folder);
  if p_kind = 'drive' then
    if not exists (select 1 from public.intercom_drive_account a where a.id = p_account and a.status = 'active') then
      raise exception 'Tài khoản Drive không còn hoạt động' using errcode = '22023';
    end if;
    if coalesce(btrim(p_folder), '') = '' then
      raise exception 'Thiếu thư mục Drive' using errcode = '22023';
    end if;
    update public.intercom_project p
       set storage_kind = 'drive', drive_account_id = p_account, drive_folder_id = p_folder
     where p.id = p_project;
  else
    update public.intercom_project p
       set storage_kind = 'r2', drive_account_id = null, drive_folder_id = null
     where p.id = p_project;
  end if;
end
$$;

CREATE FUNCTION public.intercom_project_storage(p_project uuid) RETURNS TABLE(storage_kind text, is_pilot boolean, account_status text, account_id uuid, folder_id text, google_email text, has_handover boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select p.storage_kind,
         exists (select 1 from public.intercom_drive_pilot d where d.project_id = p.id),
         a.status,
         p.drive_account_id,
         p.drive_folder_id,
         a.google_email,
         exists (select 1 from public.intercom_handover h where h.project_id = p.id)
    from public.intercom_project p
    left join public.intercom_drive_account a on a.id = p.drive_account_id
   where p.id = p_project
     and coalesce(public.intercom_can_access(p.id), false);
$$;

CREATE FUNCTION public.intercom_project_storage_lock() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if exists (select 1 from public.intercom_handover h where h.project_id = old.id) then
    raise exception 'Dự án đã có lượt, không đổi được nơi lưu.' using errcode = 'P0001';
  end if;
  return new;
end
$$;

CREATE FUNCTION public.intercom_project_update(p_project uuid, p_name text, p_start_date date, p_day_count integer, p_group_count integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_proj public.intercom_project%rowtype;
  v_end date;
  v_count integer;
  v_dates text;
  v_people integer;
  v_handovers integer;
begin
  if not public.intercom_can_use(p_project) then
    raise exception 'Không có quyền sửa dự án intercom' using errcode = '42501';
  end if;
  select * into v_proj from public.intercom_project where id = p_project for update;
  if not found then
    raise exception 'Không tìm thấy dự án' using errcode = 'P0002';
  end if;
  if v_name = '' then
    raise exception 'Chưa nhập tên dự án' using errcode = '22023';
  end if;
  if char_length(v_name) > 120 then
    raise exception 'Tên dự án dài quá 120 ký tự' using errcode = '22023';
  end if;
  if p_start_date is null then
    raise exception 'Chưa chọn ngày bắt đầu' using errcode = '22023';
  end if;
  if p_day_count is null or p_day_count < 1 or p_day_count > 60 then
    raise exception 'Số ngày phải từ 1 tới 60' using errcode = '22023';
  end if;
  if p_group_count is null or p_group_count < 1 or p_group_count > 6 then
    raise exception 'Số nhóm phải từ 1 tới 6' using errcode = '22023';
  end if;
  v_end := p_start_date + p_day_count - 1;

  -- Chặn rút ngày: lượt GIAO có ngày làm việc ngoài khoảng mới (lượt thu không xét, cùng luật
  -- `intercom_handover_begin`).
  select count(*), string_agg(distinct to_char(h.work_date, 'DD/MM/YYYY'), ', ')
    into v_count, v_dates
    from public.intercom_handover h
   where h.project_id = p_project and h.kind = 'deliver'
     and (h.work_date < p_start_date or h.work_date > v_end);
  if v_count > 0 then
    raise exception 'Còn % lượt giao ngoài khoảng ngày mới (ngày %), chưa sửa được', v_count, v_dates
      using errcode = 'P0001';
  end if;

  -- Giảm số nhóm khi còn người hoặc lượt mang nhóm lớn hơn thì chặn.
  if p_group_count < v_proj.group_count then
    select count(*) into v_people
      from public.intercom_person pe where pe.project_id = p_project and pe.group_no > p_group_count;
    select count(*) into v_handovers
      from public.intercom_handover h where h.project_id = p_project and h.group_no > p_group_count;
    if v_people > 0 or v_handovers > 0 then
      raise exception 'Còn % người và % lượt ở nhóm lớn hơn %, chưa giảm được số nhóm', v_people, v_handovers, p_group_count
        using errcode = 'P0001';
    end if;
  end if;

  update public.intercom_project
     set name = v_name, start_date = p_start_date, day_count = p_day_count, end_date = v_end, group_count = p_group_count
   where id = p_project
  returning * into v_proj;

  return jsonb_build_object(
    'id', v_proj.id, 'name', v_proj.name, 'start_date', v_proj.start_date, 'end_date', v_proj.end_date,
    'group_count', v_proj.group_count, 'day_count', v_proj.day_count,
    'share_token', v_proj.share_token, 'share_revoked_at', v_proj.share_revoked_at
  );
end
$$;

CREATE FUNCTION public.intercom_share_board(p_token text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  v_project uuid;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{48}$' then
    return null;
  end if;
  select id into v_project from public.intercom_project
   where share_token = p_token and share_revoked_at is null;
  if v_project is null then
    return null;
  end if;
  return public._intercom_board_json(v_project, false);
end
$_$;

CREATE FUNCTION public.intercom_share_card(p_token text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare v_card jsonb;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{48}$' then return null; end if;
  select jsonb_build_object('name', p.name, 'cover_key', p.cover_key) into v_card from public.intercom_project p where p.share_token = p_token and p.share_revoked_at is null;
  return v_card;
end $_$;

CREATE FUNCTION public.intercom_share_drive_file(p_token text, p_handover uuid, p_thumb boolean) RETURNS TABLE(account_id uuid, file_id text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
begin
  if p_token is null or p_token !~ '^[0-9a-f]{48}$' or p_handover is null then
    return;
  end if;
  return query
    select h.drive_account_id,
           case when coalesce(p_thumb, false) or h.photo_purged_at is not null then h.drive_thumb_file_id else h.drive_file_id end
      from public.intercom_handover h
      join public.intercom_project p on p.id = h.project_id
     where h.id = p_handover
       and h.status = 'done'
       and h.drive_file_id is not null
       and p.share_token = p_token
       and p.share_revoked_at is null;
end
$_$;

CREATE FUNCTION public.intercom_share_photo_key(p_token text, p_handover uuid, p_thumb boolean) RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  v_key text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{48}$' or p_handover is null then
    return null;
  end if;
  select case
           when coalesce(p_thumb, false) then h.thumb_key
           when h.photo_purged_at is not null then h.thumb_key
           else h.photo_key
         end
    into v_key
    from public.intercom_handover h
    join public.intercom_project p on p.id = h.project_id
   where h.id = p_handover
     and h.status = 'done'
     and p.share_token = p_token
     and p.share_revoked_at is null;
  return v_key;
end
$_$;

CREATE FUNCTION public.intercom_share_revoke(p_project uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_project public.intercom_project%rowtype;
begin
  if auth.uid() is null or not public.intercom_can_access(p_project) then
    raise exception 'Không có quyền thu hồi link khách' using errcode = '42501';
  end if;
  update public.intercom_project set share_revoked_at = now() where id = p_project
  returning * into v_project;
  if not found then
    raise exception 'Không tìm thấy dự án' using errcode = 'P0002';
  end if;
  if v_project.storage_kind = 'drive' and v_project.drive_account_id is not null and v_project.drive_folder_id is not null then
    update public.intercom_drive_permission d
       set want = 'off', applied_at = null, attempts = 0, last_error = null, updated_at = now()
     where d.project_id = p_project
       and d.purpose = 'folder_share'
       and d.file_id = v_project.drive_folder_id
       and d.want <> 'off';
  end if;
end
$$;

CREATE FUNCTION public.intercom_share_rotate(p_project uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_token text := encode(extensions.gen_random_bytes(24), 'hex');
  v_project public.intercom_project%rowtype;
begin
  if auth.uid() is null or not public.intercom_can_access(p_project) then
    raise exception 'Không có quyền tạo link khách' using errcode = '42501';
  end if;
  update public.intercom_project set share_token = v_token, share_revoked_at = null where id = p_project
  returning * into v_project;
  if not found then
    raise exception 'Không tìm thấy dự án' using errcode = 'P0002';
  end if;
  if v_project.storage_kind = 'drive' and v_project.drive_account_id is not null and v_project.drive_folder_id is not null then
    insert into public.intercom_drive_permission as d (project_id, account_id, file_id, purpose, role, want)
    values (p_project, v_project.drive_account_id, v_project.drive_folder_id, 'folder_share', 'reader', 'on')
    on conflict (project_id, purpose, file_id) do update
       set account_id = excluded.account_id,
           role = excluded.role,
           want = excluded.want,
           applied_at = case when (d.want, d.role, d.account_id) is distinct from (excluded.want, excluded.role, excluded.account_id)
                             then null else d.applied_at end,
           attempts = case when (d.want, d.role, d.account_id) is distinct from (excluded.want, excluded.role, excluded.account_id)
                           then 0 else d.attempts end,
           last_error = case when (d.want, d.role, d.account_id) is distinct from (excluded.want, excluded.role, excluded.account_id)
                             then null else d.last_error end,
           updated_at = now();
  end if;
  return v_token;
end
$$;

CREATE FUNCTION public.intercom_unit_model_add_custom(p_project uuid, p_name text, p_max_units integer, p_has_master boolean, p_is_hub boolean, p_unit_hours numeric, p_master_min numeric, p_master_max numeric, p_hub_hours numeric) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
  v_next uuid;
  v_hops integer := 0;
begin
  if not public.intercom_can_use(p_project) then
    raise exception 'Không có quyền thêm Model' using errcode = '42501';
  end if;
  perform public._intercom_unit_model_validate(v_name, p_max_units, p_has_master, p_is_hub,
                                               p_unit_hours, p_master_min, p_master_max, p_hub_hours);
  insert into public.intercom_unit_model
    (name, max_units, has_master, is_hub, unit_hours, master_hours_min, master_hours_max, hub_hours, status, created_by)
  values
    (v_name, p_max_units, p_has_master, p_is_hub, p_unit_hours,
     case when p_has_master then p_master_min end, case when p_has_master then p_master_max end,
     p_hub_hours, 'pending', auth.uid())
  on conflict ((lower(name))) do nothing
  returning id into v_id;
  if v_id is not null then
    return v_id;
  end if;
  select id, merged_into into v_id, v_next from public.intercom_unit_model where lower(name) = lower(v_name);
  while v_next is not null and v_hops < 50 loop
    select id, merged_into into v_id, v_next from public.intercom_unit_model where id = v_next;
    v_hops := v_hops + 1;
  end loop;
  return v_id;
end
$$;

CREATE FUNCTION public.intercom_unit_model_approve(p_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if auth.uid() is null or not public.is_staff() then
    raise exception 'Chỉ nhân viên duyệt được Model' using errcode = '42501';
  end if;
  update public.intercom_unit_model set status = 'approved', updated_at = now() where id = p_id;
  if not found then
    raise exception 'Không tìm thấy Model' using errcode = 'P0002';
  end if;
end
$$;

CREATE FUNCTION public.intercom_unit_model_merge(p_from uuid, p_into uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_from public.intercom_unit_model%rowtype;
  v_into public.intercom_unit_model%rowtype;
  v_moved integer;
begin
  if auth.uid() is null or not public.is_staff() then
    raise exception 'Chỉ nhân viên gộp được Model' using errcode = '42501';
  end if;
  if p_from is null or p_into is null or p_from = p_into then
    raise exception 'Không gộp Model vào chính nó' using errcode = '22023';
  end if;
  -- Khoá hai dòng theo thứ tự id để hai lần gộp chéo không khoá chết.
  perform 1 from public.intercom_unit_model where id in (p_from, p_into) order by id for update;
  select * into v_from from public.intercom_unit_model where id = p_from;
  if not found then
    raise exception 'Không tìm thấy Model nguồn' using errcode = 'P0002';
  end if;
  select * into v_into from public.intercom_unit_model where id = p_into;
  if not found then
    raise exception 'Không tìm thấy Model đích' using errcode = 'P0002';
  end if;
  if v_from.merged_into is not null then
    raise exception 'Model % đã gộp rồi', v_from.name using errcode = '22023';
  end if;
  if v_into.merged_into is not null then
    raise exception 'Model % đã gộp vào Model khác, chọn Model đích khác', v_into.name using errcode = '22023';
  end if;
  update public.intercom_unit_set set model_id = p_into where model_id = p_from;
  get diagnostics v_moved = row_count;
  update public.intercom_unit_model set merged_into = p_into, updated_at = now() where id = p_from;
  return v_moved;
end
$$;

CREATE FUNCTION public.intercom_unit_model_save(p_id uuid, p_name text, p_max_units integer, p_has_master boolean, p_is_hub boolean, p_unit_hours numeric, p_master_min numeric, p_master_max numeric, p_hub_hours numeric) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_name text := btrim(coalesce(p_name, ''));
begin
  if auth.uid() is null or not public.is_staff() then
    raise exception 'Chỉ nhân viên sửa được danh mục Model' using errcode = '42501';
  end if;
  perform public._intercom_unit_model_validate(v_name, p_max_units, p_has_master, p_is_hub,
                                               p_unit_hours, p_master_min, p_master_max, p_hub_hours);
  if exists (select 1 from public.intercom_unit_model where lower(name) = lower(v_name) and id <> p_id) then
    raise exception 'Đã có Model tên %', v_name using errcode = '23505';
  end if;
  update public.intercom_unit_model
     set name = v_name,
         max_units = p_max_units,
         has_master = p_has_master,
         is_hub = p_is_hub,
         unit_hours = p_unit_hours,
         master_hours_min = case when p_has_master then p_master_min end,
         master_hours_max = case when p_has_master then p_master_max end,
         hub_hours = p_hub_hours,
         updated_at = now()
   where id = p_id;
  if not found then
    raise exception 'Không tìm thấy Model' using errcode = 'P0002';
  end if;
end
$$;

CREATE FUNCTION public.intercom_unit_model_set_photo(p_id uuid, p_key text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  v_old text;
begin
  if auth.uid() is null or not public.is_staff() then
    raise exception 'Chỉ nhân viên sửa được ảnh Model' using errcode = '42501';
  end if;
  if p_key is not null and p_key !~ ('^intercom/models/' || p_id::text || '/[0-9a-f-]{36}\.jpg$') then
    raise exception 'Khoá ảnh không hợp lệ' using errcode = '22023';
  end if;
  select photo_key into v_old from public.intercom_unit_model where id = p_id for update;
  if not found then
    raise exception 'Không tìm thấy Model' using errcode = 'P0002';
  end if;
  update public.intercom_unit_model set photo_key = p_key, updated_at = now() where id = p_id;
  return v_old;
end
$_$;

CREATE FUNCTION public.intercom_unit_remove(p_unit_ids uuid[]) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_ids uuid[];
  v_project uuid;
  v_projects integer;
  v_found integer;
  v_removed jsonb;
  v_rejected jsonb;
begin
  select array_agg(distinct x) into v_ids from unnest(p_unit_ids) as x where x is not null;
  if v_ids is null then
    raise exception 'Chưa chọn mã tai' using errcode = '22023';
  end if;
  select count(*), count(distinct u.project_id), min(u.project_id::text)::uuid
    into v_found, v_projects, v_project
    from public.intercom_unit u where u.id = any (v_ids);
  if v_found <> cardinality(v_ids) then
    raise exception 'Có mã tai không tìm thấy' using errcode = 'P0002';
  end if;
  if v_projects <> 1 then
    raise exception 'Các mã tai phải cùng một dự án' using errcode = '22023';
  end if;
  if not public.intercom_can_use(v_project) then
    raise exception 'Không có quyền sửa bộ mã tai' using errcode = '42501';
  end if;
  perform 1 from public.intercom_project where id = v_project for update;

  -- Mã đã từng giao: có `intercom_issue` trỏ tới, HOẶC nằm trong `unit_ids` của lượt nào (mảng không có FK).
  select coalesce(jsonb_agg(u.code order by u.prefix, u.seq), '[]'::jsonb) into v_rejected
    from public.intercom_unit u
   where u.id = any (v_ids)
     and (exists (select 1 from public.intercom_issue i where i.unit_id = u.id)
          or exists (select 1 from public.intercom_handover h
                      where h.project_id = v_project and u.id = any (coalesce(h.unit_ids, '{}'::uuid[]))));

  with gone as (
    delete from public.intercom_unit u
     where u.id = any (v_ids)
       and not exists (select 1 from public.intercom_issue i where i.unit_id = u.id)
       and not exists (select 1 from public.intercom_handover h
                        where h.project_id = v_project and u.id = any (coalesce(h.unit_ids, '{}'::uuid[])))
    returning u.prefix, u.seq, u.code
  )
  select coalesce(jsonb_agg(code order by prefix, seq), '[]'::jsonb) into v_removed from gone;

  -- Bỏ hết mã của một bộ thì xoá luôn dòng bộ.
  delete from public.intercom_unit_set s
   where s.project_id = v_project
     and not exists (select 1 from public.intercom_unit u where u.project_id = s.project_id and u.prefix = s.prefix);

  return jsonb_build_object('removed', v_removed, 'rejected', v_rejected);
end
$$;

CREATE FUNCTION public.intercom_unit_set_add(p_project uuid, p_prefix text, p_count integer, p_tag_note text, p_model uuid DEFAULT NULL::uuid, p_has_master boolean DEFAULT false, p_is_hub boolean DEFAULT false, p_unit_hours numeric DEFAULT NULL::numeric, p_master_min numeric DEFAULT NULL::numeric, p_master_max numeric DEFAULT NULL::numeric, p_hub_hours numeric DEFAULT NULL::numeric) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  v_prefix text := upper(btrim(coalesce(p_prefix, '')));
  v_note text := nullif(btrim(coalesce(p_tag_note, '')), '');
  v_set public.intercom_unit_set%rowtype;
  v_model public.intercom_unit_model%rowtype;
  v_has_master boolean;
  v_is_hub boolean;
  v_max integer;
  v_hops integer := 0;
  v_created jsonb;
begin
  if not public.intercom_can_use(p_project) then
    raise exception 'Không có quyền sửa bộ mã tai' using errcode = '42501';
  end if;
  perform 1 from public.intercom_project where id = p_project for update;
  if not found then
    raise exception 'Không tìm thấy dự án' using errcode = 'P0002';
  end if;
  if v_prefix !~ '^[A-Z]{1,4}$' then
    raise exception 'Tên bộ chỉ gồm 1 tới 4 chữ cái A tới Z' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 60 then
    raise exception 'Ghi chú tem dài quá 60 ký tự' using errcode = '22023';
  end if;
  if p_count is null or p_count < 1 then
    raise exception 'Số mã mỗi bộ từ 1 trở lên' using errcode = '22023';
  end if;

  -- Khoá dự án ở trên xếp hàng mọi lần thêm bộ của dự án: đọc rồi ghi không đua nhau.
  select * into v_set from public.intercom_unit_set where project_id = p_project and prefix = v_prefix;

  if found then
    -- Lối bổ sung mã lỡ xoá: giữ Model, giờ của bộ; trần và cách đếm theo bộ đã lưu, không theo tham số lệnh.
    v_has_master := v_set.has_master;
    if v_set.model_id is not null then
      select * into v_model from public.intercom_unit_model where id = v_set.model_id;
      v_max := v_model.max_units;
      if p_count > v_max then
        raise exception '% tối đa % tai.', v_model.name, v_max using errcode = '22023';
      end if;
    else
      v_max := case when v_has_master then 21 else 20 end;
      if p_count > v_max then
        raise exception 'Số mã mỗi bộ từ 1 tới %', v_max using errcode = '22023';
      end if;
    end if;
    if v_note is not null then
      update public.intercom_unit_set set tag_note = v_note where project_id = p_project and prefix = v_prefix;
    end if;
  else
    v_has_master := coalesce(p_has_master, false);
    v_is_hub := coalesce(p_is_hub, false);
    if v_is_hub and v_has_master then
      raise exception 'Bộ Hub không có tai chủ' using errcode = '22023';
    end if;
    if p_model is not null then
      select * into v_model from public.intercom_unit_model where id = p_model;
      if not found then
        raise exception 'Không tìm thấy Model' using errcode = 'P0002';
      end if;
      -- Model đã gộp: lần theo `merged_into` tới Model cuối chuỗi (cùng luật thêm Custom).
      while v_model.merged_into is not null and v_hops < 50 loop
        select * into v_model from public.intercom_unit_model where id = v_model.merged_into;
        v_hops := v_hops + 1;
      end loop;
      v_max := v_model.max_units;
      if p_count > v_max then
        raise exception '% tối đa % tai.', v_model.name, v_max using errcode = '22023';
      end if;
      if p_unit_hours is null then
        raise exception 'Thiếu giờ pin tai thường' using errcode = '22023';
      end if;
      if v_has_master and (p_master_min is null or p_master_max is null) then
        raise exception 'Thiếu giờ pin tai chủ Từ, Đến' using errcode = '22023';
      end if;
    else
      v_max := case when v_has_master then 21 else 20 end;
      if p_count > v_max then
        raise exception 'Số mã mỗi bộ từ 1 tới %', v_max using errcode = '22023';
      end if;
    end if;
    if (p_unit_hours is not null and (p_unit_hours < 0.5 or p_unit_hours > 48))
       or (v_has_master and p_master_min is not null and (p_master_min < 0.5 or p_master_min > 48))
       or (v_has_master and p_master_max is not null and (p_master_max < 0.5 or p_master_max > 48))
       or (v_is_hub and p_hub_hours is not null and (p_hub_hours < 0.5 or p_hub_hours > 48)) then
      raise exception 'Giờ pin từ 0,5 tới 48' using errcode = '22023';
    end if;
    if v_has_master and p_master_min > p_master_max then
      raise exception 'Giờ pin tai chủ: Từ không lớn hơn Đến' using errcode = '22023';
    end if;
    insert into public.intercom_unit_set
      (project_id, prefix, tag_note, model_id, has_master, is_hub, unit_hours, master_hours_min, master_hours_max, hub_hours)
    values
      (p_project, v_prefix, v_note, v_model.id, v_has_master, v_is_hub, p_unit_hours,
       case when v_has_master then p_master_min end, case when v_has_master then p_master_max end,
       case when v_is_hub then p_hub_hours end);
  end if;

  -- Bộ có tai chủ: seq 0 (`M`) cộng 1 tới `p_count - 1`; không: 1 tới `p_count`. Chỉ thêm số còn thiếu, không đụng
  -- mã cũ.
  with created as (
    insert into public.intercom_unit (project_id, prefix, seq)
    select p_project, v_prefix, s
      from generate_series(case when v_has_master then 0 else 1 end,
                           case when v_has_master then p_count - 1 else p_count end) as s
     where not exists (
       select 1 from public.intercom_unit u where u.project_id = p_project and u.prefix = v_prefix and u.seq = s)
    returning id, prefix, seq, code
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'prefix', prefix, 'seq', seq, 'code', code) order by seq),
                  '[]'::jsonb)
    into v_created
    from created;
  return v_created;
end
$_$;

CREATE FUNCTION public.intercom_unit_set_update(p_project uuid, p_prefix text, p_tag_note text, p_model uuid DEFAULT NULL::uuid, p_unit_hours numeric DEFAULT NULL::numeric, p_master_min numeric DEFAULT NULL::numeric, p_master_max numeric DEFAULT NULL::numeric, p_hub_hours numeric DEFAULT NULL::numeric) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_prefix text := upper(btrim(coalesce(p_prefix, '')));
  v_note text := nullif(btrim(coalesce(p_tag_note, '')), '');
  v_set public.intercom_unit_set%rowtype;
  v_model public.intercom_unit_model%rowtype;
  v_count integer;
  v_min numeric;
  v_max numeric;
begin
  if not public.intercom_can_use(p_project) then
    raise exception 'Không có quyền sửa bộ mã tai' using errcode = '42501';
  end if;
  if v_note is not null and char_length(v_note) > 60 then
    raise exception 'Ghi chú tem dài quá 60 ký tự' using errcode = '22023';
  end if;
  select * into v_set from public.intercom_unit_set where project_id = p_project and prefix = v_prefix for update;
  if not found then
    raise exception 'Không tìm thấy bộ %', v_prefix using errcode = 'P0002';
  end if;
  if p_model is not null then
    select * into v_model from public.intercom_unit_model where id = p_model;
    if not found then
      raise exception 'Không tìm thấy Model' using errcode = 'P0002';
    end if;
    if v_model.merged_into is not null then
      raise exception 'Model % đã gộp vào Model khác, chọn lại', v_model.name using errcode = '22023';
    end if;
    select count(*) into v_count from public.intercom_unit where project_id = p_project and prefix = v_prefix;
    if v_count > v_model.max_units then
      raise exception 'Bộ đang có % mã, % tối đa % tai. Bỏ bớt mã hoặc chọn Model khác.', v_count, v_model.name, v_model.max_units
        using errcode = '22023';
    end if;
  end if;
  if (p_unit_hours is not null and (p_unit_hours < 0.5 or p_unit_hours > 48))
     or (p_master_min is not null and (p_master_min < 0.5 or p_master_min > 48))
     or (p_master_max is not null and (p_master_max < 0.5 or p_master_max > 48))
     or (p_hub_hours is not null and (p_hub_hours < 0.5 or p_hub_hours > 48)) then
    raise exception 'Giờ pin từ 0,5 tới 48' using errcode = '22023';
  end if;
  -- Giờ tai chủ chỉ có nghĩa với bộ có tai chủ, giờ Hub chỉ với bộ Hub (cờ của bộ không đổi ở hộp này).
  v_min := case when v_set.has_master then coalesce(p_master_min, v_set.master_hours_min) end;
  v_max := case when v_set.has_master then coalesce(p_master_max, v_set.master_hours_max) end;
  if v_min > v_max then
    raise exception 'Giờ pin tai chủ: Từ không lớn hơn Đến' using errcode = '22023';
  end if;
  update public.intercom_unit_set
     set tag_note = v_note,
         model_id = coalesce(p_model, model_id),
         unit_hours = coalesce(p_unit_hours, unit_hours),
         master_hours_min = v_min,
         master_hours_max = v_max,
         hub_hours = case when is_hub then coalesce(p_hub_hours, hub_hours) end
   where project_id = p_project and prefix = v_prefix;
end
$$;

CREATE FUNCTION public.intercom_upload_log_add(p_rows jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_uid uuid := auth.uid();
  v_row jsonb;
  v_project uuid;
  v_written integer := 0;
  v_skipped integer := 0;
begin
  if v_uid is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Nhật ký gửi ảnh phải là một mảng' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 20 then
    raise exception 'Mỗi lượt ghi tối đa 20 dòng nhật ký' using errcode = '22023';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    begin
      if jsonb_typeof(v_row) <> 'object' then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      v_project := nullif(v_row->>'project_id', '')::uuid;
      if not coalesce(public.intercom_can_use(v_project), false) then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      insert into public.intercom_upload_log (
        handover_id, project_id, created_by, kind, started_at, finished_at, duration_ms,
        photo_bytes, thumb_bytes, attempts, method, outcome, fail_reason, device, network
      ) values (
        (v_row->>'handover_id')::uuid,
        v_project,
        v_uid,
        v_row->>'kind',
        (v_row->>'started_at')::timestamptz,
        (v_row->>'finished_at')::timestamptz,
        greatest(0, least(coalesce((v_row->>'duration_ms')::numeric, 0), 2147483647))::integer,
        greatest(0, least(coalesce((v_row->>'photo_bytes')::numeric, 0), 2147483647))::integer,
        greatest(0, least(coalesce((v_row->>'thumb_bytes')::numeric, 0), 2147483647))::integer,
        greatest(0, least(coalesce((v_row->>'attempts')::numeric, 1), 1000))::smallint,
        v_row->>'method',
        v_row->>'outcome',
        left(nullif(btrim(v_row->>'fail_reason'), ''), 40),
        left(nullif(btrim(v_row->>'device'), ''), 120),
        left(nullif(btrim(v_row->>'network'), ''), 20)
      );
      v_written := v_written + 1;
    exception when others then
      if sqlstate = '42501' then
        raise;
      end if;
      v_skipped := v_skipped + 1;
    end;
  end loop;

  return jsonb_build_object('written', v_written, 'skipped', v_skipped);
end
$$;

CREATE FUNCTION public.kick_intercom_drive_cron() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_secret text;
  v_url text;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_due boolean;
begin
  v_due :=
    exists (
      select 1
        from public.intercom_handover h
        join public.intercom_project p on p.id = h.project_id
        join public.intercom_drive_account a on a.id = p.drive_account_id and a.status = 'active'
       where h.status = 'done' and h.storage_fallback_at is not null and h.drive_moved_at is null
         and h.move_attempts < 8 and p.storage_kind = 'drive' and p.drive_folder_id is not null)
    or exists (
      select 1
        from public.intercom_handover h
        join public.intercom_project p on p.id = h.project_id
        join public.intercom_drive_account a on a.id = h.drive_account_id and a.status = 'active'
       where h.status = 'done' and h.drive_file_id is not null and h.drive_placed_at is null
         and h.move_attempts < 8 and p.drive_folder_id is not null)
    or exists (
      select 1
        from public.intercom_drive_permission d
        join public.intercom_drive_account a on a.id = d.account_id and a.status = 'active'
       where d.applied_at is null and d.attempts < 8 and d.last_error is distinct from 'cannot_share')
    or exists (
      select 1
        from public.intercom_people_sheet s
        join public.intercom_project p on p.id = s.project_id
       where s.kind = 'template' and s.template_file_id is not null
         and (
           (p.end_date < v_today
            and exists (select 1 from public.intercom_drive_permission d
                         where d.project_id = s.project_id and d.purpose = 'sheet_edit'
                           and d.file_id = s.template_file_id and d.want = 'on'))
           or (s.edit_closed_reason = 'ended' and p.end_date >= v_today)
         ))
    or exists (
      select 1 from public.intercom_drive_delete_queue q
       where q.done_at is null and q.attempts < 5);
  if not v_due then
    return;
  end if;

  v_secret := coalesce(public.host_setting_value('intercom_cron_secret'), '');
  v_url := coalesce(public.host_setting_value('intercom_cron_url'), '');
  if v_secret = '' or v_url !~ '^https://' then
    raise notice 'kick_intercom_drive_cron: chưa cấu hình intercom_cron_url, intercom_cron_secret, bỏ lượt này';
    return;
  end if;
  begin
    perform net.http_post(
      url     := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
      body    := '{}'::jsonb,
      timeout_milliseconds := 60000);
  exception when others then
    raise notice 'kick_intercom_drive_cron: gọi route hỏng (%), nhịp sau gọi lại', sqlerrm;
  end;
end
$$;

CREATE FUNCTION public.intercom_touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$begin new.updated_at := now(); return new; end$$;

SET default_tablespace = '';

SET default_table_access_method = heap;

CREATE TRIGGER trg_intercom_drive_permission_upd BEFORE UPDATE ON public.intercom_drive_permission FOR EACH ROW EXECUTE FUNCTION public.intercom_touch_updated_at();

CREATE TRIGGER trg_intercom_handover_drive_enqueue BEFORE DELETE ON public.intercom_handover FOR EACH ROW WHEN ((old.drive_file_id IS NOT NULL)) EXECUTE FUNCTION public.intercom_handover_drive_enqueue();

CREATE TRIGGER trg_intercom_handover_drive_guard BEFORE UPDATE OF status ON public.intercom_handover FOR EACH ROW WHEN (((old.status = 'pending'::text) AND (new.status = 'done'::text) AND (new.drive_file_id IS NULL))) EXECUTE FUNCTION public.intercom_handover_drive_guard();

CREATE TRIGGER trg_intercom_people_sheet_drive_enqueue BEFORE DELETE ON public.intercom_people_sheet FOR EACH ROW WHEN (((old.template_file_id IS NOT NULL) AND (old.template_account_id IS NOT NULL))) EXECUTE FUNCTION public.intercom_people_sheet_drive_enqueue();

CREATE TRIGGER trg_intercom_people_sheet_upd BEFORE UPDATE ON public.intercom_people_sheet FOR EACH ROW EXECUTE FUNCTION public.intercom_touch_updated_at();

CREATE TRIGGER trg_intercom_project_storage_lock BEFORE UPDATE OF storage_kind, drive_account_id, drive_folder_id ON public.intercom_project FOR EACH ROW WHEN (((old.storage_kind IS DISTINCT FROM new.storage_kind) OR (old.drive_account_id IS DISTINCT FROM new.drive_account_id) OR (old.drive_folder_id IS DISTINCT FROM new.drive_folder_id))) EXECUTE FUNCTION public.intercom_project_storage_lock();

CREATE TRIGGER trg_intercom_unit_model_upd BEFORE UPDATE ON public.intercom_unit_model FOR EACH ROW EXECUTE FUNCTION public.intercom_touch_updated_at();

CREATE POLICY intercom_handover_member_read ON public.intercom_handover FOR SELECT TO authenticated USING ((project_id = ANY (( SELECT public.intercom_my_project_ids() AS intercom_my_project_ids)::uuid[])));

CREATE POLICY intercom_issue_member_read ON public.intercom_issue FOR SELECT TO authenticated USING ((project_id = ANY (( SELECT public.intercom_my_project_ids() AS intercom_my_project_ids)::uuid[])));

CREATE POLICY intercom_people_sheet_member_read ON public.intercom_people_sheet FOR SELECT TO authenticated USING (public.intercom_can_access(project_id));

CREATE POLICY intercom_person_member_read ON public.intercom_person FOR SELECT TO authenticated USING ((project_id = ANY (( SELECT public.intercom_my_project_ids() AS intercom_my_project_ids)::uuid[])));

CREATE POLICY intercom_project_member_read ON public.intercom_project FOR SELECT TO authenticated USING ((id = ANY (( SELECT public.intercom_my_project_ids() AS intercom_my_project_ids)::uuid[])));

CREATE POLICY intercom_unit_member_read ON public.intercom_unit FOR SELECT TO authenticated USING ((project_id = ANY (( SELECT public.intercom_my_project_ids() AS intercom_my_project_ids)::uuid[])));

CREATE POLICY intercom_unit_model_read ON public.intercom_unit_model FOR SELECT TO authenticated USING ((( SELECT public.is_staff() AS is_staff) OR ( SELECT public.intercom_is_manager() AS intercom_is_manager) OR (cardinality(( SELECT public.intercom_my_project_ids() AS intercom_my_project_ids)) > 0)));

CREATE POLICY intercom_unit_set_member_read ON public.intercom_unit_set FOR SELECT TO authenticated USING ((project_id = ANY (( SELECT public.intercom_my_project_ids() AS intercom_my_project_ids)::uuid[])));

CREATE POLICY intercom_upload_log_member_read ON public.intercom_upload_log FOR SELECT TO authenticated USING (((project_id = ANY (( SELECT public.intercom_my_project_ids() AS intercom_my_project_ids)::uuid[])) OR ((project_id IS NULL) AND ( SELECT public.intercom_is_manager() AS intercom_is_manager))));

-- Quyền gọi hàm: thu hồi hết rồi cấp lại từng hàm (Supabase mặc định mở hàm mới cho anon, authenticated).
do $$
declare
  v_fn regprocedure;
begin
  for v_fn in
    select p.oid::regprocedure from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and (p.proname like 'intercom%' or p.proname like '\_intercom%' or p.proname = 'kick_intercom_drive_cron')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
  end loop;
end
$$;

GRANT EXECUTE ON FUNCTION public._intercom_board_json(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public._intercom_handover_result(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public._intercom_phone_normalize(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.intercom_board(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_can_access(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_can_delete() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_can_use(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_cleanup_originals(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_cleanup_pending(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_drive_account_cipher(text, uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_drive_account_list() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_drive_account_mark_revoked(text, uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_drive_account_options() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_drive_account_save(text, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_drive_bench_log(uuid, uuid, uuid, integer, integer, integer, integer, text, text, text, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_drive_bench_trash(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_drive_monitor() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_drive_move_done(text, uuid, text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_drive_move_fail(text, uuid, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_drive_move_take(text, integer) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_drive_permission_done(text, uuid, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_drive_permission_fail(text, uuid, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_drive_permission_take(text, uuid, integer) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_drive_permission_upsert(text, uuid, uuid, text, text, text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_drive_place_done(text, uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_drive_place_fail(text, uuid, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_drive_place_take(text, integer) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_drive_queue_done(text, uuid, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_drive_queue_reset(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_drive_queue_take(text, integer) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_drive_sheet_schedule(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_drive_staging_set(text, uuid, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_handover_abort(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_handover_add_units(uuid, uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_handover_begin(uuid, uuid, text, uuid[], uuid[], uuid, text, integer, text, timestamp with time zone, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_handover_delete(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_handover_drive_enqueue() TO service_role;
GRANT EXECUTE ON FUNCTION public.intercom_handover_drive_file(uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_handover_drive_guard() TO service_role;
GRANT EXECUTE ON FUNCTION public.intercom_handover_fallback_r2(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_handover_finish(uuid, integer, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_handover_set_drive_files(text, uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_handover_set_person(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_is_manager() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_issue_mark_fault(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_member_add(uuid, uuid[], text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_member_candidates(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_member_eligible(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.intercom_member_list(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_member_remove(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_monitor_stats(timestamp with time zone) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_my_access() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_my_project_ids() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_order_candidates(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_order_prefill(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_people_sheet_drive_enqueue() TO service_role;
GRANT EXECUTE ON FUNCTION public.intercom_people_sheet_set_link(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_people_sheet_set_template(text, uuid, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_person_bulk_add(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_person_create(uuid, text, text, integer, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_person_delete(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_person_sheet_apply(uuid, jsonb, uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_person_update(uuid, text, text, integer, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_project_apply_order(uuid, uuid, uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_project_create(text, date, integer, integer, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_project_delete(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_project_set_cover(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_project_set_storage(uuid, text, uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_project_storage(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_project_storage_lock() TO service_role;
GRANT EXECUTE ON FUNCTION public.intercom_project_update(uuid, text, date, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_share_board(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_share_card(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_share_drive_file(text, uuid, boolean) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_share_photo_key(text, uuid, boolean) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_share_revoke(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_share_rotate(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_unit_model_add_custom(uuid, text, integer, boolean, boolean, numeric, numeric, numeric, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_unit_model_approve(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_unit_model_merge(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_unit_model_save(uuid, text, integer, boolean, boolean, numeric, numeric, numeric, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_unit_model_set_photo(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_unit_remove(uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_unit_set_add(uuid, text, integer, text, uuid, boolean, boolean, numeric, numeric, numeric, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_unit_set_update(uuid, text, text, uuid, numeric, numeric, numeric, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intercom_upload_log_add(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kick_intercom_drive_cron() TO service_role;
