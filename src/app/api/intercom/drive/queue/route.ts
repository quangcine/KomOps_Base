import { dbError } from "@/adapters/storage";
import { readJsonObject, rejectForeignOrigin, requireStaff } from "../../upload/_shared";
import { driveErrorResponse, requireDriveManager, runDriveQueue } from "../_shared";

/**
 * Chạy một lượt hàng đợi thùng rác từ màn Monitor: `POST { retry? }`, chỉ quản lý. `retry: true` đặt lại số lần
 * thử theo từng tài khoản, vì `queue_reset(null)` không đặt lại gì. Không trả mã tệp, không log.
 */
export const dynamic = "force-dynamic";

const LOG_TAG = "[intercom/drive/queue]";
const NO_STORE = { "cache-control": "no-store" };

export async function POST(req: Request): Promise<Response> {
  const blocked = rejectForeignOrigin(req);
  if (blocked) return blocked;
  const staff = await requireStaff();
  if (staff instanceof Response) return staff;
  const notManager = await requireDriveManager(staff.supa, LOG_TAG);
  if (notManager) return notManager;

  const body = await readJsonObject(req);
  if (body?.retry === true) {
    const accounts = await staff.supa.rpc("intercom_drive_account_list");
    if (accounts.error) return dbError(accounts.error, "intercom_drive_account_list", LOG_TAG, "Chưa đọc được tài khoản Google.");
    for (const account of (accounts.data ?? []) as { id: string }[]) {
      const reset = await staff.supa.rpc("intercom_drive_queue_reset", { p_account: account.id });
      if (reset.error) return dbError(reset.error, "intercom_drive_queue_reset", LOG_TAG, "Chưa đặt lại được hàng đợi.");
    }
  }

  try {
    const result = await runDriveQueue();
    return Response.json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (error) {
    return driveErrorResponse(error, LOG_TAG);
  }
}
