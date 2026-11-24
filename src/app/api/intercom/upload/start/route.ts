import { dbError } from "@/adapters/storage";
import { INTERCOM_PHOTO_KEY_RE, INTERCOM_THUMB_KEY_RE } from "../../_shared";
import {
  MAX_BYTES,
  MAX_PARTS,
  PART_MAX_BYTES,
  SAVE_FAILED,
  TOO_LARGE,
  intInRange,
  parseHandoverMeta,
  readJsonObject,
  rejectForeignOrigin,
  requireStaff,
} from "../_shared";

/**
 * Bước 1 của tải chia mẩu: `POST` JSON gồm meta như route `intercom/photo` (`handover_id`, `project_id`, `kind`,
 * `unit_ids` hoặc `issue_ids`, `person_id` hoặc `department` cộng `group_no`, `source`, `taken_at`, `work_date`
 * tuỳ chọn) cộng `parts`, `thumb_parts`, `photo_size`, `thumb_size`. Gọi `intercom_handover_begin` (cùng
 * `handover_id` gọi lại an toàn: lượt `pending` của chính người gọi được ghi đè, lượt `done` trả kết quả cũ kèm
 * `already_done`). Trả `photo_key`, `thumb_key`.
 */
export const dynamic = "force-dynamic";

const LOG_TAG = "[intercom/upload/start]";

export async function POST(req: Request): Promise<Response> {
  const blocked = rejectForeignOrigin(req);
  if (blocked) return blocked;
  const staff = await requireStaff();
  if (staff instanceof Response) return staff;
  const { supa } = staff;

  const body = await readJsonObject(req);
  if (!body) return Response.json({ error: "Tham số không hợp lệ" }, { status: 400 });
  const meta = parseHandoverMeta(body);
  const parts = intInRange(body.parts, 1, MAX_PARTS);
  const thumbParts = body.thumb_parts === undefined ? 1 : intInRange(body.thumb_parts, 1, MAX_PARTS);
  const photoSize = intInRange(body.photo_size, 1, Number.MAX_SAFE_INTEGER);
  const thumbSize = intInRange(body.thumb_size, 1, Number.MAX_SAFE_INTEGER);
  if (!meta || !parts || !thumbParts || !photoSize || !thumbSize) {
    return Response.json({ error: "Tham số không hợp lệ" }, { status: 400 });
  }
  if (photoSize > MAX_BYTES || thumbSize > MAX_BYTES) return Response.json({ error: TOO_LARGE }, { status: 413 });
  if (photoSize > parts * PART_MAX_BYTES || thumbSize > thumbParts * PART_MAX_BYTES) {
    return Response.json({ error: "Số mẩu không khớp cỡ ảnh." }, { status: 400 });
  }

  const begin = await supa.rpc("intercom_handover_begin", {
    p_handover: meta.handoverId,
    p_project: meta.projectId,
    p_kind: meta.kind,
    p_unit_ids: meta.unitIds,
    p_issue_ids: meta.issueIds,
    p_person: meta.personId,
    p_department: meta.department,
    p_group: meta.groupNo,
    p_source: meta.source,
    p_taken_at: meta.takenAt,
    ...(meta.workDate ? { p_work_date: meta.workDate } : {}),
  });
  if (begin.error) return dbError(begin.error, "intercom_handover_begin", LOG_TAG, SAVE_FAILED);
  const opened = (begin.data ?? null) as {
    photo_key?: unknown;
    thumb_key?: unknown;
    already_done?: unknown;
    result?: unknown;
  } | null;
  if (opened?.already_done === true) {
    return Response.json({ ok: true, already_done: true, result: opened.result ?? null });
  }
  const photoKey = typeof opened?.photo_key === "string" ? opened.photo_key : "";
  const thumbKey = typeof opened?.thumb_key === "string" ? opened.thumb_key : "";
  if (
    !INTERCOM_PHOTO_KEY_RE.test(photoKey) ||
    !INTERCOM_THUMB_KEY_RE.test(thumbKey) ||
    !photoKey.includes(meta.handoverId)
  ) {
    console.error(LOG_TAG, "begin result", meta.handoverId, JSON.stringify(opened ?? null));
    const abort = await supa.rpc("intercom_handover_abort", { p_handover: meta.handoverId });
    if (abort.error) console.error(LOG_TAG, "intercom_handover_abort failed", meta.handoverId, abort.error.code, abort.error.message);
    return Response.json({ error: SAVE_FAILED }, { status: 502 });
  }
  return Response.json({
    ok: true,
    already_done: false,
    photo_key: photoKey,
    thumb_key: thumbKey,
    part_max_bytes: PART_MAX_BYTES,
  });
}
