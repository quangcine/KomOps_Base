import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createWebClient } from "@/adapters/auth";
import { APP_HOST, APP_NAME, APP_ORIGIN } from "@/adapters/brand";
import { UUID_RE, dbError } from "@/adapters/storage";
import type { StaffSupabase } from "../upload/_shared";

/**
 * Phần dùng chung của các route `intercom/drive/*`. Giữ phần đọc bí mật nên đặt ở đây, không ở
 * `src/lib`. Không ghi token, mã, `id_token`, địa chỉ phiên ra log: chỉ ghi mã trạng thái và mã lỗi.
 */

/** Cookie theo tên miền, URI cố định: mọi bước nối Google chỉ chạy trên tên miền này. */
export const DRIVE_CONNECT_HOST = APP_HOST;
export const DRIVE_CONNECT_ORIGIN = APP_ORIGIN;
export const DRIVE_REDIRECT_URI = `${DRIVE_CONNECT_ORIGIN}/api/intercom/drive/callback`;
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const DRIVE_STATE_COOKIE = "intercom_drive_state";
export const DRIVE_STATE_COOKIE_PATH = "/api/intercom/drive";

export const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
export const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
/** Trần 200 như hàm `set_drive_files`. */
export const DRIVE_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Hạn mỗi lời gọi Google từ Worker. Khác hạn `PUT` ảnh, thứ chạy ở máy. */
const GOOGLE_TIMEOUT_MS = 15000;
/** Bỏ token trước khi hết hạn thật 60 giây. */
const TOKEN_EXPIRY_MARGIN_MS = 60000;
/** Mỗi lượt hàng đợi lấy tối đa chừng này dòng. */
const DRIVE_QUEUE_BATCH = 50;
/**
 * Hết chừng này thì dừng, dòng chưa tới giữ nguyên cho lượt sau: `waitUntil` chỉ được 30 giây, cộng hạn một lời
 * gọi Google 15 giây.
 */
const DRIVE_QUEUE_BUDGET_MS = 15000;

export type DriveErrorCode = "drive_revoked" | "drive_config" | "drive_network" | "drive_account_missing";

export class DriveError extends Error {
  readonly code: DriveErrorCode;
  constructor(code: DriveErrorCode) {
    super(code);
    this.name = "DriveError";
    this.code = code;
  }
}

type DriveSecretName =
  | "GOOGLE_DRIVE_CLIENT_ID"
  | "GOOGLE_DRIVE_CLIENT_SECRET"
  | "INTERCOM_DRIVE_KEY"
  | "INTERCOM_DRIVE_GATE"
  | "INTERCOM_CRON_SECRET";

/** Đọc secret của Worker; thiếu thì ném `drive_config`. Chỉ log tên, không log giá trị. */
export function readDriveSecret(name: DriveSecretName): string {
  let value: unknown;
  try {
    value = (getCloudflareContext().env as unknown as Record<string, unknown>)[name];
  } catch {
    value = undefined;
  }
  if (typeof value !== "string" || value === "") {
    console.error("[intercom/drive] missing secret", name);
    throw new DriveError("drive_config");
  }
  return value;
}

// Mã hoá chìa dài hạn

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Băm chuỗi secret ra khoá 256 bit: không phụ thuộc secret được sinh ở dạng hex hay base64. */
async function importDriveKey(): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(readDriveSecret("INTERCOM_DRIVE_KEY")));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** AES-GCM, IV mới mỗi lần. Bản mã dạng `<iv>.<ciphertext>`, cả hai base64url. */
export async function encryptRefreshToken(token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importDriveKey(), new TextEncoder().encode(token));
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(cipher))}`;
}

async function decryptRefreshToken(cipherText: string): Promise<string> {
  const [ivText, bodyText] = cipherText.split(".");
  if (!ivText || !bodyText) throw new DriveError("drive_config");
  const key = await importDriveKey();
  try {
    const iv = base64UrlToBytes(ivText);
    const body = base64UrlToBytes(bodyText);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as Uint8Array<ArrayBuffer> },
      key,
      body as Uint8Array<ArrayBuffer>,
    );
    return new TextDecoder().decode(plain);
  } catch {
    console.error("[intercom/drive] cannot decrypt stored token");
    throw new DriveError("drive_config");
  }
}

/** Đọc phần thân của `id_token` nhận trực tiếp từ Google qua TLS, nên không cần kiểm chữ ký. Sai dạng là `null`. */
export function readIdTokenClaims(idToken: unknown): Record<string, unknown> | null {
  if (typeof idToken !== "string") return null;
  const body = idToken.split(".")[1];
  if (!body) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body)));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Token

type CachedToken = { token: string; expiresAt: number };

/** Giữ chuỗi token, không giữ Promise: Worker không cho dùng lại Promise của request khác. */
const tokenCache = new Map<string, CachedToken>();

/** `fetch` có hạn; hỏng mức mạng hay hết hạn thì ném `drive_network`. */
export async function fetchGoogle(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) });
  } catch {
    throw new DriveError("drive_network");
  }
}

/** Đổi `code` lấy bộ token. Thân phản hồi chỉ trả cho chỗ gọi, không log. */
export async function exchangeGoogleCode(code: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetchGoogle(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: readDriveSecret("GOOGLE_DRIVE_CLIENT_ID"),
      client_secret: readDriveSecret("GOOGLE_DRIVE_CLIENT_SECRET"),
      redirect_uri: DRIVE_REDIRECT_URI,
    }),
  });
  return { status: res.status, body: await readJsonBody(res) };
}

export async function readJsonBody(res: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await res.json();
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function markAccountRevoked(accountId: string): Promise<void> {
  const { error } = await createWebClient().rpc("intercom_drive_account_mark_revoked", {
    p_gate: readDriveSecret("INTERCOM_DRIVE_GATE"),
    p_account: accountId,
  });
  if (error) console.error("[intercom/drive] mark_revoked failed", accountId, error.code);
}

/** Lấy access token của một tài khoản; `invalid_grant` thì đánh dấu mất quyền, ném `drive_revoked`. */
export async function getDriveAccessToken(accountId: string): Promise<string> {
  const cached = tokenCache.get(accountId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  tokenCache.delete(accountId);

  const { data, error } = await createWebClient().rpc("intercom_drive_account_cipher", {
    p_gate: readDriveSecret("INTERCOM_DRIVE_GATE"),
    p_account: accountId,
  });
  if (error) {
    console.error("[intercom/drive] read cipher failed", accountId, error.code);
    throw new DriveError("drive_network");
  }
  const cipherText = (data as { refresh_token_cipher?: unknown }[] | null)?.[0]?.refresh_token_cipher;
  if (typeof cipherText !== "string") throw new DriveError("drive_account_missing");

  const res = await fetchGoogle(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: await decryptRefreshToken(cipherText),
      client_id: readDriveSecret("GOOGLE_DRIVE_CLIENT_ID"),
      client_secret: readDriveSecret("GOOGLE_DRIVE_CLIENT_SECRET"),
    }),
  });
  const body = await readJsonBody(res);
  if (!res.ok || typeof body.access_token !== "string") {
    if (body.error === "invalid_grant") {
      await markAccountRevoked(accountId);
      throw new DriveError("drive_revoked");
    }
    console.error("[intercom/drive] token refresh failed", accountId, res.status);
    throw new DriveError("drive_network");
  }
  const lifetimeMs = (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000;
  tokenCache.set(accountId, { token: body.access_token, expiresAt: Date.now() + lifetimeMs - TOKEN_EXPIRY_MARGIN_MS });
  return body.access_token;
}

/** Bỏ token đang giữ của tài khoản, sau khi nối lại hoặc Drive trả 401. */
export function forgetDriveAccessToken(accountId: string): void {
  tokenCache.delete(accountId);
}

/**
 * Như `fetchGoogle` nhưng hạn chỉ tính tới lúc có header: `AbortSignal` còn hiệu lực khi đọc thân, nên giữ hạn
 * 15 giây sẽ cắt ảnh đang chuyển luồng tới máy sóng yếu.
 */
async function fetchGoogleUntilHeaders(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    throw new DriveError("drive_network");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gọi Drive kèm token. Drive trả 401 thì bỏ token đó, đổi lại đúng một lần, để gỡ quyền hiện "Drive mất quyền"
 * ngay.
 */
export async function fetchDrive(
  accountId: string,
  url: string,
  init: RequestInit = {},
  sendRequest: (url: string, init: RequestInit) => Promise<Response> = fetchGoogle,
): Promise<Response> {
  const send = async () => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${await getDriveAccessToken(accountId)}`);
    return sendRequest(url, { ...init, headers });
  };
  const first = await send();
  if (first.status !== 401) return first;
  forgetDriveAccessToken(accountId);
  return send();
}

/** Tạo thư mục trên Drive, trả mã; lỗi Google thì trả mã trạng thái. */
export async function createDriveFolder(
  accountId: string,
  name: string,
  parentId?: string,
): Promise<{ folderId: string | null; status: number }> {
  const res = await fetchDrive(accountId, `${DRIVE_FILES_URL}?fields=id`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ name, mimeType: DRIVE_FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) }),
  });
  const body = await readJsonBody(res);
  return { folderId: res.ok && typeof body.id === "string" ? body.id : null, status: res.status };
}

// Thư mục con của dự án

/**
 * Khách xem thư mục dự án thấy ảnh nén nằm thẳng ở đó, nên ảnh nhỏ phải nằm thư mục con riêng. Đổi tên ở đây là
 * đẻ thư mục mới trên dự án cũ.
 */
export const DRIVE_THUMBS_FOLDER = "Thumbnail";
/** Chỉ nhận hằng trên, nên ghép thẳng vào `q` không cần thoát ký tự. */
export type DriveSubFolderName = typeof DRIVE_THUMBS_FOLDER;

/**
 * Trần trang khi đọc tiếp `nextPageToken`. Hết trần là lỗi đọc, không phải không thấy: coi là không thấy thì đẻ
 * thư mục trùng.
 */
const SUB_FOLDER_LIST_MAX_PAGES = 5;
/** Mã trạng thái báo chỗ gọi khi hết trần trang hoặc thân hỏng: Google không lỗi nhưng chưa đọc xong. */
const SUB_FOLDER_LIST_UNFINISHED_STATUS = 502;

const subFolderCache = new Map<string, string>();

function subFolderCacheKey(parentId: string, name: DriveSubFolderName): string {
  return `${parentId}/${name}`;
}

/**
 * Tìm hoặc tạo thư mục con theo tên. Thư mục trùng thì chọn cái cũ nhất (`orderBy=createdTime`). Chỉ nạp cache
 * mã đọc được từ `files.list`, không nạp mã vừa tạo: lượt sau phải đi qua `files.list`, để các lượt hội tụ về
 * cùng thư mục.
 */
export async function resolveDriveSubFolder(
  accountId: string,
  parentId: string,
  name: DriveSubFolderName,
): Promise<{ folderId: string | null; status: number }> {
  const cacheKey = subFolderCacheKey(parentId, name);
  const cached = subFolderCache.get(cacheKey);
  if (cached) return { folderId: cached, status: 200 };
  if (!DRIVE_FILE_ID_PATTERN.test(parentId)) return { folderId: null, status: 400 };
  const query = new URLSearchParams({
    q: `name = '${name}' and '${parentId}' in parents and mimeType = '${DRIVE_FOLDER_MIME}' and trashed = false`,
    fields: "nextPageToken,files(id)",
    orderBy: "createdTime",
    pageSize: "1",
  });
  for (let page = 0; page < SUB_FOLDER_LIST_MAX_PAGES; page += 1) {
    const listed = await fetchDrive(accountId, `${DRIVE_FILES_URL}?${query.toString()}`);
    if (!listed.ok) return { folderId: null, status: listed.status };
    const body = await readJsonBody(listed);
    // Mã 200 mà không có mảng `files` là thân hỏng, chưa biết có thư mục hay chưa: coi là không thấy thì đẻ thư mục
    // trùng.
    if (!Array.isArray(body.files)) {
      console.error("[intercom/drive] subfolder list body has no files array");
      return { folderId: null, status: SUB_FOLDER_LIST_UNFINISHED_STATUS };
    }
    const found = (body.files[0] as { id?: unknown } | null | undefined)?.id;
    if (typeof found === "string") {
      subFolderCache.set(cacheKey, found);
      return { folderId: found, status: 200 };
    }
    // Có phần tử mà không có `id` chuỗi cũng là thân hỏng: chưa biết có thư mục hay chưa.
    if (body.files.length > 0) {
      console.error("[intercom/drive] subfolder list item has no id");
      return { folderId: null, status: SUB_FOLDER_LIST_UNFINISHED_STATUS };
    }
    // Trang rỗng mà còn token thì chưa kết luận được: tài liệu `files.list` nói trang có thể thiếu khi còn token.
    if (typeof body.nextPageToken !== "string" || body.nextPageToken === "") {
      return createDriveFolder(accountId, name, parentId);
    }
    query.set("pageToken", body.nextPageToken);
  }
  console.error("[intercom/drive] subfolder list ran out of pages");
  return { folderId: null, status: SUB_FOLDER_LIST_UNFINISHED_STATUS };
}

/** Bỏ một dòng cache, khi Google trả 404 lúc tạo phiên: thư mục đã bị xoá hẳn mà cache còn giữ. */
export function forgetDriveSubFolder(parentId: string, name: DriveSubFolderName): void {
  subFolderCache.delete(subFolderCacheKey(parentId, name));
}

/**
 * Chỉ đặt header của mình, không chép header Google. Mọi lỗi Drive trả 502, kể cả tệp đã bị xoá tay: để không
 * rơi vào câu "Link không còn hiệu lực".
 */
export async function serveDrivePhoto(accountId: string, fileId: string, logTag: string, cacheControl: string): Promise<Response> {
  const failed = () => Response.json({ error: "Chưa mở được ảnh trên Google Drive, thử lại giúp tôi." }, { status: 502 });
  try {
    const res = await fetchDrive(accountId, `${DRIVE_FILES_URL}/${fileId}?alt=media`, {}, fetchGoogleUntilHeaders);
    if (res.status !== 200 || !res.body) {
      console.error(logTag, "drive photo failed", res.status);
      return failed();
    }
    return new Response(res.body, {
      headers: { "content-type": "image/jpeg", "x-content-type-options": "nosniff", "cache-control": cacheControl },
    });
  } catch (error) {
    if (!(error instanceof DriveError)) throw error;
    console.error(logTag, "drive photo failed", error.code);
    return failed();
  }
}

// Hàng đợi thùng rác

type DriveQueueRow = { id: string; account_id: string; file_id: string; was_done: boolean };

export type DriveQueueResult = { taken: number; finished: number; failed: number };

/** Lỗi cả tài khoản: gặp một lần thì các dòng sau của tài khoản đó ghi luôn, không gọi Google lại. */
const ACCOUNT_WIDE_ERRORS: readonly string[] = ["drive_revoked", "drive_account_missing", "drive_config"];

/** Đưa một tệp vào thùng rác. Trả `null` khi xong, hoặc mã lỗi ngắn để ghi `last_error`. */
async function trashQueuedFile(row: DriveQueueRow): Promise<string | null> {
  if (!DRIVE_FILE_ID_PATTERN.test(row.file_id)) return "bad_file_id";
  try {
    const res = await fetchDrive(row.account_id, `${DRIVE_FILES_URL}/${row.file_id}?fields=id`, {
      method: "PATCH",
      headers: { "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ ["trashed"]: true }),
    });
    await res.body?.cancel();
    if (res.ok) return null;
    // Lượt chưa `done` gặp 404: mã đã cấp mà tệp chưa lên, coi là xong. Lượt `done` gặp 404 là ảnh sót.
    if (res.status === 404) return row.was_done ? "not_found" : null;
    return `http_${res.status}`;
  } catch (error) {
    return error instanceof DriveError ? error.code : "unexpected";
  }
}

/**
 * Một lượt hàng đợi: `queue_take`, `files.update` `trashed: true`, `queue_done`. Gọi hàm cổng bằng
 * `createWebClient()`, không đọc `cookies()`, vì chạy cả sau khi phản hồi đã trả; người xoá có thể không phải
 * quản lý nên cửa là cổng, không phải vai. Không log mã tệp.
 */
export async function runDriveQueue(): Promise<DriveQueueResult> {
  const gate = readDriveSecret("INTERCOM_DRIVE_GATE");
  const client = createWebClient();
  const { data, error } = await client.rpc("intercom_drive_queue_take", { p_gate: gate, p_limit: DRIVE_QUEUE_BATCH });
  if (error) {
    console.error("[intercom/drive] queue_take failed", error.code);
    throw new DriveError("drive_network");
  }
  const rows = (data ?? []) as DriveQueueRow[];
  const result: DriveQueueResult = { taken: rows.length, finished: 0, failed: 0 };
  const deadline = Date.now() + DRIVE_QUEUE_BUDGET_MS;
  const accountErrors = new Map<string, string>();
  for (const row of rows) {
    if (Date.now() > deadline) break;
    const failure = accountErrors.get(row.account_id) ?? (await trashQueuedFile(row));
    if (failure && ACCOUNT_WIDE_ERRORS.includes(failure)) accountErrors.set(row.account_id, failure);
    const done = await client.rpc("intercom_drive_queue_done", { p_gate: gate, p_id: row.id, p_error: failure });
    if (done.error) console.error("[intercom/drive] queue_done failed", done.error.code);
    if (failure) result.failed += 1;
    else result.finished += 1;
  }
  return result;
}

/** Xếp một lượt hàng đợi chạy sau phản hồi. Mọi lỗi dừng ở đây: không đổi phản hồi xoá đã thành công. */
export function scheduleDriveQueue(logTag: string): void {
  try {
    getCloudflareContext().ctx.waitUntil(
      runDriveQueue().catch((error: unknown) => {
        console.error(logTag, "drive queue failed", error instanceof DriveError ? error.code : "unexpected");
      }),
    );
  } catch {
    console.error(logTag, "drive queue not scheduled");
  }
}

// Gác route

export type DriveProjectStorage = {
  storage_kind: string;
  is_pilot: boolean;
  account_status: string | null;
  account_id: string | null;
  folder_id: string | null;
};

/** Chỉ quản lý intercom. Trả `Response` khi không qua, `null` khi qua. */
export async function requireDriveManager(supa: StaffSupabase, logTag: string): Promise<Response | null> {
  const manager = await supa.rpc("intercom_is_manager");
  if (manager.error) return dbError(manager.error, "intercom_is_manager", logTag, "Chưa kiểm tra được quyền.");
  if (manager.data !== true) {
    return Response.json({ error: "Chỉ quản lý intercom dùng được.", reason: "permission" }, { status: 403 });
  }
  return null;
}

/**
 * Hàm token mở `anon` qua cổng nên Worker là cửa duy nhất: gọi trước khi lấy token. Trả `Response` khi không
 * qua.
 */
export async function requirePilotManager(
  supa: StaffSupabase,
  projectId: string,
  logTag: string,
): Promise<DriveProjectStorage | Response> {
  const notManager = await requireDriveManager(supa, logTag);
  if (notManager) return notManager;
  const storage = await supa.rpc("intercom_project_storage", { p_project: projectId });
  if (storage.error) return dbError(storage.error, "intercom_project_storage", logTag, "Chưa đọc được nơi lưu.");
  const row = ((storage.data ?? []) as DriveProjectStorage[])[0];
  if (!row) return Response.json({ error: "Không tìm thấy dự án." }, { status: 404 });
  if (!row.is_pilot) {
    return Response.json({ error: "Dự án không trong danh sách thử Drive.", reason: "permission" }, { status: 403 });
  }
  return row;
}

// Gắn tài khoản vào dự án

const CREATE_FOLDER_FAILED = "Google chưa tạo được thư mục, thử lại giúp tôi.";

/**
 * Tệp, thư mục vừa tạo chưa ai dùng: đưa vào thùng rác (thư mục con đi theo). Lỗi chỉ ghi log, không đổi câu
 * báo.
 */
export async function trashUnusedDriveFile(accountId: string, fileId: string, logTag: string): Promise<void> {
  try {
    const res = await fetchDrive(accountId, `${DRIVE_FILES_URL}/${fileId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json; charset=UTF-8" },
      body: '{"trashed":true}',
    });
    if (!res.ok) console.error(logTag, "trash unused file failed", res.status);
  } catch {
    console.error(logTag, "trash unused file failed");
  }
}

/**
 * Lỗi thì thư mục vừa tạo vào thùng rác. Dùng chung cho `drive/folder` (chọn tài khoản có sẵn) và
 * `drive/callback` (nối xong tự gắn). Không kiểm quyền, tài khoản `active`: chỗ gọi kiểm trước. Trả mã thư mục,
 * hoặc `Response` lỗi.
 */
export async function attachDriveToProject(
  supa: StaffSupabase,
  projectId: string,
  accountId: string,
  logTag: string,
): Promise<{ folderId: string } | Response> {
  const project = await supa.from("intercom_project").select("name").eq("id", projectId).maybeSingle();
  if (project.error) return dbError(project.error, "read project", logTag, "Chưa đọc được dự án.");
  const name = (project.data as { name?: unknown } | null)?.name;
  if (typeof name !== "string") return Response.json({ error: "Không tìm thấy dự án." }, { status: 404 });

  let folderId: string | null = null;
  try {
    const created = await createDriveFolder(accountId, `${APP_NAME} - ${name}`);
    folderId = created.folderId;
    if (!folderId) {
      console.error(logTag, "create folder failed", created.status);
      return Response.json({ error: CREATE_FOLDER_FAILED }, { status: 502 });
    }
    // Gọi thẳng `createDriveFolder`: khỏi tốn `files.list`, không nạp cache, để lượt đầu ở `start` đi qua `files.list`
    // thật.
    const child = await createDriveFolder(accountId, DRIVE_THUMBS_FOLDER, folderId);
    if (!child.folderId) {
      console.error(logTag, "create subfolder failed", child.status);
      await trashUnusedDriveFile(accountId, folderId, logTag);
      return Response.json({ error: CREATE_FOLDER_FAILED }, { status: 502 });
    }
  } catch (error) {
    if (folderId) await trashUnusedDriveFile(accountId, folderId, logTag);
    return driveErrorResponse(error, logTag);
  }

  const saved = await supa.rpc("intercom_project_set_storage", {
    p_project: projectId,
    p_kind: "drive",
    p_account: accountId,
    p_folder: folderId,
    p_gate: readDriveSecret("INTERCOM_DRIVE_GATE"),
  });
  if (saved.error) {
    await trashUnusedDriveFile(accountId, folderId, logTag);
    return dbError(saved.error, "intercom_project_set_storage", logTag, "Chưa lưu được nơi lưu.");
  }
  // Thư mục tạm: lỗi không làm hỏng việc gắn, `drive/upload/start` tạo lại khi thiếu.
  try {
    await ensureDriveStagingFolder(supa, accountId, projectId, name, logTag);
  } catch (error) {
    console.error(logTag, "create staging folder failed", error instanceof DriveError ? error.code : "unexpected");
  }
  return { folderId };
}

// Thư mục tạm, chuyển vào thư mục dự án

/** Đuôi tên thư mục tạm, nằm ở gốc My Drive, không chia sẻ: tệp đang tải dở không lọt vào thư mục khách xem. */
const DRIVE_STAGING_SUFFIX = " (đang tải)";

/**
 * Hai lượt cùng tạo: lượt nhận về mã khác mã mình tạo thì đưa thư mục của mình vào thùng rác, dùng mã hàm trả.
 * Trả mã thư mục tạm, hoặc `null` khi Google, hàm cổng không cho. Lỗi Drive (`DriveError`) ném ra cho chỗ gọi.
 */
export async function ensureDriveStagingFolder(
  client: Pick<StaffSupabase, "rpc">,
  accountId: string,
  projectId: string,
  projectName: string,
  logTag: string,
): Promise<string | null> {
  const created = await createDriveFolder(accountId, `${APP_NAME} - ${projectName}${DRIVE_STAGING_SUFFIX}`);
  if (!created.folderId) {
    console.error(logTag, "create staging folder failed", created.status);
    return null;
  }
  const saved = await client.rpc("intercom_drive_staging_set", {
    p_gate: readDriveSecret("INTERCOM_DRIVE_GATE"),
    p_project: projectId,
    p_folder: created.folderId,
  });
  const current = saved.error ? null : saved.data;
  if (saved.error) console.error(logTag, "intercom_drive_staging_set failed", saved.error.code);
  if (typeof current !== "string" || current !== created.folderId) {
    await trashUnusedDriveFile(accountId, created.folderId, logTag);
  }
  return typeof current === "string" && DRIVE_FILE_ID_PATTERN.test(current) ? current : null;
}

/** Trả `null` khi xong, hoặc mã lỗi ngắn. Lỗi Drive ném ra. */
async function moveDriveFile(accountId: string, fileId: string, targetId: string, removeId: string | null): Promise<string | null> {
  if (![fileId, targetId, ...(removeId ? [removeId] : [])].every((id) => DRIVE_FILE_ID_PATTERN.test(id))) return "bad_file_id";
  const query = new URLSearchParams({ addParents: targetId, fields: "id" });
  if (removeId && removeId !== targetId) query.set("removeParents", removeId);
  const res = await fetchDrive(accountId, `${DRIVE_FILES_URL}/${fileId}?${query.toString()}`, {
    method: "PATCH",
    headers: { "content-type": "application/json; charset=UTF-8" },
    body: "{}",
  });
  await res.body?.cancel();
  return res.ok ? null : `http_${res.status}`;
}

export type DriveHandoverPlacement = {
  accountId: string;
  folderId: string;
  photoFileId: string;
  thumbFileId: string;
  /** Cha cần gỡ của từng tệp (thư mục tạm). */
  photoFrom: string | null;
  thumbFrom: string | null;
};

/**
 * Chuyển ảnh nén vào thư mục dự án, ảnh nhỏ vào `Thumbnail` (`addParents`, `removeParents`). Gọi lại khi đã
 * chuyển vẫn an toàn. Trả `null` khi xong, hoặc mã lỗi ngắn để ghi `move_last_error`; không ném.
 */
export async function placeDriveHandoverFiles(placement: DriveHandoverPlacement): Promise<string | null> {
  const { accountId, folderId } = placement;
  try {
    const photo = await moveDriveFile(accountId, placement.photoFileId, folderId, placement.photoFrom);
    if (photo) return photo;
    let thumbFolder = await resolveDriveSubFolder(accountId, folderId, DRIVE_THUMBS_FOLDER);
    if (!thumbFolder.folderId) return `subfolder_${thumbFolder.status}`;
    const thumb = await moveDriveFile(accountId, placement.thumbFileId, thumbFolder.folderId, placement.thumbFrom);
    if (thumb !== "http_404") return thumb;
    // Thư mục `Thumbnail` đã bị xoá hẳn mà cache còn giữ: tra lại, chuyển lại đúng một lần.
    forgetDriveSubFolder(folderId, DRIVE_THUMBS_FOLDER);
    thumbFolder = await resolveDriveSubFolder(accountId, folderId, DRIVE_THUMBS_FOLDER);
    if (!thumbFolder.folderId) return `subfolder_${thumbFolder.status}`;
    return await moveDriveFile(accountId, placement.thumbFileId, thumbFolder.folderId, placement.thumbFrom);
  } catch (error) {
    return error instanceof DriveError ? error.code : "unexpected";
  }
}

// Quyền tệp Drive

/** Một dòng lệch của `intercom_drive_permission_take`. */
export type DrivePermissionRow = {
  id: string;
  account_id: string;
  file_id: string;
  purpose: string;
  role: string;
  want: string;
  permission_id: string | null;
};

/** Lý do 403 của Google khi tài khoản không cho mở link công khai: không thử lại. */
function isCannotShareReason(reason: unknown): boolean {
  return typeof reason === "string" && (reason.startsWith("cannotShare") || reason === "publishOutNotPermitted");
}

function googleErrorReason(body: Record<string, unknown>): unknown {
  const error = body.error as { errors?: { reason?: unknown }[] } | undefined;
  return error?.errors?.[0]?.reason;
}

/**
 * Áp một dòng lên Drive: `on` là `permissions.create` `anyone`, `off` là `permissions.delete`. Trả `null` khi
 * xong, hoặc mã lỗi ngắn.
 */
async function applyDrivePermission(row: DrivePermissionRow): Promise<{ error: string | null; permissionId: string | null }> {
  if (!DRIVE_FILE_ID_PATTERN.test(row.file_id)) return { error: "bad_file_id", permissionId: null };
  try {
    if (row.want === "on") {
      const res = await fetchDrive(row.account_id, `${DRIVE_FILES_URL}/${row.file_id}/permissions?fields=id`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ type: "anyone", role: row.role, allowFileDiscovery: false }),
      });
      const body = await readJsonBody(res);
      if (res.ok && typeof body.id === "string") return { error: null, permissionId: body.id };
      if (res.status === 403 && isCannotShareReason(googleErrorReason(body))) return { error: "cannot_share", permissionId: null };
      return { error: `http_${res.status}`, permissionId: null };
    }
    // Chưa có mã quyền (chưa từng mở được) thì không có gì để gỡ.
    if (!row.permission_id || !DRIVE_FILE_ID_PATTERN.test(row.permission_id)) return { error: null, permissionId: null };
    const res = await fetchDrive(row.account_id, `${DRIVE_FILES_URL}/${row.file_id}/permissions/${row.permission_id}`, { method: "DELETE" });
    await res.body?.cancel();
    // 404: quyền đã bị gỡ tay trên Drive, coi là xong.
    if (res.ok || res.status === 404) return { error: null, permissionId: null };
    return { error: `http_${res.status}`, permissionId: null };
  } catch (error) {
    return { error: error instanceof DriveError ? error.code : "unexpected", permissionId: null };
  }
}

/**
 * Lấy các dòng quyền lệch của một dự án (`_take`) rồi áp từng dòng, ghi `_done` hoặc `_fail`. `projectId` null:
 * mọi dự án (route nhịp). Trả kết quả theo mục đích, để màn chọn câu.
 */
export async function runDrivePermissions(
  client: Pick<StaffSupabase, "rpc">,
  projectId: string | null,
  logTag: string,
): Promise<{ id: string; purpose: string; want: string; error: string | null }[]> {
  const gate = readDriveSecret("INTERCOM_DRIVE_GATE");
  const { data, error } = await client.rpc("intercom_drive_permission_take", { p_gate: gate, p_project: projectId });
  if (error) {
    console.error(logTag, "permission_take failed", error.code);
    throw new DriveError("drive_network");
  }
  const results: { id: string; purpose: string; want: string; error: string | null }[] = [];
  for (const row of (data ?? []) as DrivePermissionRow[]) {
    const applied = await applyDrivePermission(row);
    const saved = applied.error
      ? await client.rpc("intercom_drive_permission_fail", { p_gate: gate, p_id: row.id, p_error: applied.error })
      : await client.rpc("intercom_drive_permission_done", { p_gate: gate, p_id: row.id, p_permission_id: applied.permissionId });
    if (saved.error) console.error(logTag, "permission save failed", saved.error.code);
    results.push({ id: row.id, purpose: row.purpose, want: row.want, error: applied.error });
  }
  return results;
}

/** Đổi lỗi Drive sang phản hồi. Lỗi khác thì ném lại. */
export function driveErrorResponse(error: unknown, logTag: string): Response {
  if (!(error instanceof DriveError)) throw error;
  if (error.code === "drive_revoked") {
    return Response.json({ error: "Drive mất quyền, nối lại tài khoản Google.", reason: "drive_revoked" }, { status: 409 });
  }
  console.error(logTag, error.code);
  if (error.code === "drive_account_missing") {
    return Response.json({ error: "Không tìm thấy tài khoản Google.", reason: error.code }, { status: 404 });
  }
  if (error.code === "drive_config") {
    return Response.json({ error: "Drive chưa cấu hình xong.", reason: error.code }, { status: 500 });
  }
  return Response.json({ error: "Chưa gọi được Google Drive, thử lại giúp tôi.", reason: error.code }, { status: 502 });
}
