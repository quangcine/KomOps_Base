// ĐIỂM ĐẤU "LƯU ẢNH": mọi ảnh đi qua R2 binding `MEDIA_BUCKET` (khai ở wrangler.jsonc).
// Đổi sang S3, Supabase Storage...: trả về một đối tượng cùng hình dạng `R2BucketLike` trong `getBucket`,
// và cùng hình dạng `MonitorBucket` trong `app/api/intercom/monitor/_shared.ts`.

import { getCloudflareContext } from "@opennextjs/cloudflare";


export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Mã lỗi mang câu tiếng Việt viết cho người dùng (RAISE của hàm): trả nguyên văn. */
export const USER_FACING_ERROR_CODES = ["P0001", "P0002", "42501", "22023"];

export type R2PutOptions = { httpMetadata?: { contentType?: string } };
export type R2Range = { offset?: number; length?: number; suffix?: number };
export type R2ObjectBody = {
  body: ReadableStream | null;
  size: number;
  httpEtag: string;
  range?: R2Range;
  writeHttpMetadata: (h: Headers) => void;
};
export type R2PartRef = { partNumber: number; "etag": string };
export type R2PartUploadLike = {
  uploadPart: (partNumber: number, value: ArrayBuffer | Uint8Array | ReadableStream | string) => Promise<R2PartRef>;
  abort: () => Promise<void>;
  complete: (parts: R2PartRef[]) => Promise<{ size: number }>;
};
export type R2BucketLike = {
  put: (key: string, val: ArrayBuffer | Uint8Array | ReadableStream | null, opts?: R2PutOptions) => Promise<unknown>;
  get: (key: string, opts?: { range?: Headers }) => Promise<R2ObjectBody | null>;
  head: (key: string) => Promise<{ size: number } | null>;
  delete: (keys: string | string[]) => Promise<void>;
  "createMultipartUpload": (key: string, opts?: R2PutOptions) => Promise<{ uploadId: string }>;
  "resumeMultipartUpload": (key: string, uploadId: string) => R2PartUploadLike;
};

export function getBucket(logTag: string): R2BucketLike {
  const { env } = getCloudflareContext();
  const bucket = (env as unknown as { MEDIA_BUCKET?: R2BucketLike }).MEDIA_BUCKET;
  if (!bucket) throw new Error(`${logTag} missing MEDIA_BUCKET binding (R2)`);
  return bucket;
}

/** Đọc thân theo luồng, đếm byte; quá `maxBytes` thì huỷ luồng và trả `null`, không gom trọn vào bộ nhớ. */
export async function readBodyCapped(req: Request, maxBytes: number): Promise<Uint8Array | null> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Cấu trúc đoạn hỏng thì trả `null` (ảnh hỏng, từ chối). */
export function stripJpegMetadata(src: Uint8Array): Uint8Array | null {
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
 * Đổi lỗi RPC ra HTTP: mã ngoài danh sách là 500 câu chung `fallback` (ghi log `step`); 42501 là 403 kèm
 * `reason: "permission"`, P0002 là 404, còn lại 400. Câu lỗi của hàm trả nguyên văn.
 */
export function dbError(error: { code?: string; message: string }, step: string, logTag: string, fallback: string): Response {
  if (!USER_FACING_ERROR_CODES.includes(error.code ?? "")) {
    console.error(logTag, step, "failed", error.code, error.message);
    return Response.json({ error: fallback }, { status: 500 });
  }
  if (error.code === "42501") return Response.json({ error: error.message, reason: "permission" }, { status: 403 });
  if (error.code === "P0002") return Response.json({ error: error.message }, { status: 404 });
  return Response.json({ error: error.message }, { status: 400 });
}
