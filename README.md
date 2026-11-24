# KomOps Base

**Mã nguồn bản web đời đầu của [KomOps](https://komops.app): công cụ giao nhận tai nghe bộ đàm (Intercom) tại hiện trường bằng ảnh chụp.**

Chụp lúc giao, chụp lúc thu, bảng theo dõi trực tiếp ai đang cầm mã tai nào, link chỉ xem cho khách và điều phối, lấy danh sách nhân sự từ Google Sheet, lưu ảnh trên Cloudflare R2 hoặc Google Drive.

> 🎧 **Cần đồ dùng luôn cho show tới, không muốn tốn công dựng server?** Vào thẳng **[komops.app](https://komops.app)**: có đủ app iPhone, iPad, Android và bản web, tải về là chạy. Muốn bấm thử cho biết trước thì mở **[komops.app/demo](https://komops.app/demo)**, không cần cài app hay tạo tài khoản.

## Câu chuyện đằng sau repo này

Chào anh em, mình là người trực tiếp làm vận hành doanh nghiệp.

Dự án này ra đời từ một show dùng **rất nhiều Intercom**. Sự kiện kéo dài nhiều ngày, chia nhiều ca, anh em kỹ thuật luân phiên nhau trực. Đến nửa đêm rã đồ, tai trả về dồn dập mà không nắm nổi bộ nào đã thu, bộ nào còn lọt ngoài hiện trường, hay ai đang cầm để gọi. Ảnh Timemark và Excel không theo kịp nhịp hiện trường, nên mình ngồi code luôn một tool nhỏ cho anh em trong nhà dùng.

Làm xong, mình đăng lên mạng xã hội "khoe" vui với anh em. Không ngờ nhiều người trong nghề cũng gặp đúng nỗi khổ này và hỏi xin code về dùng. Đã hứa chia sẻ thì phải làm, **và nó đã ở đây!**

## Nói rõ trước để anh em đỡ mất công

- Đây là **bản code đời đầu**, viết để giải quyết việc nội bộ. Lúc làm thì bên mình đã **có sẵn** database, hệ thống đăng nhập, danh sách nhân sự, hosting, tên miền và kho lưu ảnh, nên code cắm thẳng vào hạ tầng đó.
- Vì là **bản web** làm nhanh nên còn khá nhiều hạn chế, **thiếu một số tính năng thực chiến** và **vẫn còn lỗi vặt**.
- Mình chia sẻ đúng bản đã khoe và đã hứa, chỉ gỡ những chỗ dính hệ thống riêng và để lại **các điểm cắm** cho anh em **tự độ chế, đấu nối vào hệ thống sẵn có của công ty**.
- Repo này dành cho team **tự đấu nối và tự host** (self-host), không phải dịch vụ chạy sẵn và không kèm hỗ trợ kỹ thuật.
- **Repo này mình xin phép dừng cập nhật tại đây.** Tính năng mới và bản vá lỗi rút ra từ hiện trường mình dồn hết sang [app native KomOps](https://komops.app), vẫn được cập nhật đều.

## Team bạn cần có gì để tự dựng?

Repo này không phải dạng tải về bấm một nút là chạy ngay. Team kỹ thuật cần có sẵn, hoặc quen tay với mấy món sau:

**Môi trường và tech stack**
- Node.js 22.12 trở lên, npm, Git.
- Quen Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS 4.

**Database và phân quyền**
- Một dự án **Supabase** (bản cloud hoặc tự host), biết viết và chạy SQL migration. Postgres trơn chưa đủ: toàn bộ quyền đọc `auth.uid()` của Supabase.
- Nắm chắc **RLS**, hàm `SECURITY DEFINER` và JWT. Phân quyền nằm dưới tầng SQL, cấu hình nhầm là dễ lộ dữ liệu.
- Hệ thống đăng nhập và **danh sách nhân sự, phân quyền** sẵn có của công ty để đấu thay cho bản mẫu.
- (Tuỳ chọn) Bảng **đơn hàng** nếu muốn tạo dự án trực tiếp từ đơn.

**Hosting và tên miền**
- Tên miền riêng có HTTPS, chủ động trỏ DNS được.
- Tài khoản **Cloudflare** chạy **Workers** (qua OpenNext). Chạy nền tảng khác thì tự sửa phần đọc biến môi trường và phần lưu ảnh.
- Quen quy trình build, deploy, đọc log và rollback khi có sự cố.

**Lưu trữ ảnh**
- Một bucket **Cloudflare R2** private, hoặc storage tương đương.
- Muốn lưu thẳng vào Google Drive thì thêm: dự án **Google Cloud**, OAuth client, màn hình đồng ý (consent screen) của Google, 5 biến cấu hình và 1 cron job dọn hàng đợi.
- Một file Google Sheet mẫu nếu muốn khách hoặc điều phối tự điền danh sách người nhận tai.

**Vận hành lâu dài**
- Quản lý secret và biến môi trường tách biệt cho từng môi trường.
- Tự cấu hình rate limit và Content-Security-Policy cho tên miền riêng.
- Chủ động backup database, dọn ảnh cũ, theo dõi dung lượng và chi phí hạ tầng hàng tháng.
- Và một ít thời gian để tự vá bug, vì đây là bản đầu.

Có sẵn một **AI coding agent** thì phần code đỡ được rất nhiều (mình có để sẵn prompt ở cuối file), nhưng tài khoản, hạ tầng và trách nhiệm dữ liệu vẫn là của bạn.

Đọc hết danh sách trên mà team bạn thấy "nhẹ hều, chuyện nhỏ" thì kéo repo về chiến thôi!

## Nên tự dựng hay dùng bản có sẵn?

| Tiêu chí | **Repo này (tự dựng)** | **[KomOps](https://komops.app) (dùng ngay)** |
|---|---|---|
| Phù hợp với | Công ty **đã có sẵn** DB, auth, hạ tầng và dev in-house | Ekip, tổ kỹ thuật, đơn vị chạy show **chưa có gì**, cần chạy ngay |
| Bắt đầu | Clone code, đấu nối hệ thống, tự deploy | Tải app, đăng nhập, tạo dự án là giao tai được luôn |
| Nền tảng | Web | App **native** iPhone, iPad, Android kèm web quản lý |
| Hiện trường sóng yếu, hầm tối | Cần có mạng | Có **hàng chờ offline**, có sóng tự đẩy dữ liệu lên |
| Theo dõi pin | Chỉ khai giờ pin theo Model | Đếm pin ước lượng, nhắc thay, bấm "Thay pin" để đếm lại |
| Đổi tai, báo mất | Chưa có | Đổi tai, Báo mất, Tìm thấy, giữ nguyên lịch sử |
| Thao tác nhầm | Chưa có | Hoàn tác (Undo) trong 5 phút |
| Phân quyền | Tự đấu vào hệ thống phân quyền của bạn | Chia sẵn vai: Kỹ thuật, Leader, Quản lý, Khách xem |
| Cập nhật | **Không cập nhật nữa**, bạn tự maintain | **Cập nhật đều**: thêm tính năng mới, vá lỗi thực chiến |

**Đã có sẵn hệ thống và đội dev?** Cứ clone về, đấu nối vào hệ thống nội bộ rồi phát triển thêm theo quy trình riêng của bên bạn.

**Bắt đầu từ con số 0?** Khuyên thật là anh em nên cân nhắc bản dựng sẵn. Cộng đủ chi phí hạ tầng, công dev và thời gian bảo trì ở trên lại, tự dựng thường tốn kém hơn nhiều.

## Về KomOps bản native

Từ chính nền tảng code này, mình viết lại thành app native để xử lý triệt để những ca khó ở hiện trường mà bản web chịu thua: chụp ảnh mượt bằng camera trong app, hàng chờ offline khi xuống hầm mất sóng, nhắc thay pin, đổi tai, báo mất, hoàn tác khi bấm nhầm, quản lý nhiều show trên một màn hình, và ảnh đẩy thẳng vào **Google Drive của chính bạn**.

Chi phí cực kỳ khiêm tốn: **chỉ từ 2 Credit mỗi ngày.** Một show 20 tai hết 40 Credit một ngày, chưa bằng một ly cà phê. Mình không đặt nặng chuyện lợi nhuận, may mắn thì đủ duy trì tiền server và hạ tầng cho anh em có đồ tốt dùng lâu dài.

- 🌐 Trang chủ, bảng giá, link tải app: **[komops.app](https://komops.app)**
- 🖱️ Dùng thử không cần cài: **[komops.app/demo](https://komops.app/demo)**

Nếu repo này giúp ích cho công việc của bạn, cách ủng hộ dễ nhất là thử chạy KomOps cho show sắp tới, rồi nhắn mình biết anh em ngoài hiện trường còn cần thêm tính năng gì.

---

Từ đây trở xuống là tài liệu kỹ thuật dành cho anh em dev tự dựng.

## Tech stack

Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS 4; Supabase (Postgres, Auth); Cloudflare Workers qua OpenNext; lưu ảnh trên Cloudflare R2 hoặc Google Drive.

## Giấy phép (License)

[Elastic License 2.0](LICENSE), bên cấp phép `quangcine`. Nói ngắn gọn: bạn được dùng nội bộ, chỉnh sửa và đấu nối vào hệ thống của mình; **không** được đem đi kinh doanh dưới dạng dịch vụ online (SaaS) cho bên thứ ba; giữ nguyên thông báo bản quyền. Văn bản pháp lý có hiệu lực nằm trong file `LICENSE`.

## Chạy thử dưới local

1. Cài dependencies: `npm ci`
2. Chạy lần lượt các file trong `supabase/migrations/` trên một database trống: copy dán vào SQL Editor theo đúng thứ tự tên file, hoặc dùng Supabase CLI (repo không kèm `config.toml`): `supabase init`, `supabase link --project-ref <mã dự án>`, rồi chạy `supabase db push`.
3. Copy `.env.example` thành `.env.local` và điền 2 biến của Supabase.
4. Tắt tính năng tự đăng ký trên Supabase (Authentication > Sign In / Providers), tạo thủ công một tài khoản email, mật khẩu, rồi cấp quyền admin cho tài khoản đó:

   ```sql
   insert into public.profiles (id, full_name, email, is_staff, is_admin)
   values ('<id trong auth.users>', 'Tên của bạn', 'ban@example.com', true, true);
   ```

5. Chạy `npm run dev` và mở `http://localhost:3000`. Chế độ này chưa có R2: xem giao diện, sửa dữ liệu bình thường, nhưng lưu và xem ảnh sẽ báo lỗi.
   Muốn test luôn phần ảnh thì sửa `wrangler.jsonc` rồi chạy `npm run preview` (giả lập R2 dưới local, cổng 8787). Trước đó đặt `NEXT_PUBLIC_APP_ORIGIN=http://localhost:8787` trong `.env.local`: biến này nhúng lúc build, để cổng 3000 thì link gửi khách và bước kết nối Drive sẽ lệch.
6. Kiểm tra type: `npm run type-check`.

**Khi deploy production:** đặt `NEXT_PUBLIC_APP_ORIGIN` thành tên miền `https` thật của bạn trước khi build, sau đó chạy `npm run deploy`.

## Các điểm cần đấu nối

| Điểm đấu nối | File liên quan | Bản mẫu đang làm gì | Bạn cần thay gì |
|---|---|---|---|
| Đăng nhập (Auth) | `src/adapters/auth.ts`, `authServer.ts`, `SessionGate.tsx` | Supabase Auth, email và mật khẩu | Auth provider của bạn. Session phải ra JWT mà Supabase hiểu được, vì mọi hàm SQL đọc `auth.uid()` |
| Phân quyền | `20260101000001_host_adapters.sql`: `is_staff()`, `is_admin()`, `is_active_staff()`, `is_active_profile()` | Đọc cờ trên bảng `profiles`; có `deleted_at` là cắt toàn bộ quyền | Viết lại thân hàm để đọc từ bảng phân quyền của bạn. Giữ nguyên tên hàm và kiểu trả về |
| Nhân sự | bảng `profiles` | Bảng độc lập | Bảng hoặc view có cùng tên cột. Cộng tác viên ngoài cần `is_collaborator` mới thêm được vào dự án. Dùng view thì bỏ các khoá ngoại trỏ tới `profiles` ở file migration số 02 |
| Quản lý, quyền xoá | bảng `intercom_manager`, `intercom_deleter` | Để trống, mặc định chỉ admin có quyền | Insert thêm `profile_id` bằng SQL |
| Đơn hàng | Cùng file SQL trên, mục 5; `src/adapters/orders.ts` | Trả về rỗng: màn chọn đơn hiện trống | Viết lại thân hai hàm `_intercom_order_*_json`; cấu trúc JSON ghi ngay trên đầu hàm |
| Lưu ảnh | `src/adapters/storage.ts`, `src/app/api/intercom/monitor/_shared.ts` | Cloudflare R2 qua binding `MEDIA_BUCKET` | Storage khác có đủ bốn thao tác `put`, `get`, `delete`, `list` |
| Google Drive | `.dev.vars.example`, `src/app/api/intercom/drive/` | Tự tắt cho tới khi điền đủ biến | Xem hướng dẫn bên dưới |
| Thương hiệu (tên, domain, logo) | `.env.example`, `src/adapters/brand.ts`, `src/components/ui/WorkLogo.tsx`, `public/og-default.png` | Dùng tên trung tính | Thay bằng bộ nhận diện của bên bạn |

### Tích hợp Google Drive (tuỳ chọn)

1. Tạo một OAuth client loại Web trên Google Cloud, scope `drive.file`, Redirect URI là `https://<tên miền>/api/intercom/drive/callback`.
2. Cấu hình 5 biến đầu tiên của `.dev.vars.example` (chuỗi ngẫu nhiên tạo bằng `openssl rand -hex 32`). Cổng ngắn hơn 32 ký tự bị từ chối.
3. Hash giá trị `INTERCOM_DRIVE_GATE` rồi nạp vào database. Biến phải có trong phiên shell đang gõ (chỉ ghi trong `.dev.vars` là chưa đủ); thiếu thì lệnh dưới báo lỗi để tránh hash nhầm chuỗi rỗng.

   Chạy **từng lệnh một**, đừng dán cả khối, vì `read` sẽ dừng chờ bạn nhập giá trị:

   ```sh
   read -rs INTERCOM_DRIVE_GATE
   ```

   Dán đúng chuỗi đã đặt, nhấn Enter, rồi mới chạy:

   ```sh
   printf %s "${INTERCOM_DRIVE_GATE:?chua dat INTERCOM_DRIVE_GATE}" | shasum -a 256
   ```

   Copy chuỗi 64 ký tự hex vừa in ra, nạp vào database:

   ```sql
   insert into public.intercom_drive_gate (gate_hash) values ('<64 ký tự hex>');
   ```

4. Sửa rồi chạy `supabase/optional_drive_cron.sql` để có cron job dọn hàng đợi.
5. Màn đo hiệu năng `/intercom/drive-bench?project=<mã dự án>` chỉ mở cho quản lý, và dự án phải có trong bảng thử: `insert into public.intercom_drive_pilot (project_id) values ('<mã dự án>');`

**Lưu ý quyền chia sẻ trên Drive:** bật link cho khách ở dự án dùng Drive thì thư mục ảnh mở quyền *"ai có link đều xem"*. Google Sheet mẫu cho danh sách người nhận mở quyền *"ai có link đều sửa"*. Dữ liệu ở đó có họ tên và có thể có số điện thoại, anh em cân nhắc trước khi bật.

Đổi nơi lưu thì thư mục cũ được xếp lịch thu hồi quyền công khai. Nhưng **xoá hẳn dự án** thì **không** tự thu hồi: bấm *Thu hồi link khách*, đợi cron job chạy xong rồi mới xoá, hoặc tự vào Drive gỡ chia sẻ.

### Monitor và múi giờ (tuỳ chọn)

Mục Cloudflare trong màn Monitor cần `CF_ANALYTICS_TOKEN` (token chỉ đọc Analytics của zone) và `CF_ZONE_ID`; bỏ trống thì báo chưa kết nối. Múi giờ `Asia/Ho_Chi_Minh`, dạng số `vi-VN` và khuôn số điện thoại Việt Nam đang hardcode trong cả code lẫn SQL: triển khai chỗ khác thì tìm các chuỗi này để sửa.

## Lưu ý về bảo mật

- Trình duyệt không ghi thẳng bảng nào. Mọi thao tác ghi đi qua hàm SQL `SECURITY DEFINER` tự kiểm quyền theo từng dự án.
- Tuyệt đối không đưa khoá `service_role` vào ứng dụng: codebase này không cần tới nó.
- `INTERCOM_DRIVE_GATE` mở được các hàm Drive cho role `anon`: dùng chuỗi 32 byte ngẫu nhiên, đừng ghi ra log.
- Thành viên dự án gọi thẳng được `intercom_handover_finish` nên về lý thuyết có thể chốt một lượt thiếu ảnh. Cần siết thì bắt hàm này kiểm cổng giống `intercom_project_set_storage`.
- Mọi thành viên dự án (kể cả cộng tác viên ngoài) thấy email của các tài khoản Drive đang kết nối (`intercom_drive_account_options`) và gán được tài khoản đó vào dự án của mình. Không muốn lộ thì siết hàm theo `intercom_is_manager()`.
- `intercom_monitor_stats` trả mã dự án (không kèm tên) của toàn hệ thống cho mọi nhân viên.
- **Xoá EXIF:** đường R2 thì server tự gỡ. Đường Drive thì ảnh đi thẳng từ trình duyệt lên Google, chỉ gỡ ở phía client; ai cố tình gọi API trực tiếp thì ảnh có thể còn EXIF, kể cả toạ độ GPS.
- Bản này chưa có rate limit. Tạo rule trên Cloudflare cho `/api/intercom/*` và `/ic/*`.
- Nên cấu hình Content-Security-Policy khớp tên miền Supabase và Google bạn dùng.

## Prompt cho AI hỗ trợ đấu nối

Dùng AI coding assistant để tích hợp thì dán nguyên đoạn này vào:

> Đọc `README.md`, toàn bộ file trong `src/adapters/`, cùng `supabase/migrations/20260101000001_host_adapters.sql` và `src/app/api/intercom/monitor/_shared.ts`. Những file đó cùng bảng "Các điểm cần đấu nối" trong README là toàn bộ điểm tích hợp với hệ thống của tôi. Hãy hỏi tôi lần lượt: (1) đăng nhập bằng hệ thống nào; (2) nhân viên và admin nằm ở bảng nào; (3) bảng đơn hàng ở đâu, hoặc bỏ qua nếu không dùng; (4) lưu ảnh ở đâu; (5) tên miền và tên hiển thị. Chỉ sửa đúng các điểm đấu nối; giữ nguyên tên hàm, tham số và kiểu trả về. Không nới `GRANT`, không tắt RLS, không bỏ các lời gọi kiểm quyền `intercom_can_access`, `intercom_can_use`, `intercom_is_manager`, `intercom_can_delete`. Key của ảnh do server sinh ra, không nhận từ trình duyệt. Không ghi secret vào mã hay biến `NEXT_PUBLIC_*`. Xong mỗi điểm, chạy `npm run type-check` và thử lại một lượt giao, một lượt nhận.

## Cấu trúc thư mục

- `src/app/intercom/*`, `src/app/ic/[token]`: trang cho nhân viên và trang link chỉ xem cho khách.
- `src/app/api/intercom/*`: API tải ảnh, Google Drive, Monitor, Google Sheet.
- `src/components/intercom/*`: component giao diện. `src/lib/intercom/*`: hàm gọi từ phía trình duyệt.
- `src/adapters/*`: điểm cắm đăng nhập, đơn hàng, lưu ảnh, nhận diện.
- `supabase/migrations/*`: điểm cắm SQL, bảng, hàm và dữ liệu mẫu.
