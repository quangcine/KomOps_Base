import { dbError } from "@/adapters/storage";
import {
  MAX_BYTES,
  SAVE_FAILED,
  TOO_LARGE,
  intInRange,
  parseHandoverMeta,
  readJsonObject,
  rejectForeignOrigin,
  requireStaff,
  type HandoverMeta,
  type StaffSupabase,
} from "../../../upload/_shared";
import {
  DRIVE_FILES_URL,
  DRIVE_FILE_ID_PATTERN,
  DRIVE_UPLOAD_URL,
  ensureDriveStagingFolder,
  fetchDrive,
  readDriveSecret,
  readJsonBody,
  type DriveProjectStorage,
} from "../../_shared";
import { DRIVE_CALL_FAILED_TEXT, driveRevokedReply, driveStepFailed, driveUploadErrorReply } from "../_shared";

/**
 * Bước 1 của tải thẳng: `POST` JSON meta như `upload/start` cộng `photo_size`, `thumb_size`. Dự án không phải
 * `drive` thì 409, trước `begin` để khỏi đẻ lượt thừa. Lượt chưa có mã: xin hai mã, ghi vào lượt, tạo hai phiên.
 * Lượt đã có mã (Thử lại): tệp đã lên thì báo máy bỏ qua `PUT` (địa chỉ phiên `null`), chưa lên thì tạo phiên
 * mới. Cả hai tệp tải vào thư mục tạm của dự án; `finish` chuyển ảnh nén vào thư mục dự án, ảnh nhỏ vào
 * `Thumbnail`. Dự án chưa có thư mục tạm thì tạo ở đây. Mã tệp do Worker cấp, không ra máy. Ai có địa chỉ phiên
 * là ghi được tệp: không log, `no-store`.
 */
export const dynamic = "force-dynamic";

const LOG_TAG = "[intercom/drive/upload/start]";
const QUOTA_REASON = "storageQuotaExceeded";
const FILE_NAME_MAX_LENGTH = 255;
const THUMB_SUFFIX = "_t";

/** Lỗi khác thì `null`. */
function readQuotaMessage(body: Record<string, unknown>): string | null {
  const error = body.error as { message?: unknown; errors?: { reason?: unknown }[] } | undefined;
  const reason = error?.errors?.[0]?.reason;
  if (reason !== QUOTA_REASON) return null;
  return `Google Drive báo: ${typeof error?.message === "string" ? error.message : QUOTA_REASON}`;
}

/** Bỏ dấu, kể cả `đ`, `Đ` mà `NFD` không tách, bỏ mọi ký tự ngoài chữ, số, viết liền. */
function compactName(text: string): string {
  return text
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

type UnitNameRow = { id: string; code: string; prefix: string; seq: number };

/** Sắp theo `prefix` rồi `seq` như `intercom_handover_begin`. Đọc lỗi thì rỗng. */
async function readSortedUnits(supa: StaffSupabase, unitIds: string[]): Promise<UnitNameRow[]> {
  if (unitIds.length === 0) return [];
  const { data, error } = await supa.from("intercom_unit").select("id, code, prefix, seq").in("id", unitIds);
  if (error) return [];
  return ((data ?? []) as UnitNameRow[]).sort((a, b) => (a.prefix === b.prefix ? a.seq - b.seq : a.prefix < b.prefix ? -1 : 1));
}

/** Đọc lỗi thì `null`. */
async function readPersonName(supa: StaffSupabase, personId: string): Promise<string | null> {
  const { data, error } = await supa.from("intercom_person").select("full_name").eq("id", personId).maybeSingle();
  if (error) return null;
  return (data as { full_name?: string } | null)?.full_name ?? null;
}

/** Tai và tên của lượt giao: có người thì tên người, không thì bộ phận. */
async function readDeliverNameParts(supa: StaffSupabase, meta: HandoverMeta): Promise<{ units: UnitNameRow[]; who: string | null }> {
  const units = await readSortedUnits(supa, meta.unitIds ?? []);
  return { units, who: meta.personId ? await readPersonName(supa, meta.personId) : meta.department };
}

/** Lượt thu lấy người, bộ phận trên `intercom_issue` của tai đầu tiên: `begin` không ghi người cho lượt thu. */
async function readCollectNameParts(supa: StaffSupabase, meta: HandoverMeta): Promise<{ units: UnitNameRow[]; who: string | null }> {
  const issueIds = meta.issueIds ?? [];
  if (issueIds.length === 0) return { units: [], who: null };
  const { data, error } = await supa.from("intercom_issue").select("unit_id, person_id, department").in("id", issueIds);
  if (error) return { units: [], who: null };
  const issues = (data ?? []) as { unit_id: string; person_id: string | null; department: string | null }[];
  const units = await readSortedUnits(supa, issues.map((issue) => issue.unit_id));
  const first = issues.find((issue) => issue.unit_id === units[0]?.id) ?? issues[0];
  if (!first) return { units, who: null };
  return { units, who: first.person_id ? await readPersonName(supa, first.person_id) : first.department };
}

/**
 * Phần tên trước đuôi: `<YYMMDD>_<tai>_<tên>_<Giao|Thu>_<handover_id>`. Tên chỉ để đọc, app không dùng, nên
 * không được làm hỏng lượt: thiếu tai hoặc tên thì bỏ phần đó; thiếu ngày, thiếu cả hai, quá dài, hay lỗi bất
 * ngờ thì còn mỗi mã lượt.
 */
async function buildDriveFileStem(supa: StaffSupabase, meta: HandoverMeta, workDate: unknown): Promise<string> {
  const shortStem = meta.handoverId;
  try {
    const date = typeof workDate === "string" ? /^\d{2}(\d{2})-(\d{2})-(\d{2})$/.exec(workDate) : null;
    if (!date) return shortStem;
    const { units, who } = await (meta.kind === "deliver" ? readDeliverNameParts(supa, meta) : readCollectNameParts(supa, meta));
    const unitPart = units.map((unit) => unit.code).join("-");
    const whoPart = who ? compactName(who) : "";
    if (!unitPart && !whoPart) return shortStem;
    const label = meta.kind === "deliver" ? "Giao" : "Thu";
    const stem = [`${date[1]}${date[2]}${date[3]}`, unitPart, whoPart, label, meta.handoverId].filter(Boolean).join("_");
    return `${stem}${THUMB_SUFFIX}.jpg`.length > FILE_NAME_MAX_LENGTH ? shortStem : stem;
  } catch {
    console.error(LOG_TAG, "read file name parts failed");
    return shortStem;
  }
}

type SessionTarget = {
  accountId: string;
  folderId: string;
  fileId: string;
  name: string;
  bytes: number;
  origin: string;
  /** Mã đã có từ lần trước: tệp có thể đã lên. */
  mayExist: boolean;
};

/** Địa chỉ phiên, hoặc `null` khi tệp đã lên. Google từ chối thì trả `Response`. */
async function openUploadSession(target: SessionTarget): Promise<string | null | Response> {
  const { accountId, fileId, folderId } = target;
  if (target.mayExist) {
    const found = await fetchDrive(accountId, `${DRIVE_FILES_URL}/${fileId}?fields=id`);
    if (found.ok) return null;
    if (found.status !== 404) return driveStepFailed(LOG_TAG, "files.get", found.status);
  }
  const session = await fetchDrive(accountId, `${DRIVE_UPLOAD_URL}?uploadType=resumable`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-type": "image/jpeg",
      "x-upload-content-length": String(target.bytes),
      // `Origin` quyết định Google có mở CORS cho địa chỉ phiên hay không; `rejectForeignOrigin` đã kiểm giá trị này.
      origin: target.origin,
    },
    body: JSON.stringify({ id: fileId, parents: [folderId], name: target.name, mimeType: "image/jpeg" }),
  });
  const sessionUrl = session.ok ? session.headers.get("location") : null;
  if (sessionUrl) return sessionUrl;
  const quota = session.ok ? null : readQuotaMessage(await readJsonBody(session));
  return driveStepFailed(LOG_TAG, "create session", session.status, quota ?? DRIVE_CALL_FAILED_TEXT);
}

/** Không được thì 502 `drive_network`. Lỗi Drive ném ra. */
async function readStagingFolder(supa: StaffSupabase, accountId: string, projectId: string): Promise<string | Response> {
  const project = await supa.from("intercom_project").select("name, drive_staging_folder_id").eq("id", projectId).maybeSingle();
  if (project.error) return dbError(project.error, "read project", LOG_TAG, SAVE_FAILED);
  const read = project.data as { name?: unknown; drive_staging_folder_id?: unknown } | null;
  const held = read?.drive_staging_folder_id;
  if (typeof held === "string" && DRIVE_FILE_ID_PATTERN.test(held)) return held;
  if (typeof read?.name !== "string") return Response.json({ error: SAVE_FAILED }, { status: 502 });
  const created = await ensureDriveStagingFolder(supa, accountId, projectId, read.name, LOG_TAG);
  return created ?? driveStepFailed(LOG_TAG, "staging folder", 0);
}

export async function POST(req: Request): Promise<Response> {
  const blocked = rejectForeignOrigin(req);
  if (blocked) return blocked;
  const staff = await requireStaff();
  if (staff instanceof Response) return staff;
  const { supa } = staff;

  const body = await readJsonObject(req);
  if (!body) return Response.json({ error: "Tham số không hợp lệ" }, { status: 400 });
  const meta = parseHandoverMeta(body);
  const photoSize = intInRange(body.photo_size, 1, Number.MAX_SAFE_INTEGER);
  const thumbSize = intInRange(body.thumb_size, 1, Number.MAX_SAFE_INTEGER);
  if (!meta || !photoSize || !thumbSize) return Response.json({ error: "Tham số không hợp lệ" }, { status: 400 });
  if (photoSize > MAX_BYTES || thumbSize > MAX_BYTES) return Response.json({ error: TOO_LARGE }, { status: 413 });

  const storageRead = await supa.rpc("intercom_project_storage", { p_project: meta.projectId });
  if (storageRead.error) return dbError(storageRead.error, "intercom_project_storage", LOG_TAG, SAVE_FAILED);
  const storage = ((storageRead.data ?? []) as DriveProjectStorage[])[0];
  // Không qua quyền thì hàm trả rỗng: cùng phản hồi với `42501` của `begin`.
  if (!storage) return Response.json({ error: "Bạn không còn quyền ở dự án này.", reason: "permission" }, { status: 403 });
  if (storage.storage_kind !== "drive") {
    return Response.json({ error: "Dự án này không lưu Google Drive, tải lại trang rồi gửi lại." }, { status: 409 });
  }
  if (!storage.account_id || !storage.folder_id) {
    return Response.json({ error: "Dự án chưa chọn tài khoản Google, nhờ quản lý chọn." }, { status: 409 });
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
    // Chỉ gửi khi có, như `upload/start`.
    ...(meta.workDate ? { p_work_date: meta.workDate } : {}),
  });
  if (begin.error) return dbError(begin.error, "intercom_handover_begin", LOG_TAG, SAVE_FAILED);
  const opened = (begin.data ?? null) as { already_done?: unknown; result?: unknown } | null;
  if (opened?.already_done === true) {
    return Response.json({ ok: true, already_done: true, result: opened.result ?? null });
  }

  try {
    const current = await supa
      .from("intercom_handover")
      .select("drive_file_id, drive_thumb_file_id, work_date, storage_fallback_at")
      .eq("id", meta.handoverId)
      .maybeSingle();
    if (current.error) return dbError(current.error, "select intercom_handover", LOG_TAG, SAVE_FAILED);
    const held = current.data as {
      drive_file_id?: string | null;
      drive_thumb_file_id?: string | null;
      work_date?: unknown;
      storage_fallback_at?: string | null;
    } | null;
    if (held?.storage_fallback_at) {
      return Response.json({ error: "Lượt này đã chuyển sang lưu tạm R2.", reason: "storage_fallback" }, { status: 409 });
    }
    if (storage.account_status === "revoked") return driveRevokedReply();

    const stagingFolderId = await readStagingFolder(supa, storage.account_id, meta.projectId);
    if (stagingFolderId instanceof Response) return stagingFolderId;

    let fileId = held?.drive_file_id ?? null;
    let thumbFileId = held?.drive_thumb_file_id ?? null;
    const hasFreshIds = !fileId || !thumbFileId;
    if (hasFreshIds) {
      const idsReply = await fetchDrive(storage.account_id, `${DRIVE_FILES_URL}/generateIds?count=2&space=drive`);
      if (!idsReply.ok) return driveStepFailed(LOG_TAG, "generateIds", idsReply.status);
      const ids = (await readJsonBody(idsReply)).ids;
      if (!Array.isArray(ids) || typeof ids[0] !== "string" || typeof ids[1] !== "string") {
        return driveStepFailed(LOG_TAG, "generateIds", idsReply.status);
      }
      [fileId, thumbFileId] = ids as string[];
    }

    // Hàm giữ mã đang lưu nếu lần khác đã ghi trước: lấy mã hàm trả, không lấy mã vừa xin.
    const saved = await supa.rpc("intercom_handover_set_drive_files", {
      p_gate: readDriveSecret("INTERCOM_DRIVE_GATE"),
      p_handover: meta.handoverId,
      p_file: fileId,
      p_thumb: thumbFileId,
    });
    if (saved.error) return dbError(saved.error, "intercom_handover_set_drive_files", LOG_TAG, SAVE_FAILED);
    const row = ((saved.data ?? []) as { file_id: string; thumb_file_id: string; account_id: string; folder_id: string | null }[])[0];
    if (!row?.folder_id) {
      console.error(LOG_TAG, "set_drive_files returned nothing", meta.handoverId);
      return Response.json({ error: SAVE_FAILED }, { status: 502 });
    }

    const origin = req.headers.get("origin") ?? "";
    const target = { accountId: row.account_id, folderId: stagingFolderId, origin };
    const fileStem = await buildDriveFileStem(supa, meta, held?.work_date);
    const [photoUrl, thumbUrl] = await Promise.all([
      openUploadSession({
        ...target,
        fileId: row.file_id,
        name: `${fileStem}.jpg`,
        bytes: photoSize,
        mayExist: !hasFreshIds || row.file_id !== fileId,
      }),
      openUploadSession({
        ...target,
        fileId: row.thumb_file_id,
        name: `${fileStem}${THUMB_SUFFIX}.jpg`,
        bytes: thumbSize,
        mayExist: !hasFreshIds || row.thumb_file_id !== thumbFileId,
      }),
    ]);
    if (photoUrl instanceof Response) return photoUrl;
    if (thumbUrl instanceof Response) return thumbUrl;

    return Response.json(
      { ok: true, already_done: false, photo_session_url: photoUrl, thumb_session_url: thumbUrl },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return driveUploadErrorReply(error, LOG_TAG);
  }
}
