import { MAX_BYTES, intInRange, optionalUuid, readJsonObject, rejectForeignOrigin, requireStaff } from "../../../upload/_shared";
import {
  DRIVE_FILES_URL,
  DRIVE_FILE_ID_PATTERN,
  DRIVE_FOLDER_MIME,
  DRIVE_UPLOAD_URL,
  createDriveFolder,
  driveErrorResponse,
  fetchDrive,
  readJsonBody,
  requirePilotManager,
} from "../../_shared";

/**
 * Màn đo `/intercom/drive-bench`: `POST { project_id, bytes, file_id?, omit_origin? }`. Không có `file_id` thì
 * xin mã bằng `generateIds`; có thì tạo phiên lại trên mã đó. Tệp nằm trong thư mục `_bench`, không tạo lượt.
 * Trả địa chỉ phiên cho máy `PUT`: ai có địa chỉ là ghi được tệp, nên không log, `no-store`. Token không ra máy.
 * Lỗi Google trả kèm `google_status`, `step`, vì mã trạng thái chính là thứ cần đo.
 */
export const dynamic = "force-dynamic";

const LOG_TAG = "[intercom/drive/bench/session]";
const BENCH_FOLDER_NAME = "_bench";
const NO_STORE = { "cache-control": "no-store" };

const benchFolderCache = new Map<string, string>();

function googleFailure(step: string, googleStatus: number): Response {
  return Response.json(
    { error: "Google từ chối bước này.", step, google_status: googleStatus },
    { status: 502, headers: NO_STORE },
  );
}

/** Tìm hoặc tạo thư mục `_bench` trong thư mục dự án. `drive.file` chỉ thấy thư mục do app tạo, đủ dùng. */
async function resolveBenchFolder(accountId: string, parentId: string): Promise<{ folderId: string | null; status: number }> {
  const cached = benchFolderCache.get(parentId);
  if (cached) return { folderId: cached, status: 200 };
  if (!DRIVE_FILE_ID_PATTERN.test(parentId)) return { folderId: null, status: 400 };
  const query = new URLSearchParams({
    q: `name = '${BENCH_FOLDER_NAME}' and '${parentId}' in parents and mimeType = '${DRIVE_FOLDER_MIME}' and trashed = false`,
    fields: "files(id)",
    pageSize: "1",
  });
  const listed = await fetchDrive(accountId, `${DRIVE_FILES_URL}?${query.toString()}`);
  if (!listed.ok) return { folderId: null, status: listed.status };
  const files = (await readJsonBody(listed)).files;
  const found = Array.isArray(files) ? (files[0] as { id?: unknown } | undefined)?.id : undefined;
  const result =
    typeof found === "string"
      ? { folderId: found, status: 200 }
      : await createDriveFolder(accountId, BENCH_FOLDER_NAME, parentId);
  if (result.folderId) benchFolderCache.set(parentId, result.folderId);
  return result;
}

export async function POST(req: Request): Promise<Response> {
  const blocked = rejectForeignOrigin(req);
  if (blocked) return blocked;
  const staff = await requireStaff();
  if (staff instanceof Response) return staff;

  const body = await readJsonObject(req);
  const projectId = optionalUuid(body?.project_id);
  const bytes = intInRange(body?.bytes, 1, MAX_BYTES);
  const requestedId = body?.file_id ?? null;
  if (
    !projectId ||
    !bytes ||
    (requestedId !== null && (typeof requestedId !== "string" || !DRIVE_FILE_ID_PATTERN.test(requestedId)))
  ) {
    return Response.json({ error: "Tham số không hợp lệ" }, { status: 400 });
  }

  const storage = await requirePilotManager(staff.supa, projectId, LOG_TAG);
  if (storage instanceof Response) return storage;
  const { account_id: accountId, folder_id: parentId } = storage;
  if (!accountId || !parentId) {
    return Response.json({ error: "Dự án chưa chọn tài khoản Drive." }, { status: 409 });
  }

  try {
    const folder = await resolveBenchFolder(accountId, parentId);
    if (!folder.folderId) return googleFailure("bench_folder", folder.status);

    let fileId = requestedId as string | null;
    if (!fileId) {
      const idsReply = await fetchDrive(accountId, `${DRIVE_FILES_URL}/generateIds?count=1&space=drive`);
      if (!idsReply.ok) return googleFailure("generate_ids", idsReply.status);
      const ids = (await readJsonBody(idsReply)).ids;
      fileId = Array.isArray(ids) && typeof ids[0] === "string" ? ids[0] : null;
      if (!fileId) return googleFailure("generate_ids", idsReply.status);
    }

    const headers = new Headers({
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-type": "image/jpeg",
      "x-upload-content-length": String(bytes),
    });
    // `Origin` quyết định Google có mở CORS cho địa chỉ phiên hay không; `rejectForeignOrigin` đã kiểm giá trị này.
    if (body?.omit_origin !== true) headers.set("origin", req.headers.get("origin") ?? "");
    const session = await fetchDrive(accountId, `${DRIVE_UPLOAD_URL}?uploadType=resumable`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: fileId,
        parents: [folder.folderId],
        name: `bench_${fileId}.jpg`,
        mimeType: "image/jpeg",
      }),
    });
    const sessionUrl = session.ok ? session.headers.get("location") : null;
    if (!sessionUrl) return googleFailure("create_session", session.status);

    return Response.json(
      { ok: true, file_id: fileId, session_url: sessionUrl, account_id: accountId, google_status: session.status },
      { headers: NO_STORE },
    );
  } catch (error) {
    return driveErrorResponse(error, LOG_TAG);
  }
}
