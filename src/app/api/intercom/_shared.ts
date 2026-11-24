import { getBucket, type R2BucketLike, type R2ObjectBody } from "@/adapters/storage";

/** Phần dùng chung của các route `intercom`. Tệp tiền tố `_` không thành route trong App Router. */

/** Ảnh lớn: `intercom/<project_id>/<handover_id>.jpg`. */
export const INTERCOM_PHOTO_KEY_RE = /^intercom\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/;
/** Ảnh nhỏ: `intercom/<project_id>/<handover_id>_t.jpg`. */
export const INTERCOM_THUMB_KEY_RE = /^intercom\/[0-9a-f-]{36}\/[0-9a-f-]{36}_t\.jpg$/;

/**
 * Ngày làm việc chọn tay cho ảnh thư viện: `work_date` dạng `YYYY-MM-DD` và là ngày có thật. Ngày ngoài khoảng
 * dự án do hàm `intercom_handover_begin` từ chối.
 */
export function optionalWorkDate(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : undefined;
}

/** `?size=thumb|full`; thiếu tham số là `full`. Sai giá trị trả `null`. */
export function readSizeParam(url: URL): "thumb" | "full" | null {
  const size = url.searchParams.get("size");
  if (size === null || size === "full") return "full";
  if (size === "thumb") return "thumb";
  return null;
}

/** Khoá đã soát ở chỗ gọi. `cacheControl` do chỗ gọi đặt (nhân viên `private`, khách `private, no-store`). */
export async function serveIntercomPhoto(key: string, logTag: string, cacheControl: string): Promise<Response> {
  let bucket: R2BucketLike;
  try {
    bucket = getBucket(logTag);
  } catch (e) {
    console.error(logTag, e instanceof Error ? e.message : e);
    return Response.json({ error: "Chưa mở được ảnh, thử lại giúp tôi." }, { status: 502 });
  }
  let obj: R2ObjectBody | null;
  try {
    obj = await bucket.get(key);
  } catch (e) {
    console.error(logTag, "R2 get failed", key, e instanceof Error ? e.message : e);
    return Response.json({ error: "Chưa mở được ảnh, thử lại giúp tôi." }, { status: 502 });
  }
  if (!obj) return Response.json({ error: "Không tìm thấy ảnh trong kho." }, { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("content-type", "image/jpeg");
  h.set("etag", obj.httpEtag);
  h.set("content-length", String(obj.size));
  h.set("cache-control", cacheControl);
  h.set("x-content-type-options", "nosniff");
  return new Response(obj.body, { headers: h });
}
