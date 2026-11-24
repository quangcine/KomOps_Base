"use client";

// Lời gọi phía trình duyệt cho màn Monitor của intercom.
// - Nhật ký đường truyền app: `staffIntercom.ts` gọi `recordIntercomUploadLog` cuối mỗi lần tải. Lỗi mạng thì để
// lại hàng chờ, lần sau gửi tiếp; gửi được thì bỏ cả dòng đã ghi lẫn dòng bị hàm bỏ (dòng không qua cửa không kẹt
// hàng chờ). Hàm gác TỪNG dòng theo `project_id`. Tên tham số RPC là KHOÁ object: sai tên thì `tsc` xanh mà chạy
// lỗi `PGRST202`.

import { staffClient } from "@/adapters/auth";

// Nhật ký gửi ảnh

/** Một dòng nhật ký gửi ảnh, khớp tham số `p_rows` của `intercom_upload_log_add`. */
export type IntercomUploadLogRow = {
  handover_id: string;
  project_id: string | null;
  kind: "deliver" | "collect";
  started_at: string;
  finished_at: string;
  duration_ms: number;
  photo_bytes: number;
  thumb_bytes: number;
  attempts: number;
  method: "chunk" | "single" | "direct";
  outcome: "ok" | "fail";
  fail_reason: string | null;
  device: string | null;
  network: string | null;
};

type QueuedUploadLogRow = IntercomUploadLogRow & { queue_id: string };

const UPLOAD_LOG_QUEUE_KEY = "intercom.uploadlog.v1";
const UPLOAD_LOG_QUEUE_MAX = 50;
/** Trần dòng mỗi lượt gọi `intercom_upload_log_add` (hàm từ chối quá 20). */
const UPLOAD_LOG_BATCH = 20;
const DEVICE_MAX_CHARS = 120;

function readQueue(): QueuedUploadLogRow[] {
  try {
    const raw = window.localStorage.getItem(UPLOAD_LOG_QUEUE_KEY);
    if (!raw) return [];
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter(
      (row): row is QueuedUploadLogRow =>
        !!row && typeof row === "object" && typeof (row as { queue_id?: unknown }).queue_id === "string",
    );
  } catch {
    return [];
  }
}

function writeQueue(rows: QueuedUploadLogRow[]): void {
  try {
    window.localStorage.setItem(UPLOAD_LOG_QUEUE_KEY, JSON.stringify(rows.slice(-UPLOAD_LOG_QUEUE_MAX)));
  } catch {
    // Hết chỗ hoặc chế độ riêng tư: bỏ nhật ký, không ảnh hưởng luồng tải.
  }
}

/** Tóm tắt user agent cho cột `device` (tối đa 120 ký tự): máy, hệ điều hành, trình duyệt. */
export function summarizeUserAgent(ua: string): string {
  const parts: string[] = [];
  const ios = /\b(iPhone|iPad|iPod)\b.*?OS (\d+)[_.](\d+)/.exec(ua);
  const android = /Android (\d+(?:\.\d+)?)/.exec(ua);
  if (ios) parts.push(`${ios[1]} iOS ${ios[2]}.${ios[3]}`);
  else if (android) parts.push(`Android ${android[1]}`);
  else if (/Macintosh/.test(ua)) parts.push("Mac");
  else if (/Windows/.test(ua)) parts.push("Windows");
  else if (/Linux/.test(ua)) parts.push("Linux");
  const browser =
    /\b(CriOS|EdgiOS|FxiOS|Edg|OPR|SamsungBrowser|Zalo|FBAN|Instagram)\/?\s?([\d.]+)?/.exec(ua) ??
    /\b(Chrome|Firefox)\/([\d.]+)/.exec(ua) ??
    /Version\/([\d.]+).*\bSafari\//.exec(ua);
  if (browser) {
    if (browser[0].startsWith("Version/")) parts.push(`Safari ${browser[1]}`);
    else parts.push(browser[2] ? `${browser[1]} ${browser[2].split(".")[0]}` : browser[1]);
  }
  const summary = parts.length > 0 ? parts.join(" · ") : ua;
  return summary.slice(0, DEVICE_MAX_CHARS);
}

/** Đọc máy và mạng hiện tại cho dòng nhật ký; thiếu API thì `null`. */
export function currentIntercomDeviceInfo(): { device: string | null; network: string | null } {
  try {
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    const connection = (navigator as Navigator & { connection?: { effectiveType?: unknown } }).connection;
    const network = typeof connection?.effectiveType === "string" ? connection.effectiveType.slice(0, 20) : null;
    return { device: ua ? summarizeUserAgent(ua) : null, network };
  } catch {
    return { device: null, network: null };
  }
}

let flushing = false;

/**
 * Gửi bù hàng chờ nhật ký (từng lượt 20 dòng). Lỗi mạng hoặc lỗi hàm thì dừng, giữ hàng chờ. Gửi được một lượt
 * thì bỏ khỏi hàng chờ mọi dòng của lượt đó (`written` cộng `skipped`). Không ném lỗi.
 */
export async function flushIntercomUploadLog(): Promise<void> {
  if (flushing || typeof window === "undefined") return;
  flushing = true;
  try {
    for (;;) {
      const batch = readQueue().slice(0, UPLOAD_LOG_BATCH);
      if (batch.length === 0) return;
      const rows = batch.map(({ queue_id: _queueId, ...row }) => row);
      const { error } = await staffClient().rpc("intercom_upload_log_add", { p_rows: rows });
      if (error) return;
      const sent = new Set(batch.map((row) => row.queue_id));
      writeQueue(readQueue().filter((row) => !sent.has(row.queue_id)));
    }
  } catch {
    // Mất mạng giữa chừng: để lại hàng chờ cho lần sau.
  } finally {
    flushing = false;
  }
}

let onlineListenerBound = false;

/** Ghi một dòng nhật ký gửi ảnh vào hàng chờ rồi gửi bù (không chờ). Không bao giờ ném lỗi. */
export function recordIntercomUploadLog(row: IntercomUploadLogRow): void {
  try {
    if (typeof window === "undefined") return;
    // Lượt hỏng vì mất mạng: có mạng lại thì gửi bù ngay, không chờ lần tải sau.
    if (!onlineListenerBound) {
      onlineListenerBound = true;
      window.addEventListener("online", () => void flushIntercomUploadLog());
    }
    const queueId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    writeQueue([...readQueue(), { ...row, queue_id: queueId }]);
    void flushIntercomUploadLog();
  } catch {
    // Nhật ký là phần thêm: hỏng thì bỏ.
  }
}

// Số liệu Monitor

export class IntercomMonitorNoSeatError extends Error {
  constructor() {
    super("Chỉ nhân viên được xem");
    this.name = "IntercomMonitorNoSeatError";
  }
}

/** Số theo DB của một dự án (`intercom_monitor_stats.projects`). */
export type IntercomMonitorProject = {
  project_id: string;
  name: string;
  start_date: string;
  last_date: string;
  /** Ngày VN đầu tiên dọn được ảnh gốc. */
  originals_open_from: string;
  done_count: number;
  pending_count: number;
  /** Lượt `pending` có `created_at` quá 1 giờ (Dọn loại 2). */
  pending_stale_count: number;
  /** Tổng `size_bytes` ảnh gốc các lượt `done`. */
  done_bytes: number;
  purged_count: number;
  /** Lượt dọn được ảnh gốc ngay bây giờ (0 khi chưa qua ngày cuối 7 ngày). */
  purgeable_count: number;
  purgeable_bytes: number;
};

/** Đường lưu ảnh theo cột `method`: `r2` là `chunk`, `single`; `drive` là `direct`. */
export type IntercomUploadStorage = "r2" | "drive";

export type IntercomMonitorTraffic = {
  sends: number;
  ok_count: number;
  median_ms: number | null;
  p90_ms: number | null;
  /** KB/s trung bình của các lần thành công: `(photo_bytes + thumb_bytes) / duration_ms`. */
  average_speed: number | null;
  mean_attempts: number | null;
  fail_reasons: { reason: string; count: number }[];
  devices: { device: string; sends: number; ok_count: number; median_ms: number | null; average_speed: number | null }[];
};

export type IntercomMonitorRecentSend = {
  started_at: string;
  project_name: string | null;
  kind: "deliver" | "collect";
  method: "chunk" | "single" | "direct";
  outcome: "ok" | "fail";
  fail_reason: string | null;
  duration_ms: number;
  photo_bytes: number;
  thumb_bytes: number;
  attempts: number;
  device: string | null;
  network: string | null;
  created_by_name: string | null;
};

export type IntercomMonitorStats = {
  since: string;
  projects: IntercomMonitorProject[];
  traffic: IntercomMonitorTraffic;
  recent: IntercomMonitorRecentSend[];
  /** Số, danh sách gần nhất tách theo đường lưu. */
  by_storage: Record<IntercomUploadStorage, { traffic: IntercomMonitorTraffic; recent: IntercomMonitorRecentSend[] }> | null;
};

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseTraffic(raw: Record<string, unknown>): IntercomMonitorTraffic {
  return {
    sends: toNumber(raw.sends),
    ok_count: toNumber(raw.ok_count),
    median_ms: toNullableNumber(raw.median_ms),
    p90_ms: toNullableNumber(raw.p90_ms),
    average_speed: toNullableNumber(raw.average_speed),
    mean_attempts: toNullableNumber(raw.mean_attempts),
    fail_reasons: ((Array.isArray(raw.fail_reasons) ? raw.fail_reasons : []) as Record<string, unknown>[]).map((r) => ({
      reason: String(r.reason ?? ""),
      count: toNumber(r.count),
    })),
    devices: ((Array.isArray(raw.devices) ? raw.devices : []) as Record<string, unknown>[]).map((d) => ({
      device: String(d.device ?? ""),
      sends: toNumber(d.sends),
      ok_count: toNumber(d.ok_count),
      median_ms: toNullableNumber(d.median_ms),
      average_speed: toNullableNumber(d.average_speed),
    })),
  };
}

function parseRecent(raw: unknown): IntercomMonitorRecentSend[] {
  return (Array.isArray(raw) ? raw : []) as IntercomMonitorRecentSend[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Số liệu Monitor từ `p_since`. */
export async function getIntercomMonitorStats(since: Date): Promise<IntercomMonitorStats> {
  const { data, error } = await staffClient().rpc("intercom_monitor_stats", { p_since: since.toISOString() });
  if (error) {
    if (error.code === "42501") throw new IntercomMonitorNoSeatError();
    throw new Error(error.message || "Chưa tải được số liệu Monitor.");
  }
  const raw = (data ?? {}) as {
    since?: unknown;
    projects?: unknown;
    traffic?: Record<string, unknown>;
    recent?: unknown;
    by_storage?: unknown;
  };
  const byStorageRaw = raw.by_storage;
  const r2Raw = isRecord(byStorageRaw) ? byStorageRaw.r2 : undefined;
  const driveRaw = isRecord(byStorageRaw) ? byStorageRaw.drive : undefined;
  const byStorage: IntercomMonitorStats["by_storage"] =
    isRecord(r2Raw) && isRecord(driveRaw)
      ? {
          r2: { traffic: parseTraffic(isRecord(r2Raw.traffic) ? r2Raw.traffic : {}), recent: parseRecent(r2Raw.recent) },
          drive: {
            traffic: parseTraffic(isRecord(driveRaw.traffic) ? driveRaw.traffic : {}),
            recent: parseRecent(driveRaw.recent),
          },
        }
      : null;
  const projects = (Array.isArray(raw.projects) ? raw.projects : []) as Record<string, unknown>[];
  return {
    since: String(raw.since ?? since.toISOString()),
    projects: projects.map((p) => ({
      project_id: String(p.project_id),
      name: String(p.name ?? ""),
      start_date: String(p.start_date ?? ""),
      last_date: String(p.last_date ?? ""),
      originals_open_from: String(p.originals_open_from ?? ""),
      done_count: toNumber(p.done_count),
      pending_count: toNumber(p.pending_count),
      pending_stale_count: toNumber(p.pending_stale_count),
      done_bytes: toNumber(p.done_bytes),
      purged_count: toNumber(p.purged_count),
      purgeable_count: toNumber(p.purgeable_count),
      purgeable_bytes: toNumber(p.purgeable_bytes),
    })),
    traffic: parseTraffic(raw.traffic ?? {}),
    recent: parseRecent(raw.recent),
    by_storage: byStorage,
  };
}

const MONITOR_ROUTE = "/api/intercom/monitor";

export type IntercomStorageBucket = { files: number; bytes: number };

/** Kết quả `GET /api/intercom/monitor/storage`. */
export type IntercomMonitorStorage = {
  total: IntercomStorageBucket;
  projects: (IntercomStorageBucket & { project_id: string; photo_files: number; thumb_files: number })[];
  tmp: (IntercomStorageBucket & { stale_files: number; stale_bytes: number }) | null;
  /** Thư mục `intercom/<uuid>/` mà dự án không còn trong DB. */
  orphans: (IntercomStorageBucket & { project_id: string })[] | null;
  other: IntercomStorageBucket | null;
  truncated: boolean;
};

export type IntercomTrafficRange = "24h" | "7d";

/** Kết quả `GET /api/intercom/monitor/traffic`. */
export type IntercomMonitorEdgeTraffic =
  | { configured: false }
  | { configured: true; error: string }
  | {
      configured: true;
      error?: undefined;
      range: IntercomTrafficRange;
      /** Số ngày Cloudflare còn giữ dữ liệu; `null` khi không đọc được. */
      retention_days: number | null;
      /** Số ngày thật sự đã truy vấn (nhỏ hơn 7 khi hạn giữ ngắn hơn). */
      days_covered: number;
      requests: number;
      bytes_out: number;
      /** `null`: Cloudflare không cấp byte vào ở tập này. */
      bytes_in: number | null;
      client_errors: number;
      server_errors: number;
      status_499: number;
      upload_paths: { path: string; requests: number }[];
    };

export type IntercomCleanupKind = "tmp" | "pending" | "originals" | "project";

export type IntercomCleanupResult = { files: number; bytes: number; rows: number };

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const data: unknown = await res.json();
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function routeError(data: Record<string, unknown>, fallback: string): Error {
  return new Error(typeof data.error === "string" && data.error ? data.error : fallback);
}

export async function getIntercomMonitorStorage(): Promise<IntercomMonitorStorage> {
  const res = await fetch(`${MONITOR_ROUTE}/storage`, { credentials: "same-origin", cache: "no-store" });
  const data = await readJson(res);
  if (res.status === 403) throw new IntercomMonitorNoSeatError();
  if (!res.ok) throw routeError(data, "Chưa đọc được dung lượng R2.");
  return data as unknown as IntercomMonitorStorage;
}

/** Chưa có token: `{ configured: false }`. */
export async function getIntercomMonitorTraffic(range: IntercomTrafficRange): Promise<IntercomMonitorEdgeTraffic> {
  const res = await fetch(`${MONITOR_ROUTE}/traffic?range=${range}`, { credentials: "same-origin", cache: "no-store" });
  const data = await readJson(res);
  if (res.status === 403) throw new IntercomMonitorNoSeatError();
  if (!res.ok) return { configured: true, error: routeError(data, "Chưa đọc được số liệu Cloudflare.").message };
  return data as unknown as IntercomMonitorEdgeTraffic;
}

/** Dọn một loại. Lỗi thì NÉM câu của máy chủ. */
export async function runIntercomCleanup(input: {
  kind: IntercomCleanupKind;
  projectId?: string;
  confirmName?: string;
}): Promise<IntercomCleanupResult> {
  const res = await fetch(`${MONITOR_ROUTE}/cleanup`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await readJson(res);
  if (!res.ok) throw routeError(data, "Chưa dọn được, thử lại giúp tôi.");
  return { files: toNumber(data.files), bytes: toNumber(data.bytes), rows: toNumber(data.rows) };
}
