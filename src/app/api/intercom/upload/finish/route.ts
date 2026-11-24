import {
  dbError,
  getBucket,
  stripJpegMetadata,
  type R2BucketLike,
} from "@/adapters/storage";
import { INTERCOM_PHOTO_KEY_RE, INTERCOM_THUMB_KEY_RE } from "../../_shared";
import {
  ACCEPTED_TYPE,
  JPEG_MAGIC,
  MAX_BYTES,
  MAX_PARTS,
  PART_MAX_BYTES,
  SAVE_FAILED,
  TOO_LARGE,
  intInRange,
  optionalDimension,
  optionalUuid,
  readHandover,
  readJsonObject,
  rejectForeignOrigin,
  requireStaff,
  tmpPartKey,
  type PartKind,
  type StaffSupabase,
} from "../_shared";

/**
 * Bước 3 của tải chia mẩu: `POST` JSON `handover_id`, `parts`, `thumb_parts`, `width`, `height`. Đọc đủ mẩu tạm
 * theo thứ tự, ghép, kiểm byte đầu JPEG, trần 2 MB, bỏ EXIF (`stripJpegMetadata`), `put` hai khoá chính thức,
 * xoá mẩu tạm, gọi `intercom_handover_finish`. Thiếu mẩu: 409 kèm `missing: { photo: [...], thumb: [...] }`
 * (không huỷ lượt, máy gửi bù rồi gọi lại). Lượt đã `done`: trả kết quả cũ kèm `already_done`. Hỏng sau khi đã
 * đủ mẩu: như route `intercom/photo`, huỷ lượt `pending` trước, chỉ xoá hai khoá chính thức khi huỷ được đúng
 * lượt đó; mẩu tạm luôn xoá.
 */
export const dynamic = "force-dynamic";

const LOG_TAG = "[intercom/upload/finish]";

async function doneReply(supa: StaffSupabase, handoverId: string): Promise<Response> {
  const finish = await supa.rpc("intercom_handover_finish", {
    p_handover: handoverId,
    p_size_bytes: 1,
    p_width: null,
    p_height: null,
  });
  if (finish.error) return dbError(finish.error, "intercom_handover_finish", LOG_TAG, SAVE_FAILED);
  return Response.json({ ok: true, already_done: true, result: finish.data ?? null });
}

/** Đọc một mẩu tạm; không có thì `null`. */
async function readPart(bucket: R2BucketLike, key: string): Promise<Uint8Array | null> {
  const obj = await bucket.get(key);
  if (!obj || !obj.body) return null;
  return new Uint8Array(await new Response(obj.body).arrayBuffer());
}

function joinChunks(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/** Soát ảnh đã ghép: trần, byte đầu, bỏ siêu dữ liệu. Lỗi thì trả `Response`. */
function checkJpeg(raw: Uint8Array): Uint8Array | Response {
  if (raw.byteLength > MAX_BYTES) return Response.json({ error: TOO_LARGE }, { status: 413 });
  if (raw.byteLength < JPEG_MAGIC.length || JPEG_MAGIC.some((b, i) => raw[i] !== b)) {
    return Response.json({ error: "Chỉ nhận ảnh JPEG." }, { status: 415 });
  }
  const content = stripJpegMetadata(raw);
  if (!content || content.byteLength === 0) {
    return Response.json({ error: "Ảnh JPEG bị hỏng, chụp lại giúp tôi." }, { status: 415 });
  }
  return content;
}

export async function POST(req: Request): Promise<Response> {
  const blocked = rejectForeignOrigin(req);
  if (blocked) return blocked;
  const staff = await requireStaff();
  if (staff instanceof Response) return staff;
  const { supa, userId } = staff;

  const body = await readJsonObject(req);
  const handoverId = body ? optionalUuid(body.handover_id) : null;
  const parts = body ? intInRange(body.parts, 1, MAX_PARTS) : null;
  const thumbParts = body ? intInRange(body.thumb_parts, 1, MAX_PARTS) : null;
  const width = body ? optionalDimension(body.width) : undefined;
  const height = body ? optionalDimension(body.height) : undefined;
  if (!handoverId || !parts || !thumbParts || width === undefined || height === undefined) {
    return Response.json({ error: "Tham số không hợp lệ" }, { status: 400 });
  }

  const read = await readHandover(supa, handoverId);
  if (read.error) return Response.json({ error: SAVE_FAILED }, { status: 502 });
  const row = read.row;
  if (!row) return Response.json({ error: "Không tìm thấy lượt chụp" }, { status: 404 });
  if (row.status === "done") return doneReply(supa, handoverId);
  if (row.created_by !== userId) {
    return Response.json({ error: "Lượt chụp này của người khác", reason: "permission" }, { status: 403 });
  }

  let bucket: R2BucketLike;
  try {
    bucket = getBucket(LOG_TAG);
  } catch (e) {
    console.error(LOG_TAG, e instanceof Error ? e.message : e);
    return Response.json({ error: "Chưa lưu được ảnh lên kho, thử lại giúp tôi." }, { status: 502 });
  }

  const plan: { kind: PartKind; index: number; key: string }[] = [];
  for (let i = 0; i < parts; i += 1) plan.push({ kind: "photo", index: i, key: tmpPartKey(handoverId, "photo", i) });
  for (let i = 0; i < thumbParts; i += 1) plan.push({ kind: "thumb", index: i, key: tmpPartKey(handoverId, "thumb", i) });
  const tmpKeys = plan.map((p) => p.key);

  let loaded: (Uint8Array | null)[];
  try {
    loaded = await Promise.all(plan.map((p) => readPart(bucket, p.key)));
  } catch (e) {
    console.error(LOG_TAG, "read parts failed", handoverId, e instanceof Error ? e.message : e);
    return Response.json({ error: "Chưa lưu được ảnh lên kho, thử lại giúp tôi." }, { status: 503 });
  }
  const missing = { photo: [] as number[], thumb: [] as number[] };
  loaded.forEach((bytes, n) => {
    if (!bytes || bytes.byteLength === 0) missing[plan[n].kind].push(plan[n].index);
  });
  if (missing.photo.length > 0 || missing.thumb.length > 0) {
    // Một `finish` khác cùng lượt có thể vừa xong và xoá mẩu: đọc lại trạng thái trước khi báo thiếu.
    const again = await readHandover(supa, handoverId);
    if (!again.error && again.row?.status === "done") return doneReply(supa, handoverId);
    return Response.json({ error: "Thiếu mẩu ảnh, gửi bù giúp tôi.", missing }, { status: 409 });
  }

  const photoKey = row.photo_key;
  const thumbKey = row.thumb_key;

  /**
   * Dọn sau khi đã đủ mẩu: huỷ lượt `pending` TRƯỚC, chỉ xoá hai khoá chính thức khi huỷ được đúng lượt đó (lượt
   * đã `done` thì giữ ảnh). Mẩu tạm luôn xoá.
   */
  const rollback = async (step: string, detail: unknown, reply?: Response): Promise<Response> => {
    console.error(LOG_TAG, step, "failed", handoverId, detail instanceof Error ? detail.message : detail);
    const abort = await supa.rpc("intercom_handover_abort", { p_handover: handoverId });
    const keys = [photoKey, thumbKey].filter((k) => INTERCOM_PHOTO_KEY_RE.test(k) || INTERCOM_THUMB_KEY_RE.test(k));
    if (abort.error) {
      console.error(LOG_TAG, "intercom_handover_abort failed, keep R2 keys", handoverId, abort.error.code, abort.error.message, keys.join(","));
    } else if (abort.data !== true) {
      console.error(LOG_TAG, "intercom_handover_abort removed nothing, keep R2 keys", handoverId, keys.join(","));
    } else if (keys.length > 0) {
      await bucket.delete(keys).catch((e: unknown) => {
        console.error(LOG_TAG, "orphan R2 keys", keys.join(","), e instanceof Error ? e.message : e);
      });
    }
    await bucket.delete(tmpKeys).catch((e: unknown) => {
      console.error(LOG_TAG, "orphan tmp keys", handoverId, e instanceof Error ? e.message : e);
    });
    return reply ?? Response.json({ error: SAVE_FAILED }, { status: 502 });
  };

  const chunks = loaded as Uint8Array[];
  if (chunks.some((c) => c.byteLength > PART_MAX_BYTES)) {
    return rollback("part size", "part over cap", Response.json({ error: TOO_LARGE }, { status: 413 }));
  }
  const photoChunks = chunks.slice(0, parts);
  const thumbChunks = chunks.slice(parts);
  const photoTotal = photoChunks.reduce((sum, c) => sum + c.byteLength, 0);
  const thumbTotal = thumbChunks.reduce((sum, c) => sum + c.byteLength, 0);
  if (photoTotal > MAX_BYTES || thumbTotal > MAX_BYTES) {
    return rollback("total size", `${photoTotal} ${thumbTotal}`, Response.json({ error: TOO_LARGE }, { status: 413 }));
  }
  const photo = checkJpeg(joinChunks(photoChunks));
  if (photo instanceof Response) return rollback("photo jpeg", photo.status, photo);
  const thumb = checkJpeg(joinChunks(thumbChunks));
  if (thumb instanceof Response) return rollback("thumb jpeg", thumb.status, thumb);

  if (
    !INTERCOM_PHOTO_KEY_RE.test(photoKey) ||
    !INTERCOM_THUMB_KEY_RE.test(thumbKey) ||
    !photoKey.includes(handoverId)
  ) {
    return rollback("handover keys", `${photoKey} ${thumbKey}`);
  }
  try {
    await bucket.put(photoKey, photo, { httpMetadata: { contentType: ACCEPTED_TYPE } });
  } catch (e) {
    return rollback("put photo", e);
  }
  try {
    await bucket.put(thumbKey, thumb, { httpMetadata: { contentType: ACCEPTED_TYPE } });
  } catch (e) {
    return rollback("put thumb", e);
  }

  const finish = await supa.rpc("intercom_handover_finish", {
    p_handover: handoverId,
    p_size_bytes: photo.byteLength,
    p_width: width,
    p_height: height,
  });
  if (finish.error) {
    await rollback("intercom_handover_finish", `${finish.error.code ?? ""} ${finish.error.message}`);
    return dbError(finish.error, "intercom_handover_finish", LOG_TAG, SAVE_FAILED);
  }
  await bucket.delete(tmpKeys).catch((e: unknown) => {
    console.error(LOG_TAG, "orphan tmp keys", handoverId, e instanceof Error ? e.message : e);
  });
  return Response.json({ ok: true, already_done: false, result: finish.data ?? null });
}
