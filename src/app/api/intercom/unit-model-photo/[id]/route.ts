import { UUID_RE, dbError, getBucket, readBodyCapped, stripJpegMetadata, type R2BucketLike } from "@/adapters/storage";
import { readSizeParam, serveIntercomPhoto } from "../../_shared";
import { JPEG_MAGIC, decodeBase64Part, rejectForeignOrigin, requireStaff } from "../../upload/_shared";

/**
 * Ảnh Model tai nghe intercom: `/api/intercom/unit-model-photo/<model_id>`. Phiên `staffServerClient`, không
 * `service_role`. Khoá `intercom/models/<model_id>/<uuid>.jpg` cộng ảnh nhỏ `_t.jpg`. Thân POST là JSON base64.
 */
export const dynamic = "force-dynamic";

const PHOTO_MAX_BYTES = 1024 * 1024;
/** Trần thân JSON: hai ảnh base64 mỗi ảnh tới `PHOTO_MAX_BYTES`, cộng vỏ JSON. */
const BODY_MAX_BYTES = Math.ceil((2 * PHOTO_MAX_BYTES) / 3) * 4 + 1024;
const SAVE_FAILED_TEXT = "Chưa lưu được ảnh, thử lại giúp tôi.";
const REMOVE_FAILED_TEXT = "Chưa gỡ được ảnh, thử lại giúp tôi.";
const OPEN_FAILED_TEXT = "Chưa mở được ảnh, thử lại giúp tôi.";
const INVALID_PARAM_TEXT = "Tham số không hợp lệ";
const NO_SEAT_TEXT = "Chỉ nhân viên sửa được ảnh Model";
const JPEG_TYPE = { httpMetadata: { contentType: "image/jpeg" } };

const MODEL_PHOTO_KEY_RE = /^intercom\/models\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/;

function thumbKey(key: string): string {
  return key.replace(/\.jpg$/, "_t.jpg");
}

function photoKeysOf(value: unknown): string[] {
  return typeof value === "string" && MODEL_PHOTO_KEY_RE.test(value) ? [value, thumbKey(value)] : [];
}

async function deleteQuietly(bucket: R2BucketLike, keys: string[], logTag: string): Promise<void> {
  if (keys.length === 0) return;
  try {
    await bucket.delete(keys);
  } catch (e) {
    console.error(logTag, "orphan R2 keys", keys.join(","), e instanceof Error ? e.message : e);
  }
}

/** Giải một ảnh trong thân JSON. Sai thì trả `Response` lỗi. */
function readPhotoPart(value: unknown): Uint8Array | Response {
  const bytes = typeof value === "string" ? decodeBase64Part(value) : null;
  if (!bytes || bytes.byteLength === 0) return Response.json({ error: "Ảnh không đọc được." }, { status: 400 });
  if (bytes.byteLength > PHOTO_MAX_BYTES) return Response.json({ error: "Ảnh vượt trần 1MB." }, { status: 413 });
  if (!JPEG_MAGIC.every((byte, i) => bytes[i] === byte)) {
    return Response.json({ error: "Ảnh phải là JPEG." }, { status: 400 });
  }
  const stripped = stripJpegMetadata(bytes);
  if (!stripped) return Response.json({ error: "Ảnh không đọc được." }, { status: 400 });
  return stripped;
}

function parsePhotoBody(body: Uint8Array): { photo?: unknown; thumb?: unknown } | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as { photo?: unknown; thumb?: unknown }) : null;
  } catch {
    return null;
  }
}

const GET_LOG_TAG = "[intercom/unit-model-photo/get]";

/** `GET ?size=thumb|full`. Trang khác nhúng `<img>` thì trình duyệt tự gửi cookie nên chặn. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") {
    return Response.json({ error: "Chỉ mở ảnh từ màn intercom." }, { status: 403 });
  }
  const id = (await params).id.toLowerCase();
  const size = readSizeParam(new URL(req.url));
  if (!UUID_RE.test(id) || !size) return Response.json({ error: INVALID_PARAM_TEXT }, { status: 400 });

  const staff = await requireStaff();
  if (staff instanceof Response) return staff;

  const { data, error } = await staff.supa.from("intercom_unit_model").select("photo_key").eq("id", id).maybeSingle();
  if (error) {
    console.error(GET_LOG_TAG, "select intercom_unit_model failed", error.code, error.message);
    return Response.json({ error: OPEN_FAILED_TEXT }, { status: 500 });
  }
  const key = (data as { photo_key?: unknown } | null)?.photo_key;
  if (typeof key !== "string" || !MODEL_PHOTO_KEY_RE.test(key)) {
    return Response.json({ error: "Không tìm thấy ảnh" }, { status: 404 });
  }
  return serveIntercomPhoto(size === "thumb" ? thumbKey(key) : key, GET_LOG_TAG, "private, max-age=3600");
}

const POST_LOG_TAG = "[intercom/unit-model-photo/post]";

/**
 * Tải hoặc thay ảnh. Hỏng ở bước ghi nào thì xoá hai khoá vừa ghi; xong thì xoá hai khoá cũ, xoá hỏng chỉ ghi
 * log.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const foreign = rejectForeignOrigin(req);
  if (foreign) return foreign;
  const staff = await requireStaff();
  if (staff instanceof Response) return staff;
  // Chữ thường: khoá phải khớp `p_id::text` trong hàm `set_photo`.
  const id = (await params).id.toLowerCase();
  if (!UUID_RE.test(id)) return Response.json({ error: INVALID_PARAM_TEXT }, { status: 400 });

  const { data: seated, error: gateError } = await staff.supa.rpc("is_staff");
  if (gateError) return dbError(gateError, "is_staff", POST_LOG_TAG, SAVE_FAILED_TEXT);
  if (seated !== true) return Response.json({ error: NO_SEAT_TEXT, reason: "permission" }, { status: 403 });

  const body = await readBodyCapped(req, BODY_MAX_BYTES);
  if (!body) return Response.json({ error: "Ảnh vượt trần 1MB." }, { status: 413 });
  const parsed = parsePhotoBody(body);
  if (!parsed) return Response.json({ error: "Dữ liệu ảnh không hợp lệ." }, { status: 400 });
  const photo = readPhotoPart(parsed.photo);
  if (photo instanceof Response) return photo;
  const thumb = readPhotoPart(parsed.thumb);
  if (thumb instanceof Response) return thumb;

  let bucket: R2BucketLike;
  try {
    bucket = getBucket(POST_LOG_TAG);
  } catch (e) {
    console.error(POST_LOG_TAG, e instanceof Error ? e.message : e);
    return Response.json({ error: SAVE_FAILED_TEXT }, { status: 502 });
  }

  const photoKey = `intercom/models/${id}/${crypto.randomUUID()}.jpg`;
  const newKeys = [photoKey, thumbKey(photoKey)];
  try {
    await bucket.put(photoKey, photo, JPEG_TYPE);
    await bucket.put(thumbKey(photoKey), thumb, JPEG_TYPE);
  } catch (e) {
    await deleteQuietly(bucket, newKeys, POST_LOG_TAG);
    return dbError({ message: e instanceof Error ? e.message : String(e) }, "R2 put", POST_LOG_TAG, SAVE_FAILED_TEXT);
  }

  const { data: oldKey, error } = await staff.supa.rpc("intercom_unit_model_set_photo", { p_id: id, p_key: photoKey });
  if (error) {
    await deleteQuietly(bucket, newKeys, POST_LOG_TAG);
    return dbError(error, "intercom_unit_model_set_photo", POST_LOG_TAG, SAVE_FAILED_TEXT);
  }
  await deleteQuietly(bucket, photoKeysOf(oldKey), POST_LOG_TAG);
  return Response.json({ photo_key: photoKey });
}

const DELETE_LOG_TAG = "[intercom/unit-model-photo/delete]";

/** Gỡ ảnh: thiếu kho thì trả 502 trước khi ghi DB; xoá tệp cũ hỏng chỉ ghi log. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const foreign = rejectForeignOrigin(req);
  if (foreign) return foreign;
  const staff = await requireStaff();
  if (staff instanceof Response) return staff;
  const id = (await params).id.toLowerCase();
  if (!UUID_RE.test(id)) return Response.json({ error: INVALID_PARAM_TEXT }, { status: 400 });

  let bucket: R2BucketLike;
  try {
    bucket = getBucket(DELETE_LOG_TAG);
  } catch (e) {
    console.error(DELETE_LOG_TAG, e instanceof Error ? e.message : e);
    return Response.json({ error: REMOVE_FAILED_TEXT }, { status: 502 });
  }

  const { data: oldKey, error } = await staff.supa.rpc("intercom_unit_model_set_photo", { p_id: id, p_key: null });
  if (error) return dbError(error, "intercom_unit_model_set_photo", DELETE_LOG_TAG, REMOVE_FAILED_TEXT);
  await deleteQuietly(bucket, photoKeysOf(oldKey), DELETE_LOG_TAG);
  return Response.json({ ok: true });
}
