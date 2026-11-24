"use client";

// Tải, gỡ ảnh đại diện dự án intercom từ trình duyệt. Cắt sẵn hai bản rồi gửi JSON base64: ngang 1200x630 cho thẻ
// link, vuông 256 cho thẻ màn Dự án.

import { compressAvatar } from "@/lib/avatar";

const COVER_ROUTE = "/api/intercom/project-cover";
const SOURCE_MAX_BYTES = 25 * 1024 * 1024;
const WIDE_WIDTH = 1200;
const WIDE_HEIGHT = 630;
const JPEG_QUALITY = 0.82;

function stripDataUrlPrefix(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

async function cropWideCover(file: File): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("Không đọc được ảnh.");
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = WIDE_WIDTH;
    canvas.height = WIDE_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Trình duyệt không xử lý được ảnh này.");
    const scale = Math.min(bitmap.width / WIDE_WIDTH, bitmap.height / WIDE_HEIGHT);
    const cropWidth = WIDE_WIDTH * scale;
    const cropHeight = WIDE_HEIGHT * scale;
    const cropX = (bitmap.width - cropWidth) / 2;
    const cropY = (bitmap.height - cropHeight) / 2;
    ctx.drawImage(bitmap, cropX, cropY, cropWidth, cropHeight, 0, 0, WIDE_WIDTH, WIDE_HEIGHT);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } finally {
    bitmap.close();
  }
}

async function readRouteError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" && body.error !== "" ? body.error : fallback;
}

/** Tải hoặc thay ảnh, trả khoá mới. Lỗi thì NÉM câu hiện cho người dùng. */
export async function uploadProjectCover(projectId: string, file: File): Promise<string> {
  if (file.size > SOURCE_MAX_BYTES) throw new Error("Ảnh quá lớn, tối đa 25MB.");
  // Lần lượt, không song song: hai lần giải mã cùng lúc nặng bộ nhớ trên iPhone.
  const wide = await cropWideCover(file);
  const square = await compressAvatar(file);
  const res = await fetch(`${COVER_ROUTE}/${projectId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ photo: stripDataUrlPrefix(wide), thumb: stripDataUrlPrefix(square) }),
  });
  if (!res.ok) throw new Error(await readRouteError(res, "Chưa lưu được ảnh, thử lại giúp tôi."));
  const body = (await res.json()) as { cover_key?: unknown };
  if (typeof body.cover_key !== "string") throw new Error("Chưa lưu được ảnh, thử lại giúp tôi.");
  return body.cover_key;
}

/** Gỡ ảnh. Lỗi thì NÉM câu hiện cho người dùng. */
export async function removeProjectCover(projectId: string): Promise<void> {
  const res = await fetch(`${COVER_ROUTE}/${projectId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await readRouteError(res, "Chưa gỡ được ảnh, thử lại giúp tôi."));
}
