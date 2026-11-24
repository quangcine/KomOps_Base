-- Tuỳ chọn, chạy tay khi dùng Google Drive: cứ 10 phút gọi route dọn hàng đợi Drive.
-- Cần bật pg_cron, pg_net ở Dashboard > Database > Extensions, rồi thay hai giá trị dưới đây.
create extension if not exists pg_cron;
create extension if not exists pg_net;

insert into public.host_setting (key, value) values
  ('intercom_cron_url', 'https://YOUR_DOMAIN/api/intercom/drive/cron'),
  ('intercom_cron_secret', 'CHANGE_ME')
on conflict (key) do update set value = excluded.value;

select cron.schedule('intercom-drive-cron', '*/10 * * * *', $cron$ select public.kick_intercom_drive_cron() $cron$);
