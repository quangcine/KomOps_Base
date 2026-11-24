import { cookies } from "next/headers";
import { staffServerClient } from "@/adapters/authServer";
import { UUID_RE, dbError, getBucket } from "@/adapters/storage";
import { INTERCOM_PHOTO_KEY_RE, INTERCOM_THUMB_KEY_RE, readSizeParam, serveIntercomPhoto } from "../../_shared";
import { scheduleDriveQueue, serveDrivePhoto } from "../../drive/_shared";

/**
 * Nhân viên xem ảnh một lượt giao nhận intercom: `GET /api/intercom/photo/<handover_id>?size=thumb|full`. Khoá
 * đọc từ bảng `intercom_handover` bằng phiên người xem (RLS: thành viên dự án, quản lý), chỉ lượt `done`; không nhận khoá từ
 * trình duyệt. Ảnh gốc đã dọn thì xin ảnh gốc trả ảnh nhỏ.
 */
export const dynamic = "force-dynamic";

const LOG_TAG = "[intercom/photo/get]";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") {
    return Response.json({ error: "Chỉ mở ảnh từ màn intercom." }, { status: 403 });
  }
  const id = (await params).id.toLowerCase();
  const size = readSizeParam(new URL(req.url));
  if (!UUID_RE.test(id) || !size) return Response.json({ error: "Tham số không hợp lệ" }, { status: 400 });

  const supa = staffServerClient(await cookies());
  const { data: auth } = await supa.auth.getUser();
  if (!auth?.user?.id) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  const { data, error } = await supa
    .from("intercom_handover")
    .select("photo_key, thumb_key, photo_purged_at")
    .eq("id", id)
    .eq("status", "done")
    .maybeSingle();
  if (error) {
    console.error(LOG_TAG, "select intercom_handover failed", error.code, error.message);
    return Response.json({ error: "Chưa mở được ảnh, thử lại giúp tôi." }, { status: 500 });
  }
  const row = data as { photo_key?: unknown; thumb_key?: unknown; photo_purged_at?: unknown } | null;
  const useThumb = size === "thumb" || (row?.photo_purged_at !== null && row?.photo_purged_at !== undefined);
  const key = useThumb ? row?.thumb_key : row?.photo_key;
  const keyPattern = useThumb ? INTERCOM_THUMB_KEY_RE : INTERCOM_PHOTO_KEY_RE;
  if (typeof key !== "string" || !keyPattern.test(key)) {
    return Response.json({ error: "Không tìm thấy ảnh" }, { status: 404 });
  }
  // Ảnh theo mã lượt không đổi nội dung: cho trình duyệt giữ một giờ, `private` để mạng biên không giữ.
  const fromR2 = await serveIntercomPhoto(key, LOG_TAG, "private, max-age=3600");
  if (fromR2.status !== 404) return fromR2;

  const drive = await supa.rpc("intercom_handover_drive_file", { p_handover: id, p_thumb: size === "thumb" });
  if (drive.error) {
    console.error(LOG_TAG, "intercom_handover_drive_file failed", drive.error.code, drive.error.message);
    return Response.json({ error: "Chưa mở được ảnh, thử lại giúp tôi." }, { status: 502 });
  }
  const file = ((drive.data ?? []) as { account_id?: unknown; file_id?: unknown }[])[0];
  if (typeof file?.account_id !== "string" || typeof file.file_id !== "string") return fromR2;
  return serveDrivePhoto(file.account_id, file.file_id, LOG_TAG, "private, max-age=3600");
}

const DELETE_LOG_TAG = "[intercom/photo/delete]";

/**
 * Xoá một lượt: `DELETE /api/intercom/photo/<handover_id>`. Phiên đăng nhập, không `service_role`: RPC
 * `intercom_handover_delete` (DEFINER) tự kiểm `intercom_can_delete()` và quyền vào dự án, trả hai khoá ảnh. Cửa nguồn như `POST`:
 * `sec-fetch-site === "same-origin"` và `Origin` khớp gốc.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const origin = req.headers.get("origin");
  if (req.headers.get("sec-fetch-site") !== "same-origin" || !origin || origin !== new URL(req.url).origin) {
    return Response.json({ error: "Chỉ xoá lượt từ màn intercom." }, { status: 403 });
  }
  const id = (await params).id.toLowerCase();
  if (!UUID_RE.test(id)) return Response.json({ error: "Tham số không hợp lệ" }, { status: 400 });

  const supa = staffServerClient(await cookies());
  const { data: auth } = await supa.auth.getUser();
  if (!auth?.user?.id) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  const { data, error } = await supa.rpc("intercom_handover_delete", { p_handover: id });
  if (error) return dbError(error, "intercom_handover_delete", DELETE_LOG_TAG, "Chưa xoá được lượt, thử lại giúp tôi.");
  scheduleDriveQueue(DELETE_LOG_TAG);

  const removed = (data ?? null) as { photo_key?: unknown; thumb_key?: unknown } | null;
  const keys = [removed?.photo_key, removed?.thumb_key].filter(
    (k): k is string => typeof k === "string" && (INTERCOM_PHOTO_KEY_RE.test(k) || INTERCOM_THUMB_KEY_RE.test(k)),
  );
  if (keys.length > 0) {
    try {
      await getBucket(DELETE_LOG_TAG).delete(keys);
    } catch (e) {
      console.error(DELETE_LOG_TAG, "orphan R2 keys", keys.join(","), e instanceof Error ? e.message : e);
    }
  }
  return Response.json({ ok: true });
}
