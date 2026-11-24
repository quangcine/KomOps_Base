"use client";

// Sheet đáy của màn Giao: chụp hoặc chọn ảnh xong mới hiện; nền `surface`, bo trên 16, cao tối đa 88dvh, thân cuộn
// bên trong, chân (tiến độ, nút Lưu) dính đáy sheet. Nút X hoặc vuốt xuống ở đầu sheet là đóng (màn gọi bỏ ảnh);
// `closeDisabled` (đang Lưu) thì không đóng được. Bàn phím iPhone không co khung bố cục: sheet đọc
// `visualViewport` để đáy nằm ngay trên bàn phím và cao không quá phần màn còn thấy, nên ô gõ tên, danh sách gợi ý
// và nút Lưu đều ở trên bàn phím.

import { useEffect, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

/** Kéo đầu sheet xuống quá khoảng này rồi thả là đóng. */
const DRAG_CLOSE_PX = 80;
/** Khoảng chừa trên đỉnh sheet khi bàn phím mở (phần màn còn thấy hẹp). */
const SHEET_TOP_GAP_PX = 12;

type VisibleViewport = { bottom: number; height: number };

type IntercomCaptureSheetProps = {
  title: ReactNode;
  closeLabel: string;
  closeDisabled: boolean;
  onClose: () => void;
  /** Thân cuộn của sheet: màn gọi cuộn khối gợi ý tên trong thân này. */
  bodyRef: RefObject<HTMLDivElement | null>;
  /** Chân dính đáy: màn gọi đo đỉnh chân để danh sách gợi ý không nằm dưới nút Lưu. */
  footerRef: RefObject<HTMLDivElement | null>;
  footer: ReactNode;
  children: ReactNode;
  /** Phần tử gốc của sheet (thẻ `role="dialog"`): màn gọi đo mép trên sheet để ảnh phủ phần màn còn lại. */
  rootRef?: RefObject<HTMLDivElement | null>;
};

export function IntercomCaptureSheet({
  title,
  closeLabel,
  closeDisabled,
  onClose,
  bodyRef,
  footerRef,
  footer,
  children,
  rootRef,
}: IntercomCaptureSheetProps) {
  const [visible, setVisible] = useState<VisibleViewport | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const bottom = Math.max(0, Math.round(window.innerHeight - (viewport.offsetTop + viewport.height)));
      const height = Math.round(viewport.height);
      setVisible((prev) => (prev && prev.bottom === bottom && prev.height === height ? prev : { bottom, height }));
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  const [drag, setDrag] = useState(0);
  const dragStartRef = useRef<number | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (closeDisabled) return;
    // Bấm nút X thì để nút xử lý, không bắt đầu kéo.
    if ((e.target as HTMLElement).closest("button")) return;
    dragStartRef.current = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragStartRef.current === null) return;
    setDrag(Math.max(0, e.clientY - dragStartRef.current));
  };
  const endDrag = () => {
    if (dragStartRef.current === null) return;
    dragStartRef.current = null;
    const close = drag > DRAG_CLOSE_PX && !closeDisabled;
    setDrag(0);
    if (close) onClose();
  };

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={typeof title === "string" ? title : undefined}
      className={cn(
        "fixed inset-x-0 bottom-0 z-30 mx-auto flex max-h-[88dvh] w-full max-w-xl flex-col rounded-t-2xl bg-surface shadow-[0_-8px_32px_rgba(0,0,0,0.35)]",
        drag === 0 && "transition-transform",
      )}
      style={{
        bottom: visible?.bottom ?? 0,
        maxHeight: visible ? `min(88dvh, ${Math.max(0, visible.height - SHEET_TOP_GAP_PX)}px)` : undefined,
        transform: drag > 0 ? `translateY(${drag}px)` : undefined,
      }}
    >
      <div
        className="shrink-0 touch-none select-none px-3 pt-2"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="mx-auto h-1.5 w-10 rounded-full bg-border" aria-hidden />
        <div className="flex items-center gap-2 pt-1">
          <div className="min-w-0 flex-1 truncate text-block font-semibold text-fg">{title}</div>
          <button
            type="button"
            disabled={closeDisabled}
            onClick={onClose}
            aria-label={closeLabel}
            className="flex size-11 shrink-0 items-center justify-center rounded-full text-fg active:bg-surface-2 disabled:opacity-40"
          >
            <X className="size-6" aria-hidden />
          </button>
        </div>
      </div>
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
        {children}
      </div>
      <div
        ref={footerRef}
        className="shrink-0 space-y-2 border-t border-border bg-surface px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      >
        {footer}
      </div>
    </div>
  );
}
