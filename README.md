# KomOps Base

Mã nguồn tham khảo của mô đun **Intercom**: giao, nhận tai nghe bộ đàm trong một sự kiện bằng ảnh chụp. Chụp lúc giao, chụp lúc nhận, bảng theo dõi ai đang cầm mã nào, link chỉ xem cho khách, danh sách người từ Google Sheet, lưu ảnh ở Cloudflare R2 hoặc Google Drive.

Đây là bộ mã để bạn **tự đấu nối và tự chạy trên hạ tầng của mình**, không phải dịch vụ chạy sẵn, không kèm hỗ trợ.

## Giấy phép

[Elastic License 2.0](LICENSE), bên cấp phép `quangcine`. Nói gọn: được dùng nội bộ, sửa, đấu nối; **không** được đem làm dịch vụ trên mạng cho người khác; giữ nguyên thông báo bản quyền. Văn bản trong `LICENSE` mới có hiệu lực.

## Cần gì

- Node.js 22.12 trở lên.
- Một dự án Supabase (database và đăng nhập).
- Một bucket Cloudflare R2 **riêng tư**. Muốn lưu ở Drive thì thêm một OAuth client của Google.
- Tài khoản Cloudflare Workers để chạy thật (hoặc nền tảng khác, tự thay phần đọc `getCloudflareContext`).

## Chạy thử

1. `npm ci`
2. Chạy lần lượt các tệp trong `supabase/migrations/` trên database trống: dán vào SQL Editor theo thứ tự tên, hoặc dùng Supabase CLI (kho không kèm `config.toml`): `supabase init`, `supabase link --project-ref <mã dự án>`, rồi `supabase db push`.
3. Chép `.env.example` thành `.env.local`, điền hai giá trị Supabase.
4. Tắt tự đăng ký ở Supabase (Authentication > Sign In / Providers), tạo một người dùng email và mật khẩu, rồi mở quyền quản trị cho người đó:

   ```sql
   insert into public.profiles (id, full_name, email, is_staff, is_admin)
   values ('<id trong auth.users>', 'Tên của bạn', 'ban@example.com', true, true);
   ```

5. `npm run dev`, mở `http://localhost:3000`. Chế độ này không có R2: xem màn, sửa dữ liệu được, lưu và mở ảnh báo lỗi.
   Muốn thử ảnh thì sửa `wrangler.jsonc`, chạy `npm run preview` (R2 giả lập trên máy, cổng 8787). Trước đó đặt `NEXT_PUBLIC_APP_ORIGIN=http://localhost:8787` trong `.env.local`: giá trị này nhúng lúc build, để 3000 thì link khách và bước nối Drive sai.
6. Kiểm kiểu: `npm run type-check`.

Chạy thật: đặt `NEXT_PUBLIC_APP_ORIGIN` là tên miền https của bạn trước khi build, rồi `npm run deploy`.

## Đấu nối từng điểm

| Điểm | Tệp | Bản mẫu làm gì | Bạn thay gì |
|---|---|---|---|
| Đăng nhập | `src/adapters/auth.ts`, `authServer.ts`, `SessionGate.tsx` | Supabase Auth, email và mật khẩu | Nhà cung cấp khác. Phiên phải ra JWT mà Supabase nhận, vì mọi hàm SQL đọc `auth.uid()` |
| Quyền | `20260101000001_host_adapters.sql`: `is_staff()`, `is_admin()`, `is_active_staff()`, `is_active_profile()` | Cờ trên bảng `profiles`; đặt `deleted_at` là mất mọi quyền | Thân hàm, đọc từ bảng phân quyền của bạn. Giữ tên, kiểu trả về |
| Nhân sự | bảng `profiles` | Bảng riêng | Bảng hoặc view cùng tên cột. Người ngoài có `is_collaborator` thì thêm được vào dự án. Là view thì bỏ các khoá ngoại trỏ tới `profiles` ở tệp 02 |
| Quản lý, người được xoá | bảng `intercom_manager`, `intercom_deleter` | Trống, chỉ quản trị có quyền | Thêm `profile_id` bằng SQL |
| Đơn hàng | cùng tệp SQL, mục 5; `src/adapters/orders.ts` | Trả rỗng: màn chọn đơn hiện trống | Thân hai hàm `_intercom_order_*_json`; hình dạng JSON ghi ngay trên hàm |
| Lưu ảnh | `src/adapters/storage.ts`, `src/app/api/intercom/monitor/_shared.ts` | R2, binding `MEDIA_BUCKET` | Kho khác có cùng các hàm `put`, `get`, `delete`, `list` |
| Google Drive | `.dev.vars.example`, `src/app/api/intercom/drive/` | Tắt tới khi có đủ secret | Xem mục dưới |
| Tên, tên miền, logo | `.env.example`, `src/adapters/brand.ts`, `src/components/ui/WorkLogo.tsx`, `public/og-default.png` | Tên trung tính | Nhận diện của bạn |

### Google Drive (tuỳ chọn)

1. Tạo OAuth client kiểu Web, quyền `drive.file`, URI quay về `https://<tên miền>/api/intercom/drive/callback`.
2. Đặt năm secret đầu của `.dev.vars.example` (chuỗi ngẫu nhiên: `openssl rand -hex 32`). Cổng ngắn hơn 32 ký tự bị từ chối.
3. Nạp băm của cổng vào database. Biến phải có trong shell đang gõ (ghi vào `.dev.vars` thôi là chưa có), thiếu thì lệnh dưới báo lỗi thay vì băm chuỗi rỗng:

   Chạy **từng dòng một**, đừng dán cả khối: dòng `read` chờ bạn nhập giá trị.

   ```sh
   read -rs INTERCOM_DRIVE_GATE
   ```

   Dán đúng chuỗi đã đặt làm secret, bấm Enter, rồi mới chạy:

   ```sh
   printf %s "${INTERCOM_DRIVE_GATE:?chua dat INTERCOM_DRIVE_GATE}" | shasum -a 256
   ```

   Lấy 64 ký tự hex vừa in ra nạp vào database:

   ```sql
   insert into public.intercom_drive_gate (gate_hash) values ('<64 ký tự hex>');
   ```

4. Sửa rồi chạy `supabase/optional_drive_cron.sql` để có nhịp dọn hàng đợi.
5. Màn đo `/intercom/drive-bench?project=<mã dự án>` chỉ mở cho quản lý, và dự án phải có trong bảng thử: `insert into public.intercom_drive_pilot (project_id) values ('<mã dự án>');`

Bật link khách cho dự án Drive sẽ mở thư mục ảnh kiểu "ai có link đều xem". Sheet mẫu danh sách người mở kiểu "ai có link đều sửa". Dữ liệu ở đó có tên và có thể có số điện thoại: cân nhắc trước khi dùng.

Đổi nơi lưu thì thư mục cũ được xếp lịch gỡ quyền công khai. Xoá hẳn dự án thì **không**: bấm Thu hồi link khách, chờ nhịp hẹn giờ chạy xong rồi hãy xoá, hoặc tự gỡ chia sẻ thư mục trên Drive.

### Monitor, múi giờ (tuỳ chọn)

Mục Cloudflare của màn Monitor cần `CF_ANALYTICS_TOKEN` (token chỉ đọc Analytics của zone) và `CF_ZONE_ID`; bỏ trống thì mục đó báo chưa nối. Múi giờ `Asia/Ho_Chi_Minh`, dạng số `vi-VN` và khuôn số điện thoại Việt Nam gắn cứng trong mã và SQL: chạy ở nơi khác thì tìm các chuỗi này để đổi.

## Chỗ cần biết về an toàn

- Trình duyệt không ghi thẳng bảng nào. Mọi ghi đi qua hàm SQL `SECURITY DEFINER` tự kiểm quyền theo dự án.
- Đừng đưa khoá `service_role` vào ứng dụng: mã này không cần.
- Cổng `INTERCOM_DRIVE_GATE` mở được các hàm Drive cho vai `anon`: dùng chuỗi 32 byte ngẫu nhiên, đừng ghi ra log.
- Thành viên dự án gọi thẳng được `intercom_handover_finish` nên có thể chốt một lượt thiếu ảnh. Cần chặt hơn thì cho hàm đó đòi cổng như `intercom_project_set_storage`.
- Mọi thành viên dự án, kể cả cộng tác viên ngoài, thấy email của mọi tài khoản Drive đang nối (`intercom_drive_account_options`) và gắn được tài khoản đó vào dự án mình. Không muốn thì siết hàm này theo `intercom_is_manager()`.
- `intercom_monitor_stats` trả mã (không kèm tên) của mọi dự án cho mọi nhân viên.
- Đường R2: máy chủ gỡ EXIF. Đường Drive: ảnh đi thẳng từ trình duyệt lên Google, chỉ trình duyệt gỡ EXIF; người cố ý gọi thẳng thì ảnh có thể còn EXIF, kể cả toạ độ.
- Bản này không có giới hạn tần suất. Đặt rule ở Cloudflare cho `/api/intercom/*` và `/ic/*`.
- Nên đặt Content-Security-Policy theo tên miền Supabase, Google của bạn.

## Mục cho AI đang giúp bạn đấu nối

Dán đoạn này cho công cụ AI của bạn:

> Đọc `README.md` và mọi tệp trong `src/adapters/`, rồi `supabase/migrations/20260101000001_host_adapters.sql`, `src/app/api/intercom/monitor/_shared.ts`. Đó cùng bảng Đấu nối trong README là toàn bộ chỗ nối với hệ thống của tôi. Hỏi tôi lần lượt: (1) đăng nhập bằng gì; (2) ai là nhân viên, quản trị, lưu ở bảng nào; (3) đơn hàng nằm ở bảng nào, hay không dùng; (4) lưu ảnh ở đâu; (5) tên miền, tên hiển thị. Chỉ sửa các điểm đấu; giữ tên hàm, tham số, kiểu trả về. Không nới `GRANT`, không tắt RLS, không bỏ các lời gọi `intercom_can_access`, `intercom_can_use`, `intercom_is_manager`, `intercom_can_delete`. Khoá ảnh do máy chủ sinh, không nhận từ trình duyệt. Không ghi secret vào mã hay biến `NEXT_PUBLIC_*`. Xong mỗi điểm thì chạy `npm run type-check` và thử một lượt giao, một lượt nhận.

## Bố cục

- `src/app/intercom/*`, `src/app/ic/[token]`: trang nhân viên, trang khách theo link.
- `src/app/api/intercom/*`: tải ảnh, Drive, Monitor, Sheet.
- `src/components/intercom/*`: giao diện. `src/lib/intercom/*`: lời gọi từ trình duyệt.
- `supabase/migrations/*`: điểm đấu, bảng, hàm, dữ liệu mẫu.
