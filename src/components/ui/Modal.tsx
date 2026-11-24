"use client";

// Popup giữa màn, nền tối, đóng bằng nền và phím Esc. `role="dialog"` kèm `aria-modal` và `aria-label`.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

/** Bề rộng tối đa của tấm. Tên gọi theo VIỆC chứ không theo số, để chỗ gọi khỏi tự chế số mới. */
export type ModalWidth = "narrow" | "medium" | "wide" | "reading" | "page";

const WIDTH_CLASS: Record<ModalWidth, string> = {
  // Xác nhận, form một hai ô.
  narrow: "max-w-md",
  // Form thường.
  medium: "max-w-lg",
  // Form có bảng nhập nhiều cột.
  wide: "max-w-2xl",
  // Bài đọc rộng 640px.
  reading: "max-w-[640px]",
  // Form rộng cả trang.
  page: "max-w-[960px]",
};

// Ngăn xếp tấm đang mở: popup có thể lồng popup, một lần bấm Esc chỉ được đóng tấm trên cùng. Biến ở tầng module chứ không phải state: hai tấm là hai lần gọi hàm khác nhau, chúng cần một chỗ CHUNG
// để biết ai đang ở trên cùng. Mảng này chỉ sống trong trình duyệt và luôn rỗng lại sau khi tấm cuối đóng.
const openStack: symbol[] = [];
/** Giá trị `overflow` của trang trước khi tấm ĐẦU TIÊN khoá cuộn. Chỉ tấm cuối cùng mới trả lại. */
let savedOverflow: string | null = null;

export function Modal({
  open,
  onClose,
  title,
  width = "medium",
  children,
  footer,
  bodyClass,
  fullScreenOnPhone = false,
  hideHeader = false,
  baseZIndex = 50,
}: {
  open: boolean;
  onClose: () => void;
  /** Vừa là đầu đề nhìn thấy, vừa là nhãn cho trình đọc màn hình. */
  title: string;
  width?: ModalWidth;
  children: ReactNode;
  /** Hàng nút đáy. Để trống thì popup không có chân. */
  footer?: ReactNode;
  /**
   * Lớp cho THÂN popup, thay cho lối xếp dọc mặc định. Bọc thêm một lớp là mất luôn khả năng cho khối đầu trải hết
   * ngang.
   */
  bodyClass?: string;
  /**
   * Điện thoại (dưới `sm`) thì popup chiếm TRỌN màn: bỏ đệm lớp phủ, bỏ bo góc, cao `100dvh`, đầu và chân chừa
   * vùng tai thỏ, vạch vuốt. Mặc định TẮT nên mọi chỗ gọi cũ không đổi gì. `dvh` chứ không `vh`: Safari iPhone
   * tính `vh` theo khung khi thanh địa chỉ co lại.
   */
  fullScreenOnPhone?: boolean;
  /**
   * Bỏ khối đầu tấm (tiêu đề + viền đáy), chỉ giữ nút ✕ ở góc trên phải bên trong card. `title` vẫn bắt buộc vì
   * vẫn là `aria-label`. Mặc định TẮT nên mọi chỗ gọi cũ không đổi gì. Không tính vùng tai thỏ của
   * `fullScreenOnPhone`.
   */
  hideHeader?: boolean;
  /** Tầng của tấm dưới cùng, các tầng sau vẫn cộng dần 10. Mặc định 50 nên mọi chỗ gọi cũ không đổi gì. */
  baseZIndex?: number;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  /** Chỗ đứng trong ngăn xếp. `0` là tấm dưới cùng. Dùng để xếp tầng, xem `useEffect` bên dưới. */
  const [depth, setDepth] = useState(0);
  /** Thẻ nhận dạng riêng của tấm này trong ngăn xếp. `useRef` để nó sống qua mọi lượt dựng lại. */
  const token = useRef<symbol>(Symbol("modal"));

  useEffect(() => {
    if (!open) return;
    const me = token.current;
    openStack.push(me);
    setDepth(openStack.length - 1);

    // Chỉ tấm ĐẦU TIÊN khoá cuộn nền, và chỉ tấm CUỐI CÙNG trả lại. Đừng để mỗi tấm tự lưu rồi tự trả: thứ tự dọn của
    // React không bảo đảm theo thứ tự mở, nên tấm ngoài có thể trả lại một giá trị đã bị tấm trong ghi đè, và trang
    // kẹt ở trạng thái không cuộn được.
    if (openStack.length === 1) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }

    // Esc đóng popup. Gắn ở `document` chứ không ở card: lúc con trỏ đang nằm trong một ô nhập thì phím không nổi lên
    // tới card nếu ô ấy nuốt sự kiện. Nhưng CHỈ tấm trên cùng được phản ứng, nếu không thì một lần Esc đóng cả chồng.
    const onKey = (e: KeyboardEvent) => {
      // Phím đã có ô con xử lý (ô lịch, ô huỷ sửa) thì để yên popup.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (openStack[openStack.length - 1] !== me) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("keydown", onKey);
      const i = openStack.indexOf(me);
      if (i >= 0) openStack.splice(i, 1);
      if (openStack.length === 0) {
        document.body.style.overflow = savedOverflow ?? "";
        savedOverflow = null;
      }
    };
  }, [open, onClose]);

  if (!open) return null;

  // Tấm mở sau luôn nằm trên tấm mở trước. Mốc `baseZIndex` mặc định 50, các tầng sau cộng dần 10.
  const zIndex = baseZIndex + depth * 10;

  return (
    <div
      className={cn("fixed inset-0 flex items-center justify-center bg-black/60 p-[var(--block-pad)]", fullScreenOnPhone && "max-sm:p-0")}
      style={{ zIndex }}
      // Bấm ra NỀN thì đóng. Kiểm `e.target === e.currentTarget` chứ đừng bắt mọi cú bấm nổi lên: bấm trong card cũng
      // nổi tới đây, và popup sẽ tự đóng giữa lúc đang nhập.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          // `100dvh` chứ không phải `100vh`: Safari iPhone tính `vh` theo khung nhìn KHI THANH ĐỊA CHỈ CO LẠI, nên tấm cao
          // quá khung đang thấy và đáy (nút chân hộp) bị che.
          "flex max-h-[calc(100dvh-2rem)] w-full flex-col rounded-card border border-border bg-surface",
          WIDTH_CLASS[width],
          fullScreenOnPhone && "max-sm:h-dvh max-sm:max-h-dvh max-sm:rounded-none max-sm:border-0",
          // `relative` CHỈ khi bỏ đầu tấm (gốc cho nút ✕ `absolute`). Thêm cho mọi tấm thì phần tử `absolute` trong thân của
          // chỗ gọi cũ đổi gốc định vị từ lớp phủ sang card.
          hideHeader && "relative",
        )}
      >
        {hideHeader ? (
          // Thẻ bọc giữ vị trí `absolute`: `touch-target` đặt `position: relative` nên không gắn thẳng cho nút `absolute`.
          <div className="absolute right-3 top-3">
            <button
              type="button"
              onClick={onClose}
              aria-label="Đóng"
              className="touch-target flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-muted"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        ) : (
          <div
            className={cn(
              "flex items-center justify-between gap-2 border-b border-border p-[var(--block-pad)]",
              fullScreenOnPhone && "max-sm:pt-[max(var(--block-pad),env(safe-area-inset-top))]",
            )}
          >
            <h2 className="text-title font-semibold text-fg">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Đóng"
              className="touch-target flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-muted"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        )}

        {/* Chỉ THÂN cuộn, đầu đề và chân đứng yên. Cho cả tấm cuộn thì nút Tạo trôi khỏi tầm mắt đúng lúc người dùng cần nó nhất. */}
        <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain p-[var(--block-pad)]", bodyClass ?? "flex flex-col gap-3")}>
          {children}
        </div>

        {footer && (
          <div
            className={cn(
              "flex items-center justify-end gap-2 border-t border-border p-[var(--block-pad)]",
              fullScreenOnPhone && "max-sm:pb-[max(var(--block-pad),env(safe-area-inset-bottom))]",
            )}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
