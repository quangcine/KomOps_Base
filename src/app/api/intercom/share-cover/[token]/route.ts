import { createWebClient } from "@/adapters/auth";
import { INTERCOM_COVER_KEY_RE } from "@/components/intercom/intercomCoverKey";
import { serveIntercomPhoto } from "../../_shared";

/**
 * Ảnh thẻ link khách: `GET /api/intercom/share-cover/<token>`, chỉ ảnh ngang. Ứng dụng chat tải ảnh không đăng
 * nhập nên đọc qua client KHÔNG phiên. Mã sai, đã thu hồi, chưa có ảnh: 404. Không đệm: thu hồi link là ảnh hết mở được.
 */
export const dynamic = "force-dynamic";

const LOG_TAG = "[intercom/share-cover]";
const SHARE_TOKEN_PATTERN = /^[0-9a-f]{48}$/;

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  if (!SHARE_TOKEN_PATTERN.test(token)) return Response.json({ error: "Tham số không hợp lệ" }, { status: 400 });

  const { data, error } = await createWebClient().rpc("intercom_share_card", { p_token: token });
  if (error) {
    console.error(LOG_TAG, "intercom_share_card failed", error.code, error.message);
    return Response.json({ error: "Chưa mở được ảnh, thử lại giúp tôi." }, { status: 500 });
  }
  const key = (data as { cover_key?: unknown } | null)?.cover_key;
  if (typeof key !== "string" || !INTERCOM_COVER_KEY_RE.test(key)) {
    return Response.json({ error: "Không tìm thấy ảnh" }, { status: 404 });
  }
  return serveIntercomPhoto(key, LOG_TAG, "no-store");
}
