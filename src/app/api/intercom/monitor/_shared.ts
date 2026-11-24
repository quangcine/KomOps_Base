import { getCloudflareContext } from "@opennextjs/cloudflare";

/** Phần dùng chung của route Monitor intercom. Tệp tiền tố `_` không thành route. */

export const INTERCOM_PREFIX = "intercom/";
export const INTERCOM_TMP_PREFIX = "intercom/tmp/";
/** Trần trang khi liệt kê (20 trang x 1000 = 20.000 tệp), quá thì trả cờ `truncated`. */
export const MONITOR_LIST_MAX_PAGES = 20;
/** Mẩu tạm cũ hơn chừng này mới dọn: không cắt lượt đang tải. */
export const TMP_STALE_MS = 60 * 60 * 1000;
export const MISSING_BUCKET_MESSAGE = "Thiếu binding MEDIA_BUCKET";
export const NO_STORE_HEADERS = { "cache-control": "private, no-store" };

export const UUID_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type R2ListedObject = { key: string; size: number; uploaded: Date };
export type R2ListPage = { objects: R2ListedObject[]; truncated: boolean; cursor?: string };
export type MonitorBucket = {
  list: (opts: { prefix: string; cursor?: string; limit?: number }) => Promise<R2ListPage>;
  delete: (keys: string | string[]) => Promise<void>;
};

export function monitorBucket(): MonitorBucket | null {
  try {
    const { env } = getCloudflareContext();
    return (env as unknown as { MEDIA_BUCKET?: MonitorBucket }).MEDIA_BUCKET ?? null;
  } catch {
    return null;
  }
}

/** Liệt kê theo tiền tố, theo trang `limit: 1000`, tối đa `maxPages` trang. */
export async function listPrefix(
  bucket: MonitorBucket,
  prefix: string,
  maxPages = MONITOR_LIST_MAX_PAGES,
): Promise<{ objects: R2ListedObject[]; truncated: boolean }> {
  const objects: R2ListedObject[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const obj of result.objects) if (obj.key.startsWith(prefix)) objects.push(obj);
    cursor = result.truncated ? result.cursor : undefined;
    if (!cursor) return { objects, truncated: false };
  }
  return { objects, truncated: true };
}

export async function deleteKeys(bucket: MonitorBucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
}

/** Cửa nguồn cho `POST`: `sec-fetch-site === "same-origin"` và `Origin` khớp gốc. */
export function isSameOriginPost(req: Request): boolean {
  const origin = req.headers.get("origin");
  return req.headers.get("sec-fetch-site") === "same-origin" && !!origin && origin === new URL(req.url).origin;
}

/** Cửa nguồn cho `GET`: có `sec-fetch-site` mà khác `same-origin` thì chặn. */
export function isSameOriginGet(req: Request): boolean {
  const fetchSite = req.headers.get("sec-fetch-site");
  return fetchSite === null || fetchSite === "same-origin";
}
