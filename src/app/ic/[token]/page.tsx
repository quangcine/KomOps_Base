import type { Metadata } from "next";
import { createWebClient } from "@/adapters/auth";
import { APP_NAME, APP_ORIGIN } from "@/adapters/brand";
import { IntercomShareScreen } from "@/components/intercom/IntercomShareScreen";
import { INTERCOM_COVER_KEY_RE, shareCoverPath } from "@/components/intercom/intercomCoverKey";

/**
 * Trang khách `/ic/<mã>`: TRANG ĐỘNG, KHÔNG đệm. Thu hồi link thì bản đệm vẫn phục vụ tiếp cho tới khi hết đệm;
 * nên không `revalidate`.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

const DEFAULT_TITLE = APP_NAME;
const DEFAULT_COVER_PATH = "/og-default.png";

/** Client KHÔNG phiên, đúng vai của khách. Lỗi tính như mã sai. */
async function readShareCard(token: string): Promise<{ name?: unknown; cover_key?: unknown } | null> {
  try {
    const { data, error } = await createWebClient().rpc("intercom_share_card", { p_token: token });
    // Không log `token` và `error.message` (có thể chứa tham số).
    if (error) console.error("intercom_share_card failed", error.code);
    return data as { name?: unknown; cover_key?: unknown } | null;
  } catch (e) {
    console.error("intercom_share_card failed", e instanceof Error ? e.name : "unknown");
    return null;
  }
}

/**
 * Thẻ khi dán link vào tin nhắn: chỉ tên dự án và ảnh, không mô tả. Mã sai, đã thu hồi, lỗi đọc: tên chung cộng
 * ảnh mặc định. Đường ảnh tuyệt đối theo `APP_ORIGIN`.
 */
export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const origin = APP_ORIGIN;
  const card = await readShareCard(token);
  const title = typeof card?.name === "string" && card.name !== "" ? card.name : DEFAULT_TITLE;
  const coverKey = card?.cover_key;
  const coverPath =
    typeof coverKey === "string" && INTERCOM_COVER_KEY_RE.test(coverKey) ? shareCoverPath(token, coverKey) : DEFAULT_COVER_PATH;
  return {
    title: { absolute: title },
    description: null,
    openGraph: { title, images: [{ url: `${origin}${coverPath}`, width: 1200, height: 630 }] },
    robots: { index: false, follow: false },
  };
}

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <IntercomShareScreen token={token} />;
}
