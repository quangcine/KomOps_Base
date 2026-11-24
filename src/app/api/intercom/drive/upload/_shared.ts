import { dbError } from "@/adapters/storage";
import { SAVE_FAILED, type StaffSupabase } from "../../upload/_shared";
import { DriveError } from "../_shared";

/**
 * Phần dùng chung của `drive/upload/start`, `drive/upload/finish`. Không dùng `driveErrorResponse`: hàm đó trả
 * 409, 404 cho màn quản lý. Đường tải phải trả 5xx, vì màn chụp bỏ `handover_id` và tắt Thử lại khi mã dưới 500.
 */

export const DRIVE_REVOKED_TEXT = "Drive mất quyền, nhờ quản lý nối lại.";
export const DRIVE_CALL_FAILED_TEXT = "Chưa gọi được Google Drive, thử lại giúp tôi.";

export function driveRevokedReply(): Response {
  return Response.json({ error: DRIVE_REVOKED_TEXT, reason: "drive_revoked" }, { status: 503 });
}

/** Google trả mã lỗi ở một bước. Chỉ log tên bước và mã. */
export function driveStepFailed(logTag: string, step: string, googleStatus: number, message: string = DRIVE_CALL_FAILED_TEXT): Response {
  console.error(logTag, step, "google status", googleStatus);
  return Response.json({ error: message, reason: "drive_network" }, { status: 502 });
}

/** Đổi `DriveError` sang phản hồi 5xx. Lỗi khác thì ném lại. */
export function driveUploadErrorReply(error: unknown, logTag: string): Response {
  if (!(error instanceof DriveError)) throw error;
  if (error.code === "drive_revoked") return driveRevokedReply();
  console.error(logTag, error.code);
  return Response.json({ error: DRIVE_CALL_FAILED_TEXT, reason: error.code }, { status: 502 });
}

/** Lượt đã `done`: `finish` trả lại kết quả, không đụng Drive. */
export async function driveDoneReply(supa: StaffSupabase, handoverId: string, logTag: string): Promise<Response> {
  const finish = await supa.rpc("intercom_handover_finish", {
    p_handover: handoverId,
    p_size_bytes: 1,
    p_width: null,
    p_height: null,
  });
  if (finish.error) return dbError(finish.error, "intercom_handover_finish", logTag, SAVE_FAILED);
  return Response.json({ ok: true, already_done: true, result: finish.data ?? null });
}
