import { UUID_RE, getBucket, readBodyCapped, type R2BucketLike } from "@/adapters/storage";
import {
  MAX_PARTS,
  PART_KINDS,
  PART_MAX_BYTES,
  PART_TEXT_MAX_BYTES,
  decodeBase64Part,
  readHandover,
  rejectForeignOrigin,
  requireStaff,
  tmpPartKey,
  type PartKind,
} from "../_shared";

/**
 * Bước 2 của tải chia mẩu: `PUT ?h=<handover_id>&kind=photo|thumb&i=<số>`, mẩu tối đa 160 KB. Thân là base64
 * trong `text/plain`, JSON `{"data":"<base64>"}`, hoặc nhị phân (dự phòng); trần bytes tính sau giải mã. Chỉ
 * nhận khi lượt đang `pending` và do chính người gọi mở (đọc qua RLS). Lượt đã `done` trả 409 kèm
 * `handover_status: "done"` (máy dựng kết quả từ bảng).
 */
export const dynamic = "force-dynamic";

const LOG_TAG = "[intercom/upload/part]";

export async function PUT(req: Request): Promise<Response> {
  const blocked = rejectForeignOrigin(req);
  if (blocked) return blocked;
  const staff = await requireStaff();
  if (staff instanceof Response) return staff;
  const { supa, userId } = staff;

  const url = new URL(req.url);
  const handoverId = (url.searchParams.get("h") ?? "").toLowerCase();
  const kind = url.searchParams.get("kind") ?? "";
  const indexText = url.searchParams.get("i") ?? "";
  const index = /^\d{1,3}$/.test(indexText) ? Number(indexText) : -1;
  if (!UUID_RE.test(handoverId) || !(PART_KINDS as readonly string[]).includes(kind) || index < 0 || index >= MAX_PARTS) {
    return Response.json({ error: "Tham số không hợp lệ" }, { status: 400 });
  }

  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  const isText = contentType.startsWith("text/plain");
  const isJson = contentType.startsWith("application/json");
  const rawCap = isText || isJson ? PART_TEXT_MAX_BYTES : PART_MAX_BYTES;
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > rawCap) return Response.json({ error: "Mẩu ảnh vượt trần." }, { status: 413 });
  const raw = await readBodyCapped(req, rawCap);
  if (!raw) return Response.json({ error: "Mẩu ảnh vượt trần." }, { status: 413 });
  if (raw.byteLength === 0) return Response.json({ error: "Mẩu ảnh rỗng." }, { status: 400 });
  let body: Uint8Array = raw;
  if (isText || isJson) {
    let base64Text = new TextDecoder().decode(raw);
    if (isJson) {
      try {
        const parsed = JSON.parse(base64Text) as { data?: unknown } | null;
        base64Text = parsed && typeof parsed.data === "string" ? parsed.data : "";
      } catch {
        base64Text = "";
      }
    }
    const partBytes = decodeBase64Part(base64Text);
    if (!partBytes) return Response.json({ error: "Mẩu ảnh hỏng." }, { status: 400 });
    body = partBytes;
  }
  if (body.byteLength > PART_MAX_BYTES) return Response.json({ error: "Mẩu ảnh vượt trần." }, { status: 413 });
  if (body.byteLength === 0) return Response.json({ error: "Mẩu ảnh rỗng." }, { status: 400 });

  const { row, error } = await readHandover(supa, handoverId);
  if (error) return Response.json({ error: "Chưa lưu được ảnh, thử lại giúp tôi." }, { status: 502 });
  if (!row) return Response.json({ error: "Không tìm thấy lượt chụp", handover_status: null }, { status: 404 });
  if (row.created_by !== userId) {
    return Response.json({ error: "Lượt chụp này của người khác", reason: "permission" }, { status: 403 });
  }
  if (row.status !== "pending") {
    return Response.json({ error: "Lượt chụp đã lưu xong", handover_status: row.status }, { status: 409 });
  }

  let bucket: R2BucketLike;
  try {
    bucket = getBucket(LOG_TAG);
  } catch (e) {
    console.error(LOG_TAG, e instanceof Error ? e.message : e);
    return Response.json({ error: "Chưa lưu được ảnh lên kho, thử lại giúp tôi." }, { status: 502 });
  }
  const key = tmpPartKey(handoverId, kind as PartKind, index);
  try {
    await bucket.put(key, body, { httpMetadata: { contentType: "application/octet-stream" } });
  } catch (e) {
    console.error(LOG_TAG, "put part failed", key, e instanceof Error ? e.message : e);
    return Response.json({ error: "Chưa lưu được ảnh lên kho, thử lại giúp tôi." }, { status: 502 });
  }
  return Response.json({ ok: true, size: body.byteLength });
}
