// Khoá và đường dẫn ảnh đại diện dự án intercom. Hàm thuần, không "use client": dùng chung cho route, trang
// `/ic/<mã>` và màn nhân viên. Cột `cover_key` chỉ giữ khoá ảnh ngang; ảnh vuông nằm cạnh, đuôi `_t.jpg`. Vì sao
// hai tệp: Worker không có bộ tối ưu ảnh nên phải cắt sẵn ở trình duyệt; vuông lấy từ ảnh ngang của ảnh dọc chỉ
// còn dải hẹp.

import type { IntercomPhotoSize } from "@/lib/intercom/staffIntercom";

/** Cùng regex với CHECK `intercom_project_cover_key_check`: `intercom/<project_id>/cover_<uuid>.jpg`. */
export const INTERCOM_COVER_KEY_RE = /^intercom\/[0-9a-f-]{36}\/cover_[0-9a-f-]{36}\.jpg$/;

const COVER_VERSION_LENGTH = 8;
const COVER_NAME_PREFIX = "/cover_";

export function coverThumbKey(key: string): string {
  return key.replace(/\.jpg$/, "_t.jpg");
}

/** 8 ký tự đầu uuid của tên ảnh: thay ảnh là đổi `?v=`, không dính bản đã đệm. */
export function coverVersion(key: string): string {
  const start = key.lastIndexOf(COVER_NAME_PREFIX) + COVER_NAME_PREFIX.length;
  return key.slice(start, start + COVER_VERSION_LENGTH);
}

export function staffCoverUrl(projectId: string, key: string, size: IntercomPhotoSize): string {
  return `/api/intercom/project-cover/${projectId}?size=${size}&v=${coverVersion(key)}`;
}

export function shareCoverPath(token: string, key: string): string {
  return `/api/intercom/share-cover/${token}?v=${coverVersion(key)}`;
}
