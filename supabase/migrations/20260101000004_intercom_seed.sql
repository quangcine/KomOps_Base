-- Danh mục Model tai nghe mẫu: sửa, xoá theo thiết bị của bạn.
insert into public.intercom_unit_model
  (name, max_units, has_master, is_hub, unit_hours, master_hours_min, master_hours_max, hub_hours, status)
values
  ('Model mẫu có tai chủ', 8, true, false, 10, 4, 10, null, 'approved'),
  ('Model mẫu dùng Hub', 20, false, true, 10, null, null, null, 'approved');
