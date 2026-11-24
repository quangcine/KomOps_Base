import { cookies } from "next/headers";
import { staffServerClient } from "@/adapters/authServer";
import { dbError } from "@/adapters/storage";
import { INTERCOM_PHOTO_KEY_RE, INTERCOM_THUMB_KEY_RE } from "../../_shared";
import { readJsonObject } from "../../upload/_shared";
import { scheduleDriveQueue } from "../../drive/_shared";
import {
  INTERCOM_PREFIX,
  INTERCOM_TMP_PREFIX,
  MISSING_BUCKET_MESSAGE,
  NO_STORE_HEADERS,
  TMP_STALE_MS,
  UUID_SEGMENT_RE,
  deleteKeys,
  isSameOriginPost,
  listPrefix,
  monitorBucket,
  type MonitorBucket,
} from "../_shared";

/**
 * Dọn kho intercom từ màn Monitor: `POST /api/intercom/monitor/cleanup` thân `{ kind: "tmp" | "pending" |
 * "originals" | "project", projectId?, confirmName? }`. Phiên nhân viên, không `service_role`; cửa nguồn
 * same-origin; cửa quyền `intercom_can_delete()` (lỗi RPC coi là TỪ CHỐI).
 * - `tmp`: liệt kê `intercom/tmp/`, chỉ xoá tệp có `uploaded` cũ hơn 1 giờ; không qua DB, bỏ qua `projectId`.
 * - `pending`: `intercom_cleanup_pending`, xoá `photo_key`, `thumb_key` trả về và tiền tố
 * `intercom/tmp/<handover_id>/`.
 * - `originals`: `intercom_cleanup_originals`, xoá các `photo_key` (ảnh nhỏ giữ).
 * - `project`: `intercom_project_delete` rồi xoá tiền tố `intercom/<project_id>/`. `pending`, `project` xoá lượt
 * nên xếp thêm một lượt hàng đợi thùng rác Drive sau phản hồi; `tmp`, `originals` không sinh dòng hàng đợi.
 */
export const dynamic = "force-dynamic";

const LOG_TAG = "[intercom/monitor/cleanup]";

type CleanupKind = "tmp" | "pending" | "originals" | "project";
const KINDS: readonly CleanupKind[] = ["tmp", "pending", "originals", "project"];

type Removed = { files: number; bytes: number };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE_HEADERS });
}

/** Xoá trọn một tiền tố (mọi trang), trả số tệp, số byte đã xoá. */
async function deletePrefix(bucket: MonitorBucket, prefix: string): Promise<Removed> {
  const removed: Removed = { files: 0, bytes: 0 };
  for (;;) {
    const { objects, truncated } = await listPrefix(bucket, prefix, 1);
    if (objects.length === 0) return removed;
    await deleteKeys(
      bucket,
      objects.map((o) => o.key),
    );
    removed.files += objects.length;
    removed.bytes += objects.reduce((sum, o) => sum + (Number(o.size) || 0), 0);
    if (!truncated) return removed;
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!isSameOriginPost(req)) return json({ error: "Chỉ dọn từ màn intercom." }, 403);

  const body = (await readJsonObject(req)) as
    | { kind?: unknown; projectId?: unknown; confirmName?: unknown }
    | null;
  const kind = KINDS.find((k) => k === body?.kind);
  if (!kind) return json({ error: "Loại dọn không hợp lệ" }, 400);
  let projectId: string | null = null;
  if (body?.projectId !== undefined && body?.projectId !== null && body?.projectId !== "") {
    if (typeof body.projectId !== "string" || !UUID_SEGMENT_RE.test(body.projectId.toLowerCase())) {
      return json({ error: "Mã dự án không hợp lệ" }, 400);
    }
    projectId = body.projectId.toLowerCase();
  }
  const confirmName = typeof body?.confirmName === "string" ? body.confirmName : "";
  if (kind === "project" && (!projectId || confirmName.trim() === "")) {
    return json({ error: "Xoá dự án cần mã dự án và tên gõ lại" }, 400);
  }

  const supa = staffServerClient(await cookies());
  const { data: auth } = await supa.auth.getUser();
  if (!auth?.user?.id) return json({ error: "Chưa đăng nhập" }, 401);

  const { data: canDelete, error: gateError } = await supa.rpc("intercom_can_delete");
  if (gateError || canDelete !== true) {
    return json({ error: "Bạn không có quyền dọn intercom", reason: "permission" }, 403);
  }

  const bucket = monitorBucket();
  if (!bucket) return json({ error: MISSING_BUCKET_MESSAGE }, 500);

  try {
    if (kind === "tmp") {
      const staleBefore = Date.now() - TMP_STALE_MS;
      const { objects } = await listPrefix(bucket, INTERCOM_TMP_PREFIX);
      const stale = objects.filter((o) => new Date(o.uploaded).getTime() < staleBefore);
      await deleteKeys(
        bucket,
        stale.map((o) => o.key),
      );
      return json({
        files: stale.length,
        bytes: stale.reduce((sum, o) => sum + (Number(o.size) || 0), 0),
        rows: 0,
      });
    }

    if (kind === "pending") {
      const { data, error } = await supa.rpc("intercom_cleanup_pending", { p_project: projectId });
      if (error) return dbError(error, "intercom_cleanup_pending", LOG_TAG, "Chưa dọn được lượt treo, thử lại giúp tôi.");
      scheduleDriveQueue(LOG_TAG);
      const rows = (Array.isArray(data) ? data : []) as { handover_id?: unknown; photo_key?: unknown; thumb_key?: unknown }[];
      const keys = rows
        .flatMap((r) => [r.photo_key, r.thumb_key])
        .filter((k): k is string => typeof k === "string" && (INTERCOM_PHOTO_KEY_RE.test(k) || INTERCOM_THUMB_KEY_RE.test(k)));
      await deleteKeys(bucket, keys);
      const removed: Removed = { files: 0, bytes: 0 };
      for (const r of rows) {
        const handoverId = typeof r.handover_id === "string" ? r.handover_id.toLowerCase() : "";
        if (!UUID_SEGMENT_RE.test(handoverId)) continue;
        const parts = await deletePrefix(bucket, `${INTERCOM_TMP_PREFIX}${handoverId}/`);
        removed.files += parts.files;
        removed.bytes += parts.bytes;
      }
      return json({ ...removed, rows: rows.length });
    }

    if (kind === "originals") {
      const { data, error } = await supa.rpc("intercom_cleanup_originals", { p_project: projectId });
      if (error) return dbError(error, "intercom_cleanup_originals", LOG_TAG, "Chưa dọn được ảnh gốc, thử lại giúp tôi.");
      const rows = (Array.isArray(data) ? data : []) as { photo_key?: unknown; size_bytes?: unknown }[];
      const valid = rows.filter(
        (r): r is { photo_key: string; size_bytes?: unknown } =>
          typeof r.photo_key === "string" && INTERCOM_PHOTO_KEY_RE.test(r.photo_key),
      );
      const keys = valid.map((r) => r.photo_key);
      try {
        await deleteKeys(bucket, keys);
        // Cỡ lấy theo `size_bytes` của DB (ảnh gốc đã in dấu), không gọi `head` từng tệp.
        const bytes = valid.reduce((sum, r) => sum + (Number(r.size_bytes) || 0), 0);
        return json({ files: keys.length, bytes, rows: rows.length });
      } catch (e) {
        // DB đã đánh dấu dọn: chạy lại không trả lại các khoá này, ghi log để soát tay.
        console.error(LOG_TAG, "orphan original keys", keys.join(","), e instanceof Error ? e.message : e);
        throw e;
      }
    }

    // kind === "project"
    const { error } = await supa.rpc("intercom_project_delete", { p_project: projectId, p_confirm_name: confirmName });
    if (error && error.code !== "P0002") {
      return dbError(error, "intercom_project_delete", LOG_TAG, "Chưa xoá được dự án, thử lại giúp tôi.");
    }
    if (!error) scheduleDriveQueue(LOG_TAG);
    const removed = await deletePrefix(bucket, `${INTERCOM_PREFIX}${projectId}/`);
    return json({ ...removed, rows: error ? 0 : 1 });
  } catch (e) {
    console.error(LOG_TAG, kind, "R2 failed", e instanceof Error ? e.message : e);
    return json({ error: "Đã xử lý dữ liệu nhưng xoá tệp R2 hỏng giữa chừng, bấm Làm mới rồi chạy lại giúp tôi." }, 502);
  }
}
