import { UUID_RE, dbError } from "@/adapters/storage";
import { rejectForeignOrigin, requireStaff } from "../../../upload/_shared";
import { driveErrorResponse, runDrivePermissions } from "../../_shared";

/**
 * `POST /api/intercom/drive/permission/<project_id>`: sau khi bật, thu hồi link khách (hàm DB đã đặt `want`),
 * máy gọi đây để chạy ngay việc đưa quyền về `want` cho riêng dự án đó. Gác: phiên nhân viên cộng
 * `intercom_can_access`. Hàm cổng gọi bằng phiên nhân viên kèm cổng, như `people-sheet`. Dự án chưa có dòng
 * quyền (chưa từng bật link) thì không có gì để làm: `folder_share: "none"`. Lỗi thì dòng còn lệch, nhịp hẹn giờ
 * làm lại. Không log mã tệp.
 */
export const dynamic = "force-dynamic";

const LOG_TAG = "[intercom/drive/permission]";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const blocked = rejectForeignOrigin(req);
  if (blocked) return blocked;
  const projectId = (await params).id.toLowerCase();
  if (!UUID_RE.test(projectId)) return Response.json({ error: "Tham số không hợp lệ" }, { status: 400 });
  const staff = await requireStaff();
  if (staff instanceof Response) return staff;
  const access = await staff.supa.rpc("intercom_can_access", { p_project: projectId });
  if (access.error) return dbError(access.error, "intercom_can_access", LOG_TAG, "Chưa kiểm tra được quyền.");
  if (access.data !== true) return Response.json({ error: "Không có quyền với dự án này.", reason: "permission" }, { status: 403 });

  try {
    const results = await runDrivePermissions(staff.supa, projectId, LOG_TAG);
    const folder = results.filter((r) => r.purpose === "folder_share").pop();
    const folderShare = !folder ? "none" : !folder.error ? "ok" : folder.error === "cannot_share" ? "cannot_share" : "failed";
    return Response.json({ ok: true, folder_share: folderShare }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return driveErrorResponse(error, LOG_TAG);
  }
}
