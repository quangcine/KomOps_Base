import { dbError } from "@/adapters/storage";
import {
  ACCEPTED_TYPE,
  JPEG_MAGIC,
  MAX_BYTES,
  SAVE_FAILED,
  TOO_LARGE,
  optionalDimension,
  optionalUuid,
  readJsonObject,
  rejectForeignOrigin,
  requireStaff,
  type StaffSupabase,
} from "../../../upload/_shared";
import {
  DRIVE_FILES_URL,
  DRIVE_FILE_ID_PATTERN,
  DRIVE_FOLDER_MIME,
  DriveError,
  fetchDrive,
  placeDriveHandoverFiles,
  readDriveSecret,
  readJsonBody,
  type DriveProjectStorage,
} from "../../_shared";
import { driveDoneReply, driveStepFailed, driveUploadErrorReply } from "../_shared";

/**
 * Bước cuối của tải thẳng: `POST` JSON `handover_id`, `width`, `height`, `photo_size`, `thumb_size`. Cỡ `null`
 * là tệp đã bỏ qua `PUT`, không so. Đọc mã tệp qua RLS bằng phiên người gọi; kiểm thư mục, trần, loại, đầu JPEG
 * của hai tệp. Đạt thì `intercom_handover_finish`, cỡ lấy từ Drive. Không đạt thì `intercom_handover_abort`:
 * `abort` xoá dòng nên trigger tự đưa tệp vào hàng đợi. Google không trả lời được thì 5xx, không huỷ lượt, để
 * Thử lại không phải gửi lại ảnh đã lên. Chuyển lỗi thì lượt vẫn `done`, nhịp hẹn giờ chuyển lại.
 */
export const dynamic = "force-dynamic";

const LOG_TAG = "[intercom/drive/upload/finish]";

type DriveHandoverRow = {
  status: string;
  created_by: string | null;
  project_id: string;
  drive_file_id: string | null;
  drive_thumb_file_id: string | null;
  drive_account_id: string | null;
};

type DriveFileCheck = {
  fileId: string;
  /** `null`: lượt đã bỏ qua `PUT`, không so cỡ. */
  declaredSize: number | null;
};

/**
 * `unreadable`: chưa chứng minh được tệp sai, không huỷ lượt, cũng không cho đạt. `rejected`: tệp không đạt, huỷ
 * lượt.
 */
type FileVerdict =
  | { kind: "ok"; size: number; parents: unknown[] }
  | { kind: "unreadable"; reply: Response }
  | { kind: "rejected"; reply: Response };

/** Cỡ máy khai: `null` là hợp lệ (bỏ qua `PUT`); sai dạng thì `undefined`. */
function readDeclaredSize(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Tệp nằm trong thư mục tạm, ngay trong thư mục dự án hoặc trong một thư mục con của nó. Không tra theo tên:
 * cache từng isolate có thể ra mã khác thư mục `start` đã đặt tệp, tệp bị từ chối, huỷ oan lượt đã lên. Không
 * chặn ảnh nén, ảnh nhỏ nằm lẫn chỗ nhau: `parents` do Worker đặt, máy không khai được. Trả `null` khi đạt.
 */
async function checkFilePlacement(
  accountId: string,
  folderId: string | null,
  stagingFolderId: string | null,
  parents: unknown,
  fileStatus: number,
): Promise<FileVerdict | null> {
  const outside = (): FileVerdict => ({
    kind: "rejected",
    reply: Response.json({ error: "Ảnh không nằm đúng thư mục dự án, tải lại trang rồi gửi lại." }, { status: 409 }),
  });
  const unknownPlacement = (step: string, status: number): FileVerdict => ({ kind: "unreadable", reply: driveStepFailed(LOG_TAG, step, status) });
  if (!folderId) return outside();
  if (!Array.isArray(parents) || parents.length === 0) return unknownPlacement("files.get no parents", fileStatus);
  if (parents.includes(folderId) || (stagingFolderId && parents.includes(stagingFolderId))) return null;
  const parentId: unknown = parents[0];
  if (typeof parentId !== "string" || !DRIVE_FILE_ID_PATTERN.test(parentId)) return unknownPlacement("files.get bad parent id", fileStatus);

  const parentReply = await fetchDrive(accountId, `${DRIVE_FILES_URL}/${parentId}?fields=parents,mimeType`);
  if (!parentReply.ok) return unknownPlacement("files.get parent", parentReply.status);
  const parent = await readJsonBody(parentReply);
  // Mã 200 mà `mimeType` đã xin thiếu, rỗng là thân hỏng, chưa biết tệp sai hay không.
  if (typeof parent.mimeType !== "string" || parent.mimeType === "") return unknownPlacement("files.get parent", parentReply.status);
  if (parent.mimeType !== DRIVE_FOLDER_MIME) return outside();
  if (!Array.isArray(parent.parents) || parent.parents.length === 0) return unknownPlacement("files.get parent no parents", parentReply.status);
  return parent.parents.includes(folderId) ? null : outside();
}

async function checkDriveFile(
  accountId: string,
  folderId: string | null,
  stagingFolderId: string | null,
  check: DriveFileCheck,
): Promise<FileVerdict> {
  const metaReply = await fetchDrive(accountId, `${DRIVE_FILES_URL}/${check.fileId}?fields=size,mimeType,parents`);
  if (!metaReply.ok) return { kind: "unreadable", reply: driveStepFailed(LOG_TAG, "files.get", metaReply.status) };
  const meta = await readJsonBody(metaReply);
  const size = Number(meta.size);
  const saveFailed = () => Response.json({ error: SAVE_FAILED }, { status: 502 });
  const rejectFormat = () => Response.json({ error: "Chỉ nhận ảnh JPEG." }, { status: 415 });

  const placement = await checkFilePlacement(accountId, folderId, stagingFolderId, meta.parents, metaReply.status);
  if (placement) return placement;
  if (!Number.isInteger(size) || size <= 0) return { kind: "rejected", reply: saveFailed() };
  if (size > MAX_BYTES) return { kind: "rejected", reply: Response.json({ error: TOO_LARGE }, { status: 413 }) };
  if (meta.mimeType !== ACCEPTED_TYPE) return { kind: "rejected", reply: rejectFormat() };
  if (check.declaredSize !== null && check.declaredSize !== size) return { kind: "rejected", reply: saveFailed() };

  // Đọc riêng vì cần header `Range`. Google bỏ qua `Range` thì thân tối đa `MAX_BYTES`, đã kiểm ở trên.
  const head = await fetchDrive(accountId, `${DRIVE_FILES_URL}/${check.fileId}?alt=media`, { headers: { range: "bytes=0-2" } });
  if (head.status !== 200 && head.status !== 206) {
    return { kind: "unreadable", reply: driveStepFailed(LOG_TAG, "read head", head.status) };
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await head.arrayBuffer());
  } catch {
    throw new DriveError("drive_network");
  }
  if (bytes.byteLength < JPEG_MAGIC.length || JPEG_MAGIC.some((b, i) => bytes[i] !== b)) {
    return { kind: "rejected", reply: rejectFormat() };
  }
  return { kind: "ok", size, parents: Array.isArray(meta.parents) ? meta.parents : [] };
}

/**
 * Huỷ lượt `pending`; hàm tự bỏ qua lượt đã `done` hay của người khác. Lỗi chỉ ghi log, chỗ gọi vẫn trả phản hồi
 * của nó.
 */
async function abortHandover(supa: StaffSupabase, handoverId: string): Promise<void> {
  const abort = await supa.rpc("intercom_handover_abort", { p_handover: handoverId });
  if (abort.error) console.error(LOG_TAG, "intercom_handover_abort failed", handoverId, abort.error.code, abort.error.message);
}

/** Ghi kết quả chuyển vào thư mục dự án bằng hàm cổng. Lỗi chỉ ghi log: lượt đã `done`, nhịp hẹn giờ chuyển lại. */
async function markPlaced(supa: StaffSupabase, handoverId: string, failure: string | null): Promise<void> {
  try {
    const gate = readDriveSecret("INTERCOM_DRIVE_GATE");
    const saved = failure
      ? await supa.rpc("intercom_drive_place_fail", { p_gate: gate, p_handover: handoverId, p_error: failure })
      : await supa.rpc("intercom_drive_place_done", { p_gate: gate, p_handover: handoverId });
    if (failure) console.error(LOG_TAG, "place files failed", failure);
    if (saved.error) console.error(LOG_TAG, "place mark failed", saved.error.code);
  } catch (error) {
    if (!(error instanceof DriveError)) throw error;
    console.error(LOG_TAG, "place mark failed", error.code);
  }
}

export async function POST(req: Request): Promise<Response> {
  const blocked = rejectForeignOrigin(req);
  if (blocked) return blocked;
  const staff = await requireStaff();
  if (staff instanceof Response) return staff;
  const { supa, userId } = staff;

  const body = await readJsonObject(req);
  const handoverId = body ? optionalUuid(body.handover_id) : null;
  const width = body ? optionalDimension(body.width) : undefined;
  const height = body ? optionalDimension(body.height) : undefined;
  const photoSize = body ? readDeclaredSize(body.photo_size) : undefined;
  const thumbSize = body ? readDeclaredSize(body.thumb_size) : undefined;
  if (!handoverId || width === undefined || height === undefined || photoSize === undefined || thumbSize === undefined) {
    return Response.json({ error: "Tham số không hợp lệ" }, { status: 400 });
  }

  const read = await supa
    .from("intercom_handover")
    .select("status, created_by, project_id, drive_file_id, drive_thumb_file_id, drive_account_id")
    .eq("id", handoverId)
    .maybeSingle();
  if (read.error) return Response.json({ error: SAVE_FAILED }, { status: 502 });
  const row = read.data as DriveHandoverRow | null;
  if (!row) return Response.json({ error: "Không tìm thấy lượt chụp" }, { status: 404 });
  if (row.status === "done") return driveDoneReply(supa, handoverId, LOG_TAG);
  if (row.created_by !== userId) {
    return Response.json({ error: "Lượt chụp này của người khác", reason: "permission" }, { status: 403 });
  }
  // Chưa có mã là `start` chưa xong: 502 để Thử lại gọi `start`, không huỷ lượt.
  if (!row.drive_file_id || !row.drive_thumb_file_id || !row.drive_account_id) {
    console.error(LOG_TAG, "handover has no drive files", handoverId);
    return Response.json({ error: SAVE_FAILED }, { status: 502 });
  }

  const storageRead = await supa.rpc("intercom_project_storage", { p_project: row.project_id });
  if (storageRead.error) return dbError(storageRead.error, "intercom_project_storage", LOG_TAG, SAVE_FAILED);
  const storage = ((storageRead.data ?? []) as DriveProjectStorage[])[0];
  const folderId = storage?.storage_kind === "drive" ? storage.folder_id : null;
  // Đọc lỗi thì 502, không coi là không có: tệp ở thư mục tạm sẽ bị từ chối, huỷ oan lượt đã lên.
  const project = await supa.from("intercom_project").select("drive_staging_folder_id").eq("id", row.project_id).maybeSingle();
  if (project.error) return dbError(project.error, "read project", LOG_TAG, SAVE_FAILED);
  const stagingRaw = (project.data as { drive_staging_folder_id?: unknown } | null)?.drive_staging_folder_id;
  const stagingFolderId = folderId && typeof stagingRaw === "string" && DRIVE_FILE_ID_PATTERN.test(stagingRaw) ? stagingRaw : null;

  let sizeBytes: number;
  let fileParents: { photo: unknown[]; thumb: unknown[] };
  try {
    const accountId = row.drive_account_id;
    const [photo, thumb] = await Promise.all([
      checkDriveFile(accountId, folderId, stagingFolderId, { fileId: row.drive_file_id, declaredSize: photoSize }),
      checkDriveFile(accountId, folderId, stagingFolderId, { fileId: row.drive_thumb_file_id, declaredSize: thumbSize }),
    ]);
    // Google chưa trả lời được thì chưa biết tệp hỏng hay không: xét trước, để khỏi huỷ oan.
    const verdicts = [photo, thumb];
    const unreadable = verdicts.find((v) => v.kind === "unreadable");
    if (unreadable && unreadable.kind === "unreadable") return unreadable.reply;
    const rejected = verdicts.find((v) => v.kind === "rejected");
    if (rejected && rejected.kind === "rejected") {
      console.error(LOG_TAG, "file check failed, abort", handoverId, rejected.reply.status);
      await abortHandover(supa, handoverId);
      return rejected.reply;
    }
    if (photo.kind !== "ok" || thumb.kind !== "ok") return Response.json({ error: SAVE_FAILED }, { status: 502 });
    sizeBytes = photo.size;
    fileParents = { photo: photo.parents, thumb: thumb.parents };
  } catch (error) {
    return driveUploadErrorReply(error, LOG_TAG);
  }

  const finish = await supa.rpc("intercom_handover_finish", {
    p_handover: handoverId,
    p_size_bytes: sizeBytes,
    p_width: width,
    p_height: height,
  });
  if (finish.error) {
    await abortHandover(supa, handoverId);
    return dbError(finish.error, "intercom_handover_finish", LOG_TAG, SAVE_FAILED);
  }
  if (folderId) {
    const failure = await placeDriveHandoverFiles({
      accountId: row.drive_account_id,
      folderId,
      photoFileId: row.drive_file_id,
      thumbFileId: row.drive_thumb_file_id,
      photoFrom: stagingFolderId && fileParents.photo.includes(stagingFolderId) ? stagingFolderId : null,
      thumbFrom: stagingFolderId && fileParents.thumb.includes(stagingFolderId) ? stagingFolderId : null,
    });
    await markPlaced(supa, handoverId, failure);
  }
  return Response.json({ ok: true, already_done: false, result: finish.data ?? null });
}
