import { dbError } from "@/adapters/storage";
import { optionalUuid, readJsonObject, rejectForeignOrigin, requireStaff } from "../../upload/_shared";
import { attachDriveToProject, type DriveProjectStorage } from "../_shared";

/**
 * `POST { project_id, account_id }`: thành viên dự án chọn tài khoản cho dự án. Gác: vào được dự án
 * (`intercom_project_storage` chỉ trả dòng qua `intercom_can_access`), tài khoản `active` trong
 * `intercom_drive_account_options`. Đây là chỗ duy nhất tin `account_id` từ máy.
 * Có lượt rồi thì `set_storage` từ chối.
 */
export const dynamic = "force-dynamic";

const LOG_TAG = "[intercom/drive/folder]";

export async function POST(req: Request): Promise<Response> {
  const blocked = rejectForeignOrigin(req);
  if (blocked) return blocked;
  const staff = await requireStaff();
  if (staff instanceof Response) return staff;
  const { supa } = staff;

  const body = await readJsonObject(req);
  const projectId = optionalUuid(body?.project_id);
  const accountId = optionalUuid(body?.account_id);
  if (!projectId || !accountId) return Response.json({ error: "Tham số không hợp lệ" }, { status: 400 });

  // Hàm token mở `anon` qua cổng nên Worker là cửa: kiểm quyền dự án trước khi lấy token.
  const read = await supa.rpc("intercom_project_storage", { p_project: projectId });
  if (read.error) return dbError(read.error, "intercom_project_storage", LOG_TAG, "Chưa đọc được nơi lưu.");
  const storage = ((read.data ?? []) as DriveProjectStorage[])[0];
  if (!storage) return Response.json({ error: "Không tìm thấy dự án." }, { status: 404 });
  const accounts = await supa.rpc("intercom_drive_account_options");
  if (accounts.error) return dbError(accounts.error, "intercom_drive_account_options", LOG_TAG, "Chưa đọc được tài khoản.");
  if (!((accounts.data ?? []) as { id: string }[]).some((row) => row.id === accountId)) {
    return Response.json({ error: "Tài khoản Google không còn hoạt động." }, { status: 400 });
  }

  // Bấm lại cùng tài khoản: không đẻ thư mục thứ hai.
  if (storage.storage_kind === "drive" && storage.account_id === accountId && storage.folder_id) {
    return Response.json({ ok: true, folder_id: storage.folder_id });
  }

  const attached = await attachDriveToProject(supa, projectId, accountId, LOG_TAG);
  if (attached instanceof Response) return attached;
  return Response.json({ ok: true, folder_id: attached.folderId });
}
