import { cookies } from "next/headers";
import { staffServerClient } from "@/adapters/authServer";
import { UUID_RE, dbError, getBucket } from "@/adapters/storage";
import { INTERCOM_PHOTO_KEY_RE, INTERCOM_THUMB_KEY_RE } from "../../_shared";
import { scheduleDriveQueue } from "../../drive/_shared";

/**
 * Xoá một người nhận intercom cùng MỌI lượt giao, thu của người đó ở mọi ngày: `DELETE
 * /api/intercom/person/<person_id>`. Phiên nhân viên, không `service_role`: RPC `intercom_person_delete`
 * (DEFINER) tự kiểm `intercom_can_delete()`, xoá dây chuyền trong một giao dịch và trả khoá ảnh của mọi lượt đã
 * xoá (lượt thu chung với tai người khác thì giữ). Cửa nguồn như `DELETE /api/intercom/photo/<id>`:
 * `sec-fetch-site === "same-origin"` và `Origin` khớp gốc.
 */
export const dynamic = "force-dynamic";

const LOG_TAG = "[intercom/person/delete]";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const origin = req.headers.get("origin");
  if (req.headers.get("sec-fetch-site") !== "same-origin" || !origin || origin !== new URL(req.url).origin) {
    return Response.json({ error: "Chỉ xoá người từ màn intercom." }, { status: 403 });
  }
  const id = (await params).id.toLowerCase();
  if (!UUID_RE.test(id)) return Response.json({ error: "Tham số không hợp lệ" }, { status: 400 });

  const supa = staffServerClient(await cookies());
  const { data: auth } = await supa.auth.getUser();
  if (!auth?.user?.id) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  const { data, error } = await supa.rpc("intercom_person_delete", { p_person: id });
  if (error) return dbError(error, "intercom_person_delete", LOG_TAG, "Chưa xoá được người này, thử lại giúp tôi.");
  scheduleDriveQueue(LOG_TAG);

  const rows = (Array.isArray(data) ? data : []) as { photo_key?: unknown; thumb_key?: unknown }[];
  const keys = rows
    .flatMap((row) => [row.photo_key, row.thumb_key])
    .filter((k): k is string => typeof k === "string" && (INTERCOM_PHOTO_KEY_RE.test(k) || INTERCOM_THUMB_KEY_RE.test(k)));
  if (keys.length > 0) {
    try {
      await getBucket(LOG_TAG).delete(keys);
    } catch (e) {
      console.error(LOG_TAG, "orphan R2 keys", keys.join(","), e instanceof Error ? e.message : e);
    }
  }
  return Response.json({ ok: true, removed_photos: rows.length });
}
