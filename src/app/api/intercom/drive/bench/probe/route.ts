import { optionalUuid, readJsonObject, rejectForeignOrigin, requireStaff } from "../../../upload/_shared";
import { DRIVE_FILES_URL, DRIVE_FILE_ID_PATTERN, driveErrorResponse, fetchDrive, readJsonBody, requirePilotManager } from "../../_shared";

/**
 * Màn đo: `POST { project_id, file_id }`, Worker gọi `files.get` rồi trả mã trạng thái, cỡ, `md5Checksum` để
 * biết ảnh có bị ghi đè không. Gác như `drive/bench/session`. Token không ra máy.
 */
export const dynamic = "force-dynamic";

const LOG_TAG = "[intercom/drive/bench/probe]";

export async function POST(req: Request): Promise<Response> {
  const blocked = rejectForeignOrigin(req);
  if (blocked) return blocked;
  const staff = await requireStaff();
  if (staff instanceof Response) return staff;

  const body = await readJsonObject(req);
  const projectId = optionalUuid(body?.project_id);
  const fileId = body?.file_id;
  if (!projectId || typeof fileId !== "string" || !DRIVE_FILE_ID_PATTERN.test(fileId)) {
    return Response.json({ error: "Tham số không hợp lệ" }, { status: 400 });
  }

  const storage = await requirePilotManager(staff.supa, projectId, LOG_TAG);
  if (storage instanceof Response) return storage;
  if (!storage.account_id) return Response.json({ error: "Dự án chưa chọn tài khoản Drive." }, { status: 409 });

  try {
    const res = await fetchDrive(storage.account_id, `${DRIVE_FILES_URL}/${fileId}?fields=size,md5Checksum,trashed`);
    const file = res.ok ? await readJsonBody(res) : {};
    return Response.json(
      {
        ok: true,
        google_status: res.status,
        size: typeof file.size === "string" ? Number(file.size) : null,
        md5: typeof file.md5Checksum === "string" ? file.md5Checksum : null,
        in_trash: file["trashed"] === true,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return driveErrorResponse(error, LOG_TAG);
  }
}
