"use client";

// Trình xem ẢNH và VIDEO toàn màn hình dùng chung. Video không tự phát: bấm mới chạy. Tệp này không nhập gì từ
// app.
// - `onMediaError(item)`: `<img>`, `<video>` báo `error` (ví dụ vé hết hạn); chỗ gọi làm mới `src` nếu cần.
// - `src` của CÙNG mục đổi (vé mới) thì video GIỮ chỗ đang xem và trạng thái đang phát: nạp `src` mới, tua về chỗ
// cũ, phát tiếp nếu trước đó đang phát.
// - Cảm ứng: vuốt ngang quá 50px lật mục (chỉ khi 100%, một ngón); chụm hai ngón phóng ảnh trong [1, MAX_ZOOM];
// phóng quá 100% thì kéo một ngón (hoặc chuột) dời ảnh, kẹp để mép ảnh không lùi vào quá mép khung. Lớp phủ
// `touch-action: none` để Safari không phóng cả trang. Sau vuốt, kéo, chụm thì nuốt `click` kế tiếp (chạm thường
// vẫn đóng). Vuốt bắt đầu trên thẻ `<video>` không tính: thanh điều khiển của video dùng kéo ngang để tua, không
// phân biệt được vùng nào.
// - Nút nổi (Đóng, Ảnh trước, Ảnh sau): thẻ ngoài giữ `absolute`, `touch-target` gắn vào nút con; `globals.css` đặt
// `.touch-target { position: relative }` trên màn cảm ứng, gắn thẳng vào phần tử `absolute` là phá vị trí.

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Minus, Plus, X } from "lucide-react";

const MAX_ZOOM = 4;
/** Dịch ngang tối thiểu (px) để tính là vuốt lật. */
const SWIPE_MIN_PX = 50;
/** Dịch quá ngưỡng này (px) thì coi là kéo, không còn là chạm thường. */
const TAP_SLOP_PX = 8;

type Point = { x: number; y: number };
type Gesture = {
  start: Point;
  startOffset: Point;
  startZoom: number;
  /** Khoảng cách hai ngón lúc bắt đầu chụm; `0` khi chưa chụm. */
  startDistance: number;
  /** Cử chỉ đã có lúc hai ngón: không còn tính là vuốt, kéo. */
  multi: boolean;
  moved: boolean;
};

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(1, Math.round(z * 100) / 100));
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export type MediaViewerItem = {
  id: string;
  kind: "image" | "video";
  /** Đường đọc tệp; `null` khi chưa có (hiện "Chưa xem được tệp này."). */
  src: string | null;
  /** Ảnh bìa của video. */
  poster?: string | null;
  /** Dòng chữ hiện dưới tệp (ví dụ chặng, giờ, người chụp). */
  caption?: string | null;
  /** Chữ thay thế của ảnh; mặc định "Ảnh". */
  alt?: string | null;
};

export function MediaViewer({
  items,
  currentId,
  onClose,
  onNavigate,
  onMediaError,
}: {
  items: MediaViewerItem[];
  currentId: string;
  onClose: () => void;
  onNavigate: (id: string) => void;
  onMediaError?: (item: MediaViewerItem) => void;
}) {
  const index = items.findIndex((m) => m.id === currentId);
  const current = items[index];
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const areaRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const gestureRef = useRef<Gesture | null>(null);
  /** Vừa vuốt, kéo, chụm: nuốt `click` kế tiếp để trình xem không tự đóng. */
  const suppressClickRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /** Mục và `src` đã nạp vào thẻ `<video>`, để biết `src` đổi trên CÙNG mục. */
  const loadedRef = useRef<{ id: string; src: string } | null>(null);

  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, [currentId]);

  /**
   * Kẹp độ dời theo `zoom`: ảnh phóng lớn hơn khung thì mép ảnh không lùi vào quá mép khung; nhỏ hơn khung thì nằm
   * giữa.
   */
  const clampOffset = useCallback((o: Point, z: number): Point => {
    const area = areaRef.current;
    const image = imageRef.current;
    if (!area || !image || z <= 1) return { x: 0, y: 0 };
    const maxX = Math.max(0, (image.offsetWidth * z - area.clientWidth) / 2);
    const maxY = Math.max(0, (image.offsetHeight * z - area.clientHeight) / 2);
    return { x: Math.min(maxX, Math.max(-maxX, o.x)), y: Math.min(maxY, Math.max(-maxY, o.y)) };
  }, []);

  // `zoom` đổi bằng nút, phím, chụm: kẹp lại độ dời (về 100% thì dời về 0).
  useEffect(() => {
    zoomRef.current = zoom;
    setOffset((o) => {
      const c = clampOffset(o, zoom);
      return c.x === o.x && c.y === o.y ? o : c;
    });
  }, [zoom, clampOffset]);

  const zoomBy = useCallback((d: number) => setZoom((z) => clampZoom(z + d)), []);
  const prev = useCallback(() => {
    if (index > 0) onNavigate(items[index - 1].id);
  }, [index, items, onNavigate]);
  const next = useCallback(() => {
    if (index >= 0 && index < items.length - 1) onNavigate(items[index + 1].id);
  }, [index, items, onNavigate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowUp") zoomBy(0.1);
      else if (e.key === "ArrowDown") zoomBy(-0.1);
      else if (e.key === "Escape") onClose();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, zoomBy, onClose]);

  const currentKey = current?.id ?? null;
  const currentSrc = current?.src ?? null;
  const isVideo = current?.kind === "video";

  // `src` của video đặt bằng mã (không qua thuộc tính) để kịp đọc chỗ đang xem trước khi đổi vé.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isVideo || !currentKey || !currentSrc) return;
    const before = loadedRef.current;
    loadedRef.current = { id: currentKey, src: currentSrc };
    if (before && before.id === currentKey && before.src !== currentSrc && video.currentSrc) {
      const resumeAt = video.currentTime;
      const resume = !video.paused && !video.ended;
      video.src = currentSrc;
      const onReady = () => {
        try {
          video.currentTime = resumeAt;
        } catch {
          // Tệp chưa cho tua: phát từ đầu.
        }
        if (resume) void video.play().catch(() => undefined);
      };
      video.addEventListener("loadedmetadata", onReady, { once: true });
      return () => video.removeEventListener("loadedmetadata", onReady);
    }
    if (video.getAttribute("src") !== currentSrc) video.src = currentSrc;
    return undefined;
  }, [currentKey, currentSrc, isVideo]);

  if (!current) return null;
  const url = current.src;
  const reportError = () => onMediaError?.(current);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Vuốt bắt đầu trên video không tính (thanh điều khiển kéo ngang để tua).
    if (e.target instanceof HTMLVideoElement) return;
    const pointers = pointersRef.current;
    if (pointers.size === 0) suppressClickRef.current = false;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Trình duyệt không cho bắt con trỏ: vẫn nhận sự kiện trong vùng.
    }
    if (pointers.size === 1) {
      gestureRef.current = { start: { x: e.clientX, y: e.clientY }, startOffset: offset, startZoom: zoomRef.current, startDistance: 0, multi: false, moved: false };
    } else if (pointers.size === 2 && gestureRef.current) {
      const [a, b] = [...pointers.values()];
      gestureRef.current = { ...gestureRef.current, multi: true, startDistance: distance(a, b), startZoom: zoomRef.current };
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const pointers = pointersRef.current;
    const gesture = gestureRef.current;
    if (!gesture || !pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture.multi) {
      if (pointers.size === 2 && gesture.startDistance > 0 && !isVideo) {
        const [a, b] = [...pointers.values()];
        setZoom(clampZoom((gesture.startZoom * distance(a, b)) / gesture.startDistance));
      }
      return;
    }
    const dx = e.clientX - gesture.start.x;
    const dy = e.clientY - gesture.start.y;
    if (Math.abs(dx) > TAP_SLOP_PX || Math.abs(dy) > TAP_SLOP_PX) gesture.moved = true;
    // Đang phóng: kéo là dời ảnh, không lật.
    if (gesture.startZoom > 1 && !isVideo) setOffset(clampOffset({ x: gesture.startOffset.x + dx, y: gesture.startOffset.y + dy }, zoomRef.current));
  };

  const endPointer = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const pointers = pointersRef.current;
    const gesture = gestureRef.current;
    if (!pointers.delete(e.pointerId) || !gesture) return;
    if (gesture.moved || gesture.multi) suppressClickRef.current = true;
    if (pointers.size > 0) return;
    gestureRef.current = null;
    if (cancelled || gesture.multi || gesture.startZoom > 1) return;
    const dx = e.clientX - gesture.start.x;
    const dy = e.clientY - gesture.start.y;
    if (Math.abs(dx) > SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) next();
      else prev();
    }
  };

  const onAreaClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (!isVideo) onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-[70] flex touch-none items-center justify-center bg-black/95" role="dialog" aria-modal="true" aria-label="Xem ảnh, video">
      <div
        ref={areaRef}
        className="flex size-full items-center justify-center overflow-hidden p-12"
        onClick={onAreaClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endPointer(e, false)}
        onPointerCancel={(e) => endPointer(e, true)}
      >
        {!url ? (
          <p className="text-body text-white/80">Chưa xem được tệp này.</p>
        ) : isVideo ? (
          <video
            key={current.id}
            ref={videoRef}
            controls
            playsInline
            poster={current.poster ?? undefined}
            onError={reportError}
            className="max-h-full max-w-full"
            style={{ transform: `scale(${zoom})` }}
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- đường ký, route riêng tư: không qua bộ tối ưu ảnh.
          <img
            key={current.id}
            ref={imageRef}
            src={url}
            alt={current.alt ?? "Ảnh"}
            onError={reportError}
            draggable={false}
            className="max-h-full max-w-full object-contain"
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
          />
        )}
      </div>
      <div className="absolute right-3 top-3">
        <button type="button" onClick={onClose} aria-label="Đóng" className="touch-target flex size-10 items-center justify-center rounded-full bg-white/15 text-white">
          <X className="size-6" aria-hidden />
        </button>
      </div>
      {index > 0 && (
        <div className="absolute left-3 top-1/2 -translate-y-1/2">
          <button type="button" onClick={prev} aria-label="Ảnh trước" className="touch-target flex size-12 items-center justify-center rounded-full bg-white/15 text-white">
            <ChevronLeft className="size-7" aria-hidden />
          </button>
        </div>
      )}
      {index < items.length - 1 && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2">
          <button type="button" onClick={next} aria-label="Ảnh sau" className="touch-target flex size-12 items-center justify-center rounded-full bg-white/15 text-white">
            <ChevronRight className="size-7" aria-hidden />
          </button>
        </div>
      )}
      {!isVideo && (
        <div className="absolute bottom-16 right-3 flex flex-col gap-2">
          <button type="button" onClick={() => zoomBy(0.1)} aria-label="Phóng to" className="touch-target flex size-10 items-center justify-center rounded-full bg-white/15 text-white">
            <Plus className="size-5" aria-hidden />
          </button>
          <button type="button" onClick={() => zoomBy(-0.1)} aria-label="Thu nhỏ" className="touch-target flex size-10 items-center justify-center rounded-full bg-white/15 text-white">
            <Minus className="size-5" aria-hidden />
          </button>
        </div>
      )}
      <div className="absolute bottom-6 flex w-full flex-col items-center gap-1 px-16 text-center text-label text-white/70">
        {current.caption ? <p className="max-w-full truncate text-white/85">{current.caption}</p> : null}
        <p>
          {index + 1} / {items.length}
          {zoom > 1 ? ` · ${Math.round(zoom * 100)}%` : ""}
        </p>
      </div>
    </div>,
    document.body,
  );
}
