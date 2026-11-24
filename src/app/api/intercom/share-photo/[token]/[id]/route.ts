import { createWebClient } from "@/adapters/auth";
import { UUID_RE } from "@/adapters/storage";
import { INTERCOM_PHOTO_KEY_RE, INTERCOM_THUMB_KEY_RE, readSizeParam, serveIntercomPhoto } from "../../../_shared";
import { serveDrivePhoto } from "../../../drive/_shared";

/**
 * Khách xem ảnh qua link dashboard: `GET /api/intercom/share-photo/<token>/<handover_id>?size=thumb|full`. Mã
 * sai, đã thu hồi, lượt không thuộc dự án của mã: hàm trả rỗng, route trả 404. Không đệm: thu hồi link là ảnh
 * thôi mở được ngay.
 */
export const dynamic = "force-dynamic";

const LOG_TAG = "[intercom/share-photo]";
const SHARE_TOKEN_PATTERN = /^[0-9a-f]{48}$/;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string; id: string }> },
): Promise<Response> {
  const { token, id: rawId } = await params;
  const id = rawId.toLowerCase();
  const size = readSizeParam(new URL(req.url));
  if (!SHARE_TOKEN_PATTERN.test(token) || !UUID_RE.test(id) || !size) {
    return Response.json({ error: "Tham số không hợp lệ" }, { status: 400 });
  }
  const { data, error } = await createWebClient().rpc("intercom_share_photo_key", {
    p_token: token,
    p_handover: id,
    p_thumb: size === "thumb",
  });
  if (error) {
    console.error(LOG_TAG, "intercom_share_photo_key failed", error.code, error.message);
    return Response.json({ error: "Chưa mở được ảnh, thử lại giúp tôi." }, { status: 500 });
  }
  // Ảnh gốc đã dọn: hàm trả khoá ảnh nhỏ cho cả lần xin `full`.
  const keyOk =
    typeof data === "string" &&
    (size === "thumb" ? INTERCOM_THUMB_KEY_RE.test(data) : INTERCOM_PHOTO_KEY_RE.test(data) || INTERCOM_THUMB_KEY_RE.test(data));
  if (typeof data !== "string" || !keyOk) {
    return Response.json({ error: "Link không còn hiệu lực" }, { status: 404 });
  }
  const fromR2 = await serveIntercomPhoto(data, LOG_TAG, "private, no-store");
  if (fromR2.status !== 404) return fromR2;

  const drive = await createWebClient().rpc("intercom_share_drive_file", {
    p_token: token,
    p_handover: id,
    p_thumb: size === "thumb",
  });
  if (drive.error) {
    console.error(LOG_TAG, "intercom_share_drive_file failed", drive.error.code, drive.error.message);
    return Response.json({ error: "Chưa mở được ảnh, thử lại giúp tôi." }, { status: 502 });
  }
  const file = ((drive.data ?? []) as { account_id?: unknown; file_id?: unknown }[])[0];
  if (typeof file?.account_id !== "string" || typeof file.file_id !== "string") return fromR2;
  return serveDrivePhoto(file.account_id, file.file_id, LOG_TAG, "private, no-store");
}
