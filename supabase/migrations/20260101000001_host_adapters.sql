-- ĐIỂM ĐẤU: phần hệ thống của bạn mà mô đun Intercom dựa vào. Bộ này tự chạy được trên Supabase trống.
-- Đã có bảng người dùng, phân quyền riêng: giữ TÊN và KIỂU TRẢ VỀ của các hàm dưới đây, thay thân hàm.

create extension if not exists unaccent with schema extensions;

-- 1. Hồ sơ người. Thay bằng bảng nhân sự của bạn (hoặc một view cùng tên cột, thêm FK cho các bảng intercom_*).
--    Người chưa có tài khoản đăng nhập vẫn có hồ sơ được, nên `id` không trỏ sang `auth.users`.
create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (btrim(full_name) <> ''),
  display_name text,
  email text,
  phone text,
  avatar_url text,
  role_name text,
  is_staff boolean not null default false,
  is_admin boolean not null default false,
  is_collaborator boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
comment on table public.profiles is 'Hồ sơ người dùng. id trùng auth.users.id khi người đó đăng nhập được.';
alter table public.profiles enable row level security;
revoke all on public.profiles from public, anon, authenticated;
-- Chỉ đọc hồ sơ của mình. Không ai tự ghi được: cột quyền nằm ở đây, quản trị sửa bằng SQL hoặc service role.
grant select on public.profiles to authenticated;
create policy profiles_self_read on public.profiles for select to authenticated using (id = (select auth.uid()));

-- 2. Quyền.
-- Hồ sơ còn hiệu lực: mọi hàm quyền của mô đun đòi điều này. Đặt `deleted_at` là mất mọi quyền, kể cả quyền đến từ
-- `intercom_manager`, `intercom_member`, `intercom_deleter`.
create function public.is_active_profile(p_profile uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = p_profile and p.deleted_at is null);
$$;

create function public.is_active_staff(p_profile uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = p_profile and p.is_staff and p.deleted_at is null);
$$;

-- Người gọi có phải nhân viên: tạo dự án, sửa danh mục Model, xem Monitor.
create function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and public.is_active_staff(auth.uid());
$$;

-- Người gọi có phải quản trị: thấy mọi dự án, được xoá.
create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin and p.deleted_at is null);
$$;

revoke all on function public.is_active_profile(uuid) from public, anon, authenticated;
revoke all on function public.is_active_staff(uuid) from public, anon, authenticated;
revoke all on function public.is_staff() from public, anon;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_staff() to authenticated;
grant execute on function public.is_admin() to authenticated;

-- 3. Tìm không dấu.
create function public.f_unaccent(p_text text) returns text
language sql immutable parallel safe strict set search_path = '' as $$
  select extensions.unaccent('extensions.unaccent'::regdictionary, p_text);
$$;
revoke all on function public.f_unaccent(text) from public, anon;
grant execute on function public.f_unaccent(text) to authenticated;

-- 4. Cấu hình phía máy chủ, không vai nào của API đọc được. Khoá đang dùng: `intercom_cron_url`, `intercom_cron_secret`.
create table public.host_setting (
  key text primary key,
  value text not null
);
alter table public.host_setting enable row level security;
revoke all on public.host_setting from public, anon, authenticated;

create function public.host_setting_value(p_key text) returns text
language sql stable security definer set search_path = '' as $$
  select s.value from public.host_setting s where s.key = p_key;
$$;
revoke all on function public.host_setting_value(text) from public, anon, authenticated;

-- 5. Đơn hàng. Hai hàm nội bộ dưới đây là chỗ DUY NHẤT đọc đơn; thân mẫu trả rỗng nên màn chọn đơn hiện trống.
--    Chỉ các hàm SECURITY DEFINER của intercom gọi chúng, sau khi đã kiểm quyền quản lý. Đừng trả cột tiền, giá.
--
--    Danh sách: mảng JSON tối đa 50 dòng, mỗi dòng
--      { order_id uuid, display_code text, start_date date, end_date date, status text, customer_name text,
--        customer_code text, unit_count int (null là chưa rõ), linked_project_id uuid, linked_project_name text }
--      Hai khoá linked_*: dự án đã nối đơn này, đọc từ `intercom_project.order_id`.
create function public._intercom_order_candidates_json(p_search text) returns jsonb
language plpgsql stable set search_path = '' as $$
begin
  return '[]'::jsonb;
end
$$;

--    Điền sẵn một đơn: null khi không có đơn hoặc đơn đã huỷ, ngược lại
--      { order_id, display_code, name (tối đa 120 ký tự), start_date, end_date, day_count (1 tới 60), date_warning bool,
--        customer_id uuid, customer_code, customer_name, unit_count,
--        units_by_model: [{ model_name, unit_count }],
--        members: [{ profile_id, name, is_staff bool, has_login bool, eligible bool }],
--        linked_project_id, linked_project_name }
create function public._intercom_order_prefill_json(p_order uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
begin
  return null;
end
$$;
revoke all on function public._intercom_order_candidates_json(text) from public, anon, authenticated;
revoke all on function public._intercom_order_prefill_json(uuid) from public, anon, authenticated;
