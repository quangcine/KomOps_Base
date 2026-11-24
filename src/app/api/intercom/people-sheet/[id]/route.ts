import { UUID_RE, dbError } from "@/adapters/storage";
import { readJsonObject, rejectForeignOrigin, requireStaff, type StaffSupabase } from "../../upload/_shared";
import {
  DRIVE_FILES_URL,
  DRIVE_FILE_ID_PATTERN,
  DRIVE_UPLOAD_URL,
  DriveError,
  driveErrorResponse,
  fetchDrive,
  fetchGoogle,
  readDriveSecret,
  readJsonBody,
  runDrivePermissions,
  trashUnusedDriveFile,
  type DriveProjectStorage,
} from "../../drive/_shared";

/**
 * Sheet danh sách người của dự án intercom. Gác: phiên nhân viên cộng `intercom_can_access`.
 * - `POST {action: 'create_template'}`: dự án `drive` đã nối, chưa có Sheet. Tạo Sheet mẫu trong thư mục dự án,
 * ghi bằng hàm cổng `intercom_people_sheet_set_template`, rồi mở "ai có link đều sửa" qua
 * `intercom_drive_permission_*`.
 * - `POST {action: 'set_link', url}`: chỉ nhận link Google Sheet; route tự dựng địa chỉ xuất CSV, không fetch
 * URL người dùng đưa. Đọc thử một lần, chưa công khai thì không lưu. Thay file mẫu thì gỡ quyền sửa của file
 * mẫu.
 * - `GET ?action=read`: `template` đọc bằng token tài khoản giữ file; `link` đọc CSV công khai không kèm đăng
 * nhập. Không log mã tệp, link, nội dung Sheet.
 */
export const dynamic = "force-dynamic";

const LOG_TAG = "[intercom/people-sheet]";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const HEADER_ROW_TEXT = "Tên,Bộ phận,Nhóm,Số điện thoại\r\n";
/** Trần đọc Sheet: 1 MB, tiêu đề cộng 300 dòng có chữ. */
const READ_MAX_BYTES = 1024 * 1024;
const READ_MAX_ROWS = 301;
/**
 * Trần an toàn số dòng giữ lại (dòng có chữ cộng dòng trắng nằm GIỮA bảng, giữ để số dòng báo lỗi khớp Sheet).
 * Dòng trắng cuối bảng không giữ nên không tính. Sheet mặc định 1.000 dòng; 10.000 dòng rộng gấp 10 mà vẫn chặn
 * thân 1 MB toàn dấu xuống dòng (tới khoảng 1 triệu dòng) làm nặng Worker và phồng JSON trả về.
 */
const READ_MAX_KEPT_LINES = 10_000;
const SHEET_ID_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;
const GID_PATTERN = /^[0-9]{1,20}$/;

const PRIVATE_SHEET_ERROR = "Sheet chưa mở Bất kỳ ai có đường liên kết. Mở chia sẻ rồi thử lại.";
const BAD_LINK = "Link không phải Google Sheet. Dán link dạng https://docs.google.com/spreadsheets/d/...";
const BAD_TAB = "Không đọc được trang tính trong link. Mở đúng trang tính rồi chép lại link.";

type SheetRow = {
  kind: "template" | "link";
  file_id: string;
  gid: string | null;
  template_file_id: string | null;
  template_account_id: string | null;
};

type ReadResult = { ok: true; rows: string[][] } | { ok: false; response: Response };

/** Gác chung: id dự án hợp lệ, phiên nhân viên, vào được dự án. */
async function requireProjectAccess(projectIdRaw: string): Promise<{ supa: StaffSupabase; projectId: string } | Response> {
  const projectId = projectIdRaw.toLowerCase();
  if (!UUID_RE.test(projectId)) return Response.json({ error: "Tham số không hợp lệ" }, { status: 400 });
  const staff = await requireStaff();
  if (staff instanceof Response) return staff;
  const access = await staff.supa.rpc("intercom_can_access", { p_project: projectId });
  if (access.error) return dbError(access.error, "intercom_can_access", LOG_TAG, "Chưa kiểm tra được quyền.");
  if (access.data !== true) return Response.json({ error: "Không có quyền với dự án này.", reason: "permission" }, { status: 403 });
  return { supa: staff.supa, projectId };
}

async function readSheetRow(supa: StaffSupabase, projectId: string): Promise<SheetRow | null | Response> {
  const { data, error } = await supa
    .from("intercom_people_sheet")
    .select("kind, file_id, gid, template_file_id, template_account_id")
    .eq("project_id", projectId)
    .maybeSingle();
  if (error) return dbError(error, "read people sheet", LOG_TAG, "Chưa đọc được Sheet danh sách người.");
  return (data ?? null) as SheetRow | null;
}

/**
 * Tách mã Sheet và trang tính từ link người dùng dán. Không phải link Google Sheet thì `null`. Link không có
 * `gid` (nút Sao chép đường liên kết của Google) thì `gid` null: trang đầu không chắc mang gid 0.
 */
function parseSheetUrl(raw: unknown): { fileId: string; gid: string | null } | null {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "docs.google.com") return null;
  const match = /^\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(url.pathname);
  if (!match || !SHEET_ID_PATTERN.test(match[1])) return null;
  const fromHash = /(?:^#|&)gid=([0-9]+)/.exec(url.hash)?.[1];
  const gid = url.searchParams.get("gid") ?? fromHash ?? null;
  if (gid !== null && !GID_PATTERN.test(gid)) return null;
  return { fileId: match[1], gid };
}

/** Địa chỉ CSV công khai. Không có `gid` thì bỏ hẳn tham số, Google trả trang đầu. */
function sheetExportUrl(fileId: string, gid: string | null): string {
  const base = `https://docs.google.com/spreadsheets/d/${fileId}/export?format=csv`;
  return gid === null ? base : `${base}&gid=${gid}`;
}

/** Đọc thân có trần bytes; quá trần thì `null`. */
async function readTextCapped(res: Response): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > READ_MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(all);
}

type SplitResult = { ok: true; rows: string[][] } | { ok: false; reason: "too_many" | "too_many_lines" };

/**
 * CSV theo RFC 4180 (ô trong ngoặc kép, `""` là một dấu nháy, xuống dòng trong ô). Trần `maxRows` chỉ đếm dòng
 * có chữ. Dòng trắng hoãn lại, chỉ ghi ra (giữ số dòng) khi sau nó còn dòng có chữ; dòng trắng cuối bảng bỏ hẳn.
 * Dòng giữ lại quá `maxKeptLines` cũng chặn.
 */
function splitSheetText(text: string, maxRows: number, maxKeptLines: number): SplitResult {
  const rows: string[][] = [];
  const blankRow: string[] = [""];
  let filledCount = 0;
  let pendingBlank = 0;
  let row: string[] = [];
  let cell = "";
  let insideQuotes = false;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // Trả lý do chặn, hoặc `null` khi còn trong trần.
  const pushRow = (): SplitResult | null => {
    row.push(cell);
    const current = row;
    row = [];
    cell = "";
    if (current.every((c) => c.trim() === "")) {
      pendingBlank += 1;
      return null;
    }
    filledCount += 1;
    if (filledCount > maxRows) return { ok: false, reason: "too_many" };
    if (rows.length + pendingBlank + 1 > maxKeptLines) return { ok: false, reason: "too_many_lines" };
    for (; pendingBlank > 0; pendingBlank -= 1) rows.push(blankRow);
    rows.push(current);
    return null;
  };
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (insideQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else insideQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') insideQuotes = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && body[i + 1] === "\n") i += 1;
      const stop = pushRow();
      if (stop) return stop;
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    const stop = pushRow();
    if (stop) return stop;
  }
  // Dòng trắng còn hoãn là dòng trắng cuối bảng: bỏ, không tính trần.
  return { ok: true, rows };
}

/** Đổi văn bản CSV sang dòng, có trần. */
function textToRows(text: string | null): ReadResult {
  if (text === null) {
    return { ok: false, response: Response.json({ error: "Sheet lớn quá 1 MB.", reason: "too_large" }, { status: 413 }) };
  }
  const split = splitSheetText(text, READ_MAX_ROWS, READ_MAX_KEPT_LINES);
  if (!split.ok) {
    const error =
      split.reason === "too_many"
        ? "Sheet quá 300 dòng người. Chia làm nhiều Sheet."
        : "Sheet có quá nhiều dòng trắng giữa bảng. Xoá bớt dòng trắng rồi thử lại.";
    return { ok: false, response: Response.json({ error, reason: "too_many" }, { status: 413 }) };
  }
  return { ok: true, rows: split.rows };
}

/**
 * Đọc CSV công khai của Sheet khách dán, không kèm đăng nhập. Nhận ra chưa công khai: mã 401, 403; URL cuối
 * thuộc `accounts.google.com`; phản hồi không phải `text/csv`.
 */
async function readPublicSheet(fileId: string, gid: string | null): Promise<ReadResult> {
  const url = sheetExportUrl(fileId, gid);
  let res: Response;
  try {
    res = await fetchGoogle(url, { method: "GET", redirect: "follow" });
  } catch {
    return { ok: false, response: Response.json({ error: "Chưa đọc được Sheet, thử lại giúp tôi.", reason: "network" }, { status: 502 }) };
  }
  let finalHost = "";
  try {
    finalHost = new URL(res.url || url).hostname;
  } catch {
    finalHost = "";
  }
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (res.status === 401 || res.status === 403 || finalHost === "accounts.google.com" || (res.ok && !contentType.startsWith("text/csv"))) {
    await res.body?.cancel();
    return { ok: false, response: Response.json({ error: PRIVATE_SHEET_ERROR, reason: "not_public" }, { status: 422 }) };
  }
  if (res.status === 404) {
    await res.body?.cancel();
    return { ok: false, response: Response.json({ error: "Không tìm thấy Sheet hoặc trang tính.", reason: "not_found" }, { status: 404 }) };
  }
  if (res.status === 400) {
    await res.body?.cancel();
    return { ok: false, response: Response.json({ error: BAD_TAB, reason: "bad_tab" }, { status: 422 }) };
  }
  if (!res.ok) {
    await res.body?.cancel();
    console.error(LOG_TAG, "public read failed", res.status);
    return { ok: false, response: Response.json({ error: "Chưa đọc được Sheet, thử lại giúp tôi.", reason: "network" }, { status: 502 }) };
  }
  return textToRows(await readTextCapped(res));
}

/** Đọc file mẫu bằng token tài khoản giữ file, kể cả khi dự án đã đổi nơi lưu. */
async function readTemplateSheet(accountId: string, fileId: string): Promise<ReadResult> {
  if (!DRIVE_FILE_ID_PATTERN.test(fileId)) {
    return { ok: false, response: Response.json({ error: "Không tìm thấy Sheet.", reason: "not_found" }, { status: 404 }) };
  }
  try {
    const res = await fetchDrive(accountId, `${DRIVE_FILES_URL}/${fileId}/export?mimeType=text%2Fcsv`);
    if (res.status === 404) {
      await res.body?.cancel();
      return { ok: false, response: Response.json({ error: "Sheet mẫu không còn trên Drive.", reason: "not_found" }, { status: 404 }) };
    }
    if (!res.ok) {
      await res.body?.cancel();
      console.error(LOG_TAG, "template export failed", res.status);
      return { ok: false, response: Response.json({ error: "Chưa đọc được Sheet, thử lại giúp tôi.", reason: "network" }, { status: 502 }) };
    }
    return textToRows(await readTextCapped(res));
  } catch (error) {
    return { ok: false, response: driveErrorResponse(error, LOG_TAG) };
  }
}

function readSheet(sheet: SheetRow): Promise<ReadResult> {
  if (sheet.kind === "template" && sheet.template_account_id) return readTemplateSheet(sheet.template_account_id, sheet.file_id);
  return readPublicSheet(sheet.file_id, sheet.gid);
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (new URL(req.url).searchParams.get("action") !== "read") return Response.json({ error: "Tham số không hợp lệ" }, { status: 400 });
  const gate = await requireProjectAccess((await params).id);
  if (gate instanceof Response) return gate;
  const sheet = await readSheetRow(gate.supa, gate.projectId);
  if (sheet instanceof Response) return sheet;
  if (!sheet) return Response.json({ error: "Dự án chưa có Sheet.", reason: "no_sheet" }, { status: 404 });
  const read = await readSheet(sheet);
  if (!read.ok) return read.response;
  const [header = [], ...rows] = read.rows;
  return Response.json({ header, rows }, { headers: { "cache-control": "no-store" } });
}

/** Ghép thân `multipart/related` của `files.create`: siêu dữ liệu JSON cộng CSV, Google đổi CSV sang Sheet. */
function templateUploadBody(name: string, folderId: string): { body: string; boundary: string } {
  const boundary = `part${crypto.randomUUID().replace(/-/g, "")}`;
  const metadata = JSON.stringify({ name, mimeType: SHEET_MIME, parents: [folderId] });
  const body =
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\ncontent-type: text/csv; charset=UTF-8\r\n\r\n${HEADER_ROW_TEXT}\r\n` +
    `--${boundary}--`;
  return { body, boundary };
}

async function createTemplate(supa: StaffSupabase, projectId: string): Promise<Response> {
  const read = await supa.rpc("intercom_project_storage", { p_project: projectId });
  if (read.error) return dbError(read.error, "intercom_project_storage", LOG_TAG, "Chưa đọc được nơi lưu.");
  const storage = ((read.data ?? []) as DriveProjectStorage[])[0];
  if (!storage) return Response.json({ error: "Không tìm thấy dự án." }, { status: 404 });
  if (storage.storage_kind !== "drive" || !storage.account_id || !storage.folder_id) {
    return Response.json({ error: "Dự án chưa nối xong Google Drive.", reason: "not_drive" }, { status: 409 });
  }
  if (storage.account_status !== "active") {
    return Response.json({ error: "Drive mất quyền, nối lại tài khoản Google.", reason: "drive_revoked" }, { status: 409 });
  }
  if (!DRIVE_FILE_ID_PATTERN.test(storage.folder_id)) return Response.json({ error: "Thư mục Drive không hợp lệ." }, { status: 409 });
  const existing = await readSheetRow(supa, projectId);
  if (existing instanceof Response) return existing;
  if (existing) return Response.json({ error: "Dự án đã có Sheet.", reason: "exists" }, { status: 409 });

  const project = await supa.from("intercom_project").select("name").eq("id", projectId).maybeSingle();
  if (project.error) return dbError(project.error, "read project", LOG_TAG, "Chưa đọc được dự án.");
  const name = (project.data as { name?: unknown } | null)?.name;
  if (typeof name !== "string") return Response.json({ error: "Không tìm thấy dự án." }, { status: 404 });

  const accountId = storage.account_id;
  let fileId: string;
  try {
    const upload = templateUploadBody(`Danh sách người - ${name}`, storage.folder_id);
    const res = await fetchDrive(accountId, `${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id`, {
      method: "POST",
      headers: { "content-type": `multipart/related; boundary=${upload.boundary}` },
      body: upload.body,
    });
    const body = await readJsonBody(res);
    if (!res.ok || typeof body.id !== "string" || !DRIVE_FILE_ID_PATTERN.test(body.id)) {
      console.error(LOG_TAG, "create template failed", res.status);
      return Response.json({ error: "Google chưa tạo được Sheet, thử lại giúp tôi." }, { status: 502 });
    }
    fileId = body.id;
  } catch (error) {
    return driveErrorResponse(error, LOG_TAG);
  }

  const saved = await supa.rpc("intercom_people_sheet_set_template", {
    p_gate: readDriveSecret("INTERCOM_DRIVE_GATE"),
    p_project: projectId,
    p_file_id: fileId,
    p_account: accountId,
  });
  if (saved.error || saved.data !== true) {
    await trashUnusedDriveFile(accountId, fileId, LOG_TAG);
    if (saved.error) return dbError(saved.error, "intercom_people_sheet_set_template", LOG_TAG, "Chưa lưu được Sheet mẫu.");
    console.error(LOG_TAG, "set_template gate refused");
    return Response.json({ error: "Drive chưa cấu hình xong.", reason: "drive_config" }, { status: 500 });
  }

  let share: "ok" | "cannot_share" | "failed" = "failed";
  try {
    const results = await runDrivePermissions(supa, projectId, LOG_TAG);
    const sheetEdit = results.find((r) => r.purpose === "sheet_edit" && r.want === "on");
    share = sheetEdit && !sheetEdit.error ? "ok" : sheetEdit?.error === "cannot_share" ? "cannot_share" : "failed";
  } catch (error) {
    if (!(error instanceof DriveError)) throw error;
    console.error(LOG_TAG, "permission run failed", error.code);
  }
  return Response.json({ ok: true, file_id: fileId, share });
}

async function setLink(supa: StaffSupabase, projectId: string, rawUrl: unknown): Promise<Response> {
  const parsed = parseSheetUrl(rawUrl);
  if (!parsed) return Response.json({ error: BAD_LINK, reason: "bad_link" }, { status: 400 });

  const probe = await readPublicSheet(parsed.fileId, parsed.gid);
  if (!probe.ok) return probe.response;

  const saved = await supa.rpc("intercom_people_sheet_set_link", { p_project: projectId, p_file_id: parsed.fileId, p_gid: parsed.gid });
  if (saved.error) return dbError(saved.error, "intercom_people_sheet_set_link", LOG_TAG, "Chưa lưu được link Sheet.");

  // Thay file mẫu: gỡ quyền sửa của file mẫu. Lỗi thì dòng quyền còn lệch, link mới vẫn lưu.
  try {
    await runDrivePermissions(supa, projectId, LOG_TAG);
  } catch (error) {
    if (!(error instanceof DriveError)) throw error;
    console.error(LOG_TAG, "permission run failed", error.code);
  }
  return Response.json({ ok: true });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const blocked = rejectForeignOrigin(req);
  if (blocked) return blocked;
  const gate = await requireProjectAccess((await params).id);
  if (gate instanceof Response) return gate;
  const body = await readJsonObject(req);
  if (body?.action === "create_template") return createTemplate(gate.supa, gate.projectId);
  if (body?.action === "set_link") return setLink(gate.supa, gate.projectId, body.url);
  return Response.json({ error: "Tham số không hợp lệ" }, { status: 400 });
}
