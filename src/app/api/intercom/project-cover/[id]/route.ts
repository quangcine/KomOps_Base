import { UUID_RE, dbError, getBucket, readBodyCapped, stripJpegMetadata, type R2BucketLike } from "@/adapters/storage";
import { INTERCOM_COVER_KEY_RE, coverThumbKey } from "@/components/intercom/intercomCoverKey";
import { readSizeParam, serveIntercomPhoto } from "../../_shared";
import { JPEG_MAGIC, decodeBase64Part, rejectForeignOrigin, requireStaff } from "../../upload/_shared";

/**
 * Ảnh đại diện dự án intercom, phía nhân viên: `/api/intercom/project-cover/<project_id>`. Phiên
 * `staffServerClient`, không `service_role`; hàm `intercom_project_set_cover` (DEFINER) tự kiểm
 * `intercom_can_use`. Thân POST là JSON base64. Trình duyệt không gửi khoá: máy chủ tự sinh, tự đọc.
 */
export const dynamic = "force-dynamic";

const COVER_MAX_BYTES = 1024 * 1024;
/** Trần thân JSON: hai ảnh base64 mỗi ảnh tới `COVER_MAX_BYTES`, cộng vỏ JSON. */
const BODY_MAX_BYTES = Math.ceil((2 * COVER_MAX_BYTES) / 3) * 4 + 1024;
const SAVE_FAILED_TEXT = "Chưa lưu được ảnh, thử lại giúp tôi.";
const REMOVE_FAILED_TEXT = "Chưa gỡ được ảnh, thử lại giúp tôi.";
const OPEN_FAILED_TEXT = "Chưa mở được ảnh, thử lại giúp tôi.";
const INVALID_PARAM_TEXT = "Tham số không hợp lệ";
const JPEG_TYPE = { httpMetadata: { contentType: "image/jpeg" } };

function coverKeysOf(value: unknown): string[] {
  return typeof value === "string" && INTERCOM_COVER_KEY_RE.test(value) ? [value, coverThumbKey(value)] : [];
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
function readCoverPart(value: unknown): Uint8Array | Response {
  const bytes = typeof value === "string" ? decodeBase64Part(value) : null;
  if (!bytes || bytes.byteLength === 0) return Response.json({ error: "Ảnh không đọc được." }, { status: 400 });
  if (bytes.byteLength > COVER_MAX_BYTES) return Response.json({ error: "Ảnh vượt trần 1MB." }, { status: 413 });
  if (!JPEG_MAGIC.every((byte, i) => bytes[i] === byte)) {
    return Response.json({ error: "Ảnh phải là JPEG." }, { status: 400 });
  }
  const stripped = stripJpegMetadata(bytes);
  if (!stripped) return Response.json({ error: "Ảnh không đọc được." }, { status: 400 });
  return stripped;
}

function parseCoverBody(body: Uint8Array): { photo?: unknown; thumb?: unknown } | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as { photo?: unknown; thumb?: unknown }) : null;
  } catch {
    return null;
  }
}

const GET_LOG_TAG = "[intercom/project-cover/get]";

/**
 * `GET ?size=thumb|full`: khoá đọc từ bảng bằng phiên qua RLS. Trang khác nhúng `<img>` thì trình duyệt tự gửi
 * cookie nên chặn.
 */
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

  const { data, error } = await staff.supa.from("intercom_project").select("cover_key").eq("id", id).maybeSingle();
  if (error) {
    console.error(GET_LOG_TAG, "select intercom_project failed", error.code, error.message);
    return Response.json({ error: OPEN_FAILED_TEXT }, { status: 500 });
  }
  const key = (data as { cover_key?: unknown } | null)?.cover_key;
  if (typeof key !== "string" || !INTERCOM_COVER_KEY_RE.test(key)) {
    return Response.json({ error: "Không tìm thấy ảnh" }, { status: 404 });
  }
  return serveIntercomPhoto(size === "thumb" ? coverThumbKey(key) : key, GET_LOG_TAG, "private, max-age=3600");
}

const POST_LOG_TAG = "[intercom/project-cover/post]";

/**
 * Tải hoặc thay ảnh. Hỏng ở bước ghi nào thì xoá hai khoá vừa ghi; xong thì xoá hai khoá cũ, xoá hỏng chỉ ghi
 * log.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const foreign = rejectForeignOrigin(req);
  if (foreign) return foreign;
  const staff = await requireStaff();
  if (staff instanceof Response) return staff;
  // Chữ thường: khoá phải khớp `p_project::text` trong hàm `set_cover`.
  const id = (await params).id.toLowerCase();
  if (!UUID_RE.test(id)) return Response.json({ error: INVALID_PARAM_TEXT }, { status: 400 });

  const { data: canUse, error: gateError } = await staff.supa.rpc("intercom_can_use", { p_project: id });
  if (gateError) return dbError(gateError, "intercom_can_use", POST_LOG_TAG, SAVE_FAILED_TEXT);
  if (canUse !== true) return Response.json({ error: "Không có quyền sửa dự án intercom", reason: "permission" }, { status: 403 });

  const body = await readBodyCapped(req, BODY_MAX_BYTES);
  if (!body) return Response.json({ error: "Ảnh vượt trần 1MB." }, { status: 413 });
  const parsed = parseCoverBody(body);
  if (!parsed) return Response.json({ error: "Dữ liệu ảnh không hợp lệ." }, { status: 400 });
  const photo = readCoverPart(parsed.photo);
  if (photo instanceof Response) return photo;
  const thumb = readCoverPart(parsed.thumb);
  if (thumb instanceof Response) return thumb;

  let bucket: R2BucketLike;
  try {
    bucket = getBucket(POST_LOG_TAG);
  } catch (e) {
    console.error(POST_LOG_TAG, e instanceof Error ? e.message : e);
    return Response.json({ error: SAVE_FAILED_TEXT }, { status: 502 });
  }

  const coverKey = `intercom/${id}/cover_${crypto.randomUUID()}.jpg`;
  const newKeys = [coverKey, coverThumbKey(coverKey)];
  try {
    await bucket.put(coverKey, photo, JPEG_TYPE);
    await bucket.put(coverThumbKey(coverKey), thumb, JPEG_TYPE);
  } catch (e) {
    await deleteQuietly(bucket, newKeys, POST_LOG_TAG);
    return dbError({ message: e instanceof Error ? e.message : String(e) }, "R2 put", POST_LOG_TAG, SAVE_FAILED_TEXT);
  }

  const { data: oldKey, error } = await staff.supa.rpc("intercom_project_set_cover", { p_project: id, p_key: coverKey });
  if (error) {
    await deleteQuietly(bucket, newKeys, POST_LOG_TAG);
    return dbError(error, "intercom_project_set_cover", POST_LOG_TAG, SAVE_FAILED_TEXT);
  }
  await deleteQuietly(bucket, coverKeysOf(oldKey), POST_LOG_TAG);
  return Response.json({ cover_key: coverKey });
}

const DELETE_LOG_TAG = "[intercom/project-cover/delete]";

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

  const { data: oldKey, error } = await staff.supa.rpc("intercom_project_set_cover", { p_project: id, p_key: null });
  if (error) return dbError(error, "intercom_project_set_cover", DELETE_LOG_TAG, REMOVE_FAILED_TEXT);
  await deleteQuietly(bucket, coverKeysOf(oldKey), DELETE_LOG_TAG);
  return Response.json({ ok: true });
}
