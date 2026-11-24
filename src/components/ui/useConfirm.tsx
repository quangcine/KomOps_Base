"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";

type ConfirmRequest = {
  title: string;
  content: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
  focusCancel: boolean;
};

type ConfirmOptions = {
  title?: string;
  content: string;
  confirmLabel?: string;
  /** Nhãn nút từ chối. Mặc định "Huỷ". */
  cancelLabel?: string;
  /** Vẽ nút đồng ý bằng màu cảnh báo. Dùng cho việc không lùi lại được. */
  danger?: boolean;
  /**
   * Đặt tiêu điểm đầu vào nút Huỷ mà vẫn giữ màu nút đồng ý (không đỏ như `danger`). Dùng cho việc gửi ra ngoài
   * phải bấm tay: Enter ngay khi hộp hiện chỉ huỷ. Mặc định tắt: tiêu điểm theo `danger` như cũ.
   */
  focusCancel?: boolean;
};

/** `dismiss` = đóng ngang bằng Esc hoặc chạm nền mờ, không bấm nút nào. */
export type ConfirmAnswer = "confirm" | "cancel" | "dismiss";

/**
 * Hộp xác nhận **của app**, thay cho `window.confirm` của trình duyệt. Người dùng nhìn thấy một hộp lạ giữa màn
 * hình app. `window.confirm` còn **chặn đứng luồng JavaScript**: mọi hoạt ảnh và mọi việc đang chạy đứng im tới
 * khi người dùng bấm. Hộp này thì không. ## Cách dùng ```tsx const { ask, dialog } = useConfirm(); // … if
 * (!(await ask({ content: "Xoá dòng này?" }))) return; // … return (<>{…}{dialog}</>); ``` ĐỪNG quên chèn
 * `{dialog}` vào JSX: thiếu nó thì `ask()` treo mãi mãi vì lời hứa không bao giờ được trả lời, và nút bấm trông
 * như hỏng. `ask()` gộp Esc, chạm nền mờ và nút Huỷ làm một (`false`). Chỗ nào cần tách đóng ngang khỏi nút từ
 * chối thì gọi `choose()`.
 */
export function useConfirm() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  /** Nơi giữ hàm trả lời của lời hứa đang chờ. */
  const resolverRef = useRef<((answer: ConfirmAnswer) => void) | null>(null);

  const choose = useCallback(
    (o: ConfirmOptions) =>
      new Promise<ConfirmAnswer>((done) => {
        resolverRef.current = done;
        setRequest({
          title: o.title ?? "Xác nhận",
          content: o.content,
          confirmLabel: o.confirmLabel ?? "Đồng ý",
          cancelLabel: o.cancelLabel ?? "Huỷ",
          danger: o.danger ?? false,
          focusCancel: o.focusCancel ?? false,
        });
      }),
    [],
  );

  const ask = useCallback(
    async (o: ConfirmOptions) => (await choose(o)) === "confirm",
    [choose],
  );

  const respond = useCallback((answer: ConfirmAnswer) => {
    setRequest(null);
    resolverRef.current?.(answer);
    resolverRef.current = null;
  }, []);

  // Esc = đóng ngang (`ask()` coi như Huỷ). Nghe ở tầng `window` pha bắt: hộp này hay mở từ trong `Modal`, mà
  // `Modal` nghe Esc ở tầng `document`. Chặn ngay tại `window` thì Esc chỉ đóng hộp hỏi, không lọt xuống làm popup
  // bên dưới đóng theo (hay hỏi thêm một lần nữa).
  const isOpen = request !== null;
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      respond("dismiss");
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isOpen, respond]);

  const dialog = request ? (
    // `z-[60]` để nằm TRÊN popup thường (`z-50`): hộp này hay được gọi từ trong một popup, và nằm dưới thì người dùng
    // thấy nền mờ mà không thấy câu hỏi.
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-3"
      onMouseDown={(e) => {
        // Bấm nền mờ = KHÔNG đồng ý. Đừng coi là đồng ý: đây là cú bấm vu vơ, mà việc phía sau thường là việc không lùi
        // lại được.
        if (e.target === e.currentTarget) respond("dismiss");
      }}
      role="alertdialog"
      aria-modal="true"
    >
      <div className="w-full max-w-sm rounded-card border border-border bg-surface p-3 shadow-[var(--shadow-e2)]">
        <div className="flex items-start gap-3">
          <span
            className={`flex size-9 shrink-0 items-center justify-center rounded-control ${
              request.danger ? "bg-danger/10 text-danger" : "bg-surface-2 text-muted"
            }`}
          >
            <AlertTriangle size={18} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-card font-semibold text-fg">{request.title}</h2>
            <p className="mt-1 text-body leading-relaxed text-muted">{request.content}</p>
          </div>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          {/* Hộp `danger` đặt tiêu điểm đầu vào nút Huỷ, không vào nút nguy hiểm: người quen tay bấm Enter ngay khi hộp hiện ra sẽ chỉ huỷ, không xoá nhầm. */}
          <button
            type="button"
            autoFocus={request.danger || request.focusCancel}
            onClick={() => respond("cancel")}
            className="h-10 rounded-control border border-border bg-surface px-3 text-body text-muted hover:text-fg"
          >
            {request.cancelLabel}
          </button>
          <button
            type="button"
            autoFocus={!request.danger && !request.focusCancel}
            onClick={() => respond("confirm")}
            className={`h-10 rounded-control px-3 text-body font-semibold text-white ${
              request.danger ? "bg-danger" : "bg-brand-cta"
            }`}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { ask, choose, dialog };
}
