"use client";

// Lời gọi phía trình duyệt cho lựa chọn lưu Google Drive của intercom. Kho không có tệp kiểu sinh từ DB: `rpc`
// không gõ kiểu, tự ép ở đây. Không log địa chỉ phiên: ai có địa chỉ đó là ghi được tệp.

import { staffClient } from "@/adapters/auth";
import {
  IntercomUploadError,
  fetchIntercomText,
  postIntercomStep,
  toUploadReply,
  uploadIntercomHandover,
  watchIntercomHandoverDone,
  withIntercomUploadLog,
  type IntercomUploadMeta,
  type IntercomUploadReply,
  type IntercomUploadRetryOptions,
  type IntercomUploadTally,
} from "./staffIntercom";

// Nơi lưu

/** Một dòng `intercom_project_storage`. */
export type IntercomProjectStorage = {
  storage_kind: "r2" | "drive";
  is_pilot: boolean;
  account_status: "active" | "revoked" | null;
  account_id: string | null;
  folder_id: string | null;
  google_email: string | null;
  has_handover?: boolean;
};

export type StorageChoice = { kind: "r2" } | { kind: "drive"; accountId: string } | { kind: "drive_new" };

/** Một tài khoản Drive `active` để chọn (`intercom_drive_account_options`): chỉ mã và email. */
export type IntercomDriveAccountOption = { id: string; google_email: string };

export type IntercomDriveAccount = {
  id: string;
  google_email: string;
  status: "active" | "revoked";
  project_count: number;
};

/** Nơi lưu của dự án. Không qua quyền: `null`. Lỗi thì ném. */
export async function getIntercomProjectStorage(projectId: string): Promise<IntercomProjectStorage | null> {
  const { data, error } = await staffClient().rpc("intercom_project_storage", { p_project: projectId });
  if (error) throw new Error(error.message || "Chưa đọc được nơi lưu.");
  return ((data ?? []) as IntercomProjectStorage[])[0] ?? null;
}

/** Lỗi thì ném. */
export async function listIntercomDriveAccountOptions(): Promise<IntercomDriveAccountOption[]> {
  const { data, error } = await staffClient().rpc("intercom_drive_account_options");
  if (error) throw new Error(error.message || "Chưa đọc được tài khoản Google.");
  return (data ?? []) as IntercomDriveAccountOption[];
}

/** Có lượt rồi thì máy chủ từ chối, ném câu máy chủ trả. */
export async function setIntercomProjectStorageR2(projectId: string): Promise<void> {
  const { error } = await staffClient().rpc("intercom_project_set_storage", {
    p_project: projectId,
    p_kind: "r2",
    p_account: null,
    p_folder: null,
  });
  if (error) throw new Error(error.message || "Chưa đổi được nơi lưu.");
}

/** Tài khoản Google đã nối. Chỉ quản lý gọi được. */
export async function listIntercomDriveAccounts(): Promise<IntercomDriveAccount[]> {
  const { data, error } = await staffClient().rpc("intercom_drive_account_list");
  if (error) throw new Error(error.message || "Chưa đọc được tài khoản Google.");
  return ((data ?? []) as IntercomDriveAccount[]).map((row) => ({ ...row, project_count: Number(row.project_count) }));
}

/**
 * Câu cho hộp xác nhận xoá, `null` khi không dự án nào lưu Drive. Email lấy từ `intercom_project_storage`; thiếu
 * email thì "của dự án". Lỗi thì ném.
 */
export async function getIntercomDriveTrashNote(projectIds: string[]): Promise<string | null> {
  const rows = await Promise.all(projectIds.map(getIntercomProjectStorage));
  const driveRows = rows.filter((row) => row?.storage_kind === "drive");
  if (driveRows.length === 0) return null;
  const emails = [...new Set(driveRows.map((row) => row?.google_email).filter(Boolean))];
  return `Ảnh cũng vào thùng rác Google Drive của ${emails.length > 0 ? emails.join(", ") : "dự án"}.`;
}

/** Số của Monitor (`intercom_drive_monitor`). Chỉ quản lý đọc được; người khác nhận `null`. */
export type IntercomDriveMonitor = {
  waiting_count: number;
  missed_count: number;
  reasons: { reason: string; count: number }[];
  fallback_pending?: number;
  /** Lượt có tệp Drive chưa vào thư mục dự án. */
  place_pending?: number;
  /** Dòng quyền Drive chưa áp được. */
  permission_failed?: number;
  /** Số dự án dính tài khoản Google mất quyền. */
  revoked_projects?: number;
};

export async function getIntercomDriveMonitor(): Promise<IntercomDriveMonitor | null> {
  const { data, error } = await staffClient().rpc("intercom_drive_monitor");
  if (error?.code === "42501") return null;
  if (error) throw new Error(error.message || "Chưa đọc được hàng đợi thùng rác.");
  return data as IntercomDriveMonitor;
}

/**
 * Chạy một lượt hàng đợi thùng rác; `retry` đặt lại số lần thử của mọi tài khoản trước khi chạy. Chỉ quản lý.
 * Lỗi thì ném câu máy chủ trả.
 */
export async function runIntercomDriveQueue(retry = false): Promise<{ finished: number; failed: number }> {
  const { status, json } = await postDriveRoute("/api/intercom/drive/queue", { retry });
  if (status !== 200) throw new Error(typeof json.error === "string" ? json.error : "Chưa chạy được hàng đợi thùng rác.");
  return { finished: Number(json.finished) || 0, failed: Number(json.failed) || 0 };
}

/**
 * Đường bắt đầu nối Google: điều hướng cả trang, không `fetch`. `attach`: nối xong thì tự gắn tài khoản vào dự
 * án, tạo thư mục.
 */
export function intercomDriveConnectUrl(projectId: string, opts?: { attach?: boolean }): string {
  return `/api/intercom/drive/connect?project=${projectId}${opts?.attach ? "&attach=1" : ""}`;
}

async function postDriveRoute(path: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    const value: unknown = await res.json();
    if (value && typeof value === "object" && !Array.isArray(value)) json = value as Record<string, unknown>;
  } catch {
    // Phản hồi không phải JSON: dùng mã trạng thái.
  }
  return { status: res.status, json };
}

/**
 * Sau khi bật, thu hồi link khách: chạy ngay việc đưa quyền thư mục Drive về `want`. Không ném: lỗi thì nhịp hẹn
 * giờ làm lại. `none`: dự án không có dòng quyền thư mục (chưa từng bật link, chưa nối Drive).
 */
export async function applyIntercomDriveShare(projectId: string): Promise<"ok" | "cannot_share" | "failed" | "none"> {
  try {
    const { status, json } = await postDriveRoute(`/api/intercom/drive/permission/${projectId}`, {});
    if (status !== 200) return "failed";
    const value = json.folder_share;
    return value === "ok" || value === "cannot_share" || value === "none" ? value : "failed";
  } catch {
    return "failed";
  }
}

/** Chọn tài khoản cho dự án: Worker tạo thư mục rồi `set_storage`. Lỗi thì ném câu máy chủ trả. */
export async function chooseIntercomDriveAccount(projectId: string, accountId: string): Promise<void> {
  const { status, json } = await postDriveRoute("/api/intercom/drive/folder", { project_id: projectId, account_id: accountId });
  if (status < 200 || status >= 300) {
    throw new Error(typeof json.error === "string" ? json.error : "Chưa chọn được tài khoản, thử lại giúp tôi.");
  }
}

// Màn đo

export type DriveBenchSession =
  | { ok: true; fileId: string; sessionUrl: string; accountId: string; googleStatus: number }
  | { ok: false; httpStatus: number; step: string | null; googleStatus: number | null; message: string };

export async function createDriveBenchSession(input: {
  projectId: string;
  bytes: number;
  fileId?: string;
  omitOrigin?: boolean;
}): Promise<DriveBenchSession> {
  const { status, json } = await postDriveRoute("/api/intercom/drive/bench/session", {
    project_id: input.projectId,
    bytes: input.bytes,
    file_id: input.fileId ?? null,
    omit_origin: input.omitOrigin === true,
  });
  if (json.ok === true && typeof json.file_id === "string" && typeof json.session_url === "string" && typeof json.account_id === "string") {
    return {
      ok: true,
      fileId: json.file_id,
      sessionUrl: json.session_url,
      accountId: json.account_id,
      googleStatus: typeof json.google_status === "number" ? json.google_status : status,
    };
  }
  return {
    ok: false,
    httpStatus: status,
    step: typeof json.step === "string" ? json.step : null,
    googleStatus: typeof json.google_status === "number" ? json.google_status : null,
    message: typeof json.error === "string" ? json.error : "Chưa tạo được phiên.",
  };
}

export type DriveFileProbe = {
  httpStatus: number;
  googleStatus: number | null;
  size: number | null;
  md5: string | null;
  inTrash: boolean;
};

export async function probeDriveFile(projectId: string, fileId: string): Promise<DriveFileProbe> {
  const { status, json } = await postDriveRoute("/api/intercom/drive/bench/probe", { project_id: projectId, file_id: fileId });
  return {
    httpStatus: status,
    googleStatus: typeof json.google_status === "number" ? json.google_status : null,
    size: typeof json.size === "number" ? json.size : null,
    md5: typeof json.md5 === "string" ? json.md5 : null,
    inTrash: json.in_trash === true,
  };
}

export const DRIVE_PUT_TIMEOUT_MS = 120000;

/**
 * `blocked`: không đọc được phản hồi (đứt mạng hoặc CORS chặn, trình duyệt không phân biệt). `range`: `null` khi
 * không có hoặc CORS giấu.
 */
export type DriveSessionReply =
  | { kind: "reply"; status: number; range: string | null }
  | { kind: "blocked" }
  | { kind: "timeout" }
  | { kind: "stopped" };

/**
 * Gọi địa chỉ phiên, viết riêng vì `fetchIntercomText` không trả header. Không kèm cookie: đây là tên miền
 * Google.
 */
async function sendToDriveSession(sessionUrl: string, init: RequestInit, signal?: AbortSignal): Promise<DriveSessionReply> {
  // Tín hiệu đã huỷ thì sự kiện "abort" không chạy nữa: gắn nghe ở dưới vô tác dụng, `PUT` sẽ chạy trọn.
  if (signal?.aborted) return { kind: "stopped" };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DRIVE_PUT_TIMEOUT_MS);
  const forwardAbort = () => controller.abort();
  signal?.addEventListener("abort", forwardAbort);
  try {
    const res = await fetch(sessionUrl, { ...init, method: "PUT", credentials: "omit", signal: controller.signal });
    try {
      await res.text();
    } catch {
      // Phản hồi tới mà mất thân: dùng mã trạng thái.
    }
    return { kind: "reply", status: res.status, range: res.headers.get("range") };
  } catch {
    if (signal?.aborted) return { kind: "stopped" };
    return timedOut ? { kind: "timeout" } : { kind: "blocked" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

/** Gửi một đoạn của ảnh; thiếu `range` là gửi trọn. Đoạn giữa chừng phải là bội của 256 KB. */
export function putDriveSession(
  sessionUrl: string,
  blob: Blob,
  options: { range?: { start: number; end: number }; signal?: AbortSignal } = {},
): Promise<DriveSessionReply> {
  const { range, signal } = options;
  const headers: Record<string, string> = { "content-type": "image/jpeg" };
  if (range) headers["content-range"] = `bytes ${range.start}-${range.end - 1}/${blob.size}`;
  return sendToDriveSession(sessionUrl, { headers, body: range ? blob.slice(range.start, range.end) : blob }, signal);
}

// Hỏi phiên đã nhận tới đâu: `PUT` rỗng kèm `Content-Range: bytes */<cỡ>`.
export function askDriveSessionProgress(sessionUrl: string, totalBytes: number): Promise<DriveSessionReply> {
  return sendToDriveSession(sessionUrl, { headers: { "content-range": `bytes */${totalBytes}` } });
}

export type DriveBenchLogRow = {
  runId: string;
  projectId: string;
  accountId: string;
  seq: number | null;
  bytes: number;
  ms: number | null;
  attempts: number;
  outcome: string;
  error: string | null;
  device: string;
  network: string;
  uploadMode: string;
  fileId: string | null;
};

export async function logDriveBench(row: DriveBenchLogRow): Promise<void> {
  const { error } = await staffClient().rpc("intercom_drive_bench_log", {
    p_run: row.runId,
    p_project: row.projectId,
    p_account: row.accountId,
    p_seq: row.seq,
    p_bytes: row.bytes,
    p_ms: row.ms,
    p_attempts: row.attempts,
    p_outcome: row.outcome,
    p_error: row.error,
    p_device: row.device,
    p_network: row.network,
    p_upload_mode: row.uploadMode,
    p_file_id: row.fileId,
  });
  if (error) throw new Error(error.message || "Chưa ghi được số đo.");
}

/** Đưa tệp đo của một lượt vào hàng đợi thùng rác. Trả số tệp mới vào hàng. */
export async function trashDriveBenchRun(runId: string): Promise<number> {
  const { data, error } = await staffClient().rpc("intercom_drive_bench_trash", { p_run: runId });
  if (error) throw new Error(error.message || "Chưa đưa được tệp đo vào thùng rác.");
  return typeof data === "number" ? data : 0;
}

// Tải lượt thật

const DRIVE_UPLOAD_ROUTE = "/api/intercom/drive/upload";
/** Số lần gửi tối đa của một tệp và của `finish` khi hỏng mức mạng. */
const DRIVE_SEND_ATTEMPTS = 3;
const DRIVE_RETRY_DELAYS_MS = [1000, 2000];
/** Vòng hỏi trạng thái vẫn chạy song song. */
const DRIVE_FINISH_TIMEOUT_MS = 30000;
const DRIVE_UPLOAD_FAILED_TEXT = "Chưa tải được ảnh lên Google Drive, thử lại giúp tôi.";

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Google từ chối tệp: tự dựng 502, không đưa mã Google qua `toUploadReply`, để màn giữ `handover_id` và còn Thử
 * lại.
 */
function driveUploadFailure(): IntercomUploadReply {
  return { ok: false, status: 502, alreadyDone: false, result: null, error: DRIVE_UPLOAD_FAILED_TEXT };
}

/** Phiên đã nhận đủ tệp. `409` là phiên đã xong từ lần gửi trước. */
function isDriveFileStored(status: number): boolean {
  return status === 200 || status === 201 || status === 409;
}

/** Byte kế tiếp cần gửi, đọc từ `Range: bytes=0-<cuối>` của phản hồi 308. Thiếu hoặc lạ dạng thì `null`. */
function nextDriveOffset(range: string | null, totalBytes: number): number | null {
  const match = range ? /^bytes=0-(\d+)$/.exec(range) : null;
  if (!match) return null;
  const next = Number(match[1]) + 1;
  return next > 0 && next < totalBytes ? next : null;
}

/**
 * Gửi một tệp lên địa chỉ phiên. Hỏng mạng, Google 5xx hay 308 khi đã gửi trọn: hỏi phiên đã nhận tới đâu rồi
 * gửi tiếp, tối đa 3 lần. Hỏi không được (CORS giấu hoặc chặn) thì gửi trọn lại. Trả `null` khi đã lên; Google
 * từ chối thì trả mã Google trả lần cuối; hỏng mạng hết lượt thì ném `IntercomUploadError`.
 */
async function sendDriveFile(sessionUrl: string, file: Blob, tally: IntercomUploadTally): Promise<number | null> {
  let range: { start: number; end: number } | undefined;
  for (let attempt = 1; ; attempt += 1) {
    tally.attempts += 1;
    // Blob tạo lại từ bytes mỗi lần: WebKit hỏng khi dùng lại thân của lần trước.
    const body = new Blob([await file.arrayBuffer()], { type: "image/jpeg" });
    const reply = await putDriveSession(sessionUrl, body, { range });
    if (reply.kind === "reply") {
      if (isDriveFileStored(reply.status)) return null;
      if (reply.status !== 308 && reply.status < 500) return reply.status;
    }
    if (attempt >= DRIVE_SEND_ATTEMPTS) {
      if (reply.kind === "reply") return reply.status;
      throw new IntercomUploadError(reply.kind === "timeout" ? "part-timeout" : "part-error", attempt);
    }
    await waitMs(DRIVE_RETRY_DELAYS_MS[attempt - 1] ?? 2000);

    range = undefined;
    const progress = await askDriveSessionProgress(sessionUrl, file.size);
    if (progress.kind === "reply") {
      if (isDriveFileStored(progress.status)) return null;
      if (progress.status !== 308 && progress.status < 500) return progress.status;
      const start = progress.status === 308 ? nextDriveOffset(progress.range, file.size) : null;
      if (start !== null) range = { start, end: file.size };
    }
  }
}

/** Địa chỉ phiên từ phản hồi `start`; `null` là tệp đã lên, bỏ qua `PUT`. Sai dạng thì trả `null` cả cụm. */
function readDriveSessions(text: string): { photo: string | null; thumb: string | null } | null {
  try {
    const data = JSON.parse(text) as { photo_session_url?: unknown; thumb_session_url?: unknown };
    const photo = data.photo_session_url;
    const thumb = data.thumb_session_url;
    if ((typeof photo !== "string" && photo !== null) || (typeof thumb !== "string" && thumb !== null)) return null;
    return { photo, thumb };
  } catch {
    return null;
  }
}

/**
 * Bỏ đoạn APP1 (EXIF, XMP) và APP13 (IPTC) của JPEG, giữ nguyên phần ảnh từ SOS trở đi. Cấu trúc đoạn hỏng thì
 * trả `null`.
 */
function stripDriveJpegMetadata(src: Uint8Array): Uint8Array<ArrayBuffer> | null {
  const parts: Uint8Array[] = [src.subarray(0, 2)];
  let i = 2;
  while (i < src.length) {
    if (src[i] !== 0xff) return null;
    let marker = src[i + 1];
    let start = i;
    // Byte đệm 0xFF liền nhau trước mã đoạn là hợp lệ.
    while (marker === 0xff && start + 2 < src.length) {
      start += 1;
      marker = src[start + 1];
    }
    if (marker === undefined) return null;
    if (marker === 0xda || marker === 0xd9) {
      parts.push(src.subarray(start));
      break;
    }
    if (start + 3 >= src.length) return null;
    const segEnd = start + 2 + ((src[start + 2] << 8) | src[start + 3]);
    if (segEnd > src.length) return null;
    if (marker !== 0xe1 && marker !== 0xed) parts.push(src.subarray(start, segEnd));
    i = segEnd;
  }
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/**
 * Soát như `checkJpeg` ở `upload/finish/route.ts`, cùng câu chữ: đầu tệp, cấu trúc đoạn, tệp rỗng. Đạt thì trả
 * Blob mới đã bỏ siêu dữ liệu.
 */
export async function prepareDriveJpeg(source: Blob): Promise<{ ok: true; blob: Blob } | { ok: false; error: string }> {
  const raw = new Uint8Array(await source.arrayBuffer());
  if (raw.byteLength < 3 || raw[0] !== 0xff || raw[1] !== 0xd8 || raw[2] !== 0xff) return { ok: false, error: "Chỉ nhận ảnh JPEG." };
  const content = stripDriveJpegMetadata(raw);
  if (!content || content.byteLength === 0) return { ok: false, error: "Ảnh JPEG bị hỏng, chụp lại giúp tôi." };
  return { ok: true, blob: new Blob([content], { type: "image/jpeg" }) };
}

export type IntercomDriveUploadReply = IntercomUploadReply & { storedOnR2?: boolean };

export const INTERCOM_STORED_ON_R2_TEXT = "Đã lưu tạm, sẽ chuyển sang Drive khi Drive hoạt động lại.";

/** Lý do route trả kèm (`reason`), để nhận ra Drive lỗi. Thân hỏng thì `null`. */
function readReplyReason(text: string): string | null {
  try {
    const data = JSON.parse(text) as { reason?: unknown };
    return typeof data.reason === "string" ? data.reason : null;
  } catch {
    return null;
  }
}

/**
 * "Drive lỗi": route `start`, `finish` trả 502 `drive_network` hoặc 503 `drive_revoked`; `start` trả 409
 * `storage_fallback`. 409 thiếu tài khoản, thư mục không rơi về.
 */
function isDriveRouteFault(status: number, text: string): boolean {
  const reason = readReplyReason(text);
  return (
    (status === 502 && reason === "drive_network") ||
    (status === 503 && reason === "drive_revoked") ||
    (status === 409 && reason === "storage_fallback")
  );
}

/** "Drive lỗi": `PUT` lên Google trả 403 (gồm hết dung lượng) hoặc từ 500 trở lên. */
function isDrivePutFault(status: number): boolean {
  return status === 403 || status >= 500;
}

/** Thân của `uploadIntercomHandoverDrive`. `tally` đếm mọi lần gửi ở `start`, `PUT`, `finish`. */
async function sendIntercomHandoverDirect(
  input: { meta: IntercomUploadMeta; file: Blob; thumb: Blob },
  tally: IntercomUploadTally,
  onProgress?: (fraction: number) => void,
): Promise<{ reply: IntercomUploadReply; driveFault: boolean }> {
  const { meta, file, thumb } = input;
  const failed = (driveFault: boolean) => ({ reply: driveUploadFailure(), driveFault });

  const startRaw = await postIntercomStep(
    `${DRIVE_UPLOAD_ROUTE}/start`,
    JSON.stringify({ ...meta, photo_size: file.size, thumb_size: thumb.size }),
    tally,
  );
  const startReply = toUploadReply(startRaw.status, startRaw.text);
  if (!startReply.ok || startReply.alreadyDone) {
    return { reply: startReply, driveFault: !startReply.ok && isDriveRouteFault(startRaw.status, startRaw.text) };
  }
  const sessions = readDriveSessions(startRaw.text);
  if (!sessions) return failed(false);

  // `fetch` không báo tiến độ lúc gửi: thanh tiến độ nhảy theo từng tệp.
  const totalBytes = Math.max(1, file.size + thumb.size);
  const photoRefused = sessions.photo ? await sendDriveFile(sessions.photo, file, tally) : null;
  if (photoRefused !== null) return failed(isDrivePutFault(photoRefused));
  onProgress?.(Math.min(0.99, file.size / totalBytes));
  const thumbRefused = sessions.thumb ? await sendDriveFile(sessions.thumb, thumb, tally) : null;
  if (thumbRefused !== null) return failed(isDrivePutFault(thumbRefused));
  onProgress?.(1);

  const finishBody = JSON.stringify({
    handover_id: meta.handover_id,
    width: meta.width ?? null,
    height: meta.height ?? null,
    // Tệp bỏ qua `PUT` thì không khai cỡ: máy chủ không so, để khỏi huỷ oan.
    photo_size: sessions.photo ? file.size : null,
    thumb_size: sessions.thumb ? thumb.size : null,
  });
  const watch = watchIntercomHandoverDone(meta);
  watch.start();
  try {
    for (let attempt = 1; ; attempt += 1) {
      tally.attempts += 1;
      let abortSend: (() => void) | null = null;
      const sending = fetchIntercomText(
        `${DRIVE_UPLOAD_ROUTE}/finish`,
        { method: "POST", headers: { "content-type": "application/json" }, body: finishBody },
        DRIVE_FINISH_TIMEOUT_MS,
        { error: "fetch-error", timeout: "fetch-timeout" },
        (abort) => {
          abortSend = abort;
        },
      );
      // Vòng hỏi thắng thì lượt gửi bị huỷ và ném lỗi sau đó: nuốt để không thành lỗi chưa bắt.
      sending.catch(() => {});
      try {
        const winner = await Promise.race([
          sending.then((value) => ({ polled: null, value })),
          watch.done.then((reply) => ({ polled: reply, value: null })),
        ]);
        if (winner.polled) {
          (abortSend as (() => void) | null)?.();
          return { reply: winner.polled, driveFault: false };
        }
        const sent = winner.value as { status: number; text: string };
        return { reply: toUploadReply(sent.status, sent.text), driveFault: isDriveRouteFault(sent.status, sent.text) };
      } catch (e) {
        if (!(e instanceof IntercomUploadError)) throw e;
        if (attempt >= DRIVE_SEND_ATTEMPTS) throw new IntercomUploadError(e.reason, attempt);
        await waitMs(DRIVE_RETRY_DELAYS_MS[attempt - 1] ?? 2000);
      }
    }
  } finally {
    watch.stop();
  }
}

/** Hàm báo lỗi có mã thì 502 để còn Thử lại; chưa tới được máy chủ thì ném lỗi mạng. */
async function storeHandoverOnR2(
  input: { meta: IntercomUploadMeta; file: Blob; thumb: Blob },
  timeoutMs?: number,
  onProgress?: (fraction: number) => void,
  options?: IntercomUploadRetryOptions,
): Promise<IntercomDriveUploadReply> {
  const { error } = await staffClient().rpc("intercom_handover_fallback_r2", { p_handover: input.meta.handover_id });
  if (error) {
    if (!error.code) throw new IntercomUploadError("fetch-error");
    return {
      ok: false,
      status: error.code === "42501" ? 403 : 502,
      alreadyDone: false,
      result: null,
      error: error.message || DRIVE_UPLOAD_FAILED_TEXT,
    };
  }
  const reply = await uploadIntercomHandover(input, timeoutMs, onProgress, options);
  return reply.ok ? { ...reply, storedOnR2: true } : reply;
}

export async function uploadIntercomHandoverDrive(
  input: { meta: IntercomUploadMeta; file: Blob; thumb: Blob },
  timeoutMs?: number,
  onProgress?: (fraction: number) => void,
  options?: IntercomUploadRetryOptions,
): Promise<IntercomDriveUploadReply> {
  // Gỡ một lần, trước nhật ký: `photo_bytes`, `thumb_bytes`, cỡ khai với Worker và Google đều theo tệp đã gỡ.
  let photo: Awaited<ReturnType<typeof prepareDriveJpeg>>;
  let smallPhoto: Awaited<ReturnType<typeof prepareDriveJpeg>>;
  try {
    photo = await prepareDriveJpeg(input.file);
    smallPhoto = await prepareDriveJpeg(input.thumb);
  } catch (error) {
    return withIntercomUploadLog(input, "direct", () => Promise.reject(error));
  }
  if (!photo.ok || !smallPhoto.ok) {
    const error = !photo.ok ? photo.error : smallPhoto.ok ? null : smallPhoto.error;
    return withIntercomUploadLog(input, "direct", async () => ({ ok: false, status: 415, alreadyDone: false, result: null, error }));
  }
  const stripped = { meta: input.meta, file: photo.blob, thumb: smallPhoto.blob };
  let driveFault = false;
  const reply = await withIntercomUploadLog(stripped, "direct", async (tally) => {
    const sent = await sendIntercomHandoverDirect(stripped, tally, onProgress);
    driveFault = sent.driveFault;
    return sent.reply;
  });
  return driveFault ? storeHandoverOnR2(input, timeoutMs, onProgress, options) : reply;
}
