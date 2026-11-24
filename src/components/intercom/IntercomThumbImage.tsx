"use client";

import { useState } from "react";

/**
 * Ảnh nhỏ một lượt, dùng chung chế độ Bảng (`IntercomBoardTable`) và chế độ Danh sách (`IntercomBoardList`).
 * Không mở được thì thay bằng ô chữ cùng cỡ ô; danh sách, giờ, mã tai giữ nguyên. Trang khách `/ic/` dùng chung
 * hai chế độ này. Ô 64px của Danh sách: 2 dòng.
 */
export function ThumbImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="flex size-full items-center justify-center text-center text-[9px] leading-[1.3] text-muted">
        Tạm chưa xem được ảnh
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- ảnh qua route R2 có quyền, không qua bộ tối ưu ảnh
    <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className="size-full object-cover" />
  );
}
