"use client";

// Khung ảnh đặt `touch-none`, cử chỉ tự xử bằng Pointer Events; `gesturestart`, `gesturechange` (riêng Safari) bị
// chặn trong khung để Safari không phóng trang. `viewport` của trang giữ nguyên: màn khác vẫn phóng được bằng
// trình duyệt. Biến đổi gắn thẳng vào `style.transform` của lớp bọc (không qua state React) để mỗi lần di ngón
// không vẽ lại cả màn. Lớp bọc là `absolute inset-0` trong khung, gốc biến đổi góc trên trái (`origin-top-left`).

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

const MAX_SCALE = 5;
const DOUBLE_TAP_MS = 300;
// Ngón dời quá chừng này thì không còn là chạm.
const TAP_SLOP_PX = 8;
// Hai lần chạm cách nhau quá chừng này thì không tính là chạm hai lần.
const DOUBLE_TAP_SLOP_PX = 40;

type Point = { x: number; y: number };
type View = { scale: number; x: number; y: number };
type Gesture = { start: View; points: Point[] };
type Press = { start: Point; moved: boolean; multi: boolean };

const IDENTITY: View = { scale: 1, x: 0, y: 0 };

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function middle(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function useImageZoom({
  resetKey,
  contentWidth,
  contentHeight,
  onSingleTap,
}: {
  // Đổi khoá thì về 1x (đổi ảnh, mở hay đóng toàn màn).
  resetKey: string;
  // Cỡ gốc của ảnh, để biết phần ảnh thật trong khung (`object-contain` để dải nền hai bên).
  contentWidth: number;
  contentHeight: number;
  // Chạm một lần ở 1x, chạy sau khi hết khoảng chạm hai lần.
  onSingleTap: () => void;
}) {
  const frameRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  const viewRef = useRef<View>(IDENTITY);
  const pointersRef = useRef(new Map<number, Point>());
  const gestureRef = useRef<Gesture | null>(null);
  const pressRef = useRef<Press | null>(null);
  const lastTapRef = useRef<{ time: number; point: Point } | null>(null);
  const singleTimerRef = useRef<number | null>(null);
  const detachRef = useRef<(() => void) | null>(null);
  const optionsRef = useRef({ contentWidth, contentHeight, onSingleTap });
  useLayoutEffect(() => {
    optionsRef.current = { contentWidth, contentHeight, onSingleTap };
  });

  const apply = useCallback(() => {
    const content = contentRef.current;
    if (!content) return;
    const { scale, x, y } = viewRef.current;
    content.style.transform = scale === 1 && x === 0 && y === 0 ? "" : `translate(${x}px, ${y}px) scale(${scale})`;
  }, []);

  // Giới hạn dời: ảnh rộng hơn khung thì mép ảnh không vào trong khung; hẹp hơn thì ảnh nằm giữa khung theo chiều
  // đó.
  const clampView = useCallback((view: View): View => {
    const frame = frameRef.current;
    if (!frame) return IDENTITY;
    const width = frame.clientWidth;
    const height = frame.clientHeight;
    const { contentWidth: naturalWidth, contentHeight: naturalHeight } = optionsRef.current;
    let imageWidth = width;
    let imageHeight = height;
    if (naturalWidth > 0 && naturalHeight > 0 && width > 0 && height > 0) {
      const ratio = Math.min(width / naturalWidth, height / naturalHeight);
      imageWidth = naturalWidth * ratio;
      imageHeight = naturalHeight * ratio;
    }
    const imageLeft = (width - imageWidth) / 2;
    const imageTop = (height - imageHeight) / 2;
    const scale = clamp(view.scale, 1, MAX_SCALE);
    const axis = (offset: number, frameSize: number, start: number, size: number) =>
      scale * size <= frameSize
        ? (frameSize - scale * size) / 2 - scale * start
        : clamp(offset, frameSize - scale * (start + size), -scale * start);
    return {
      scale,
      x: axis(view.x, width, imageLeft, imageWidth),
      y: axis(view.y, height, imageTop, imageHeight),
    };
  }, []);

  const clearSingleTimer = useCallback(() => {
    if (singleTimerRef.current !== null) {
      window.clearTimeout(singleTimerRef.current);
      singleTimerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clearSingleTimer();
    lastTapRef.current = null;
    viewRef.current = IDENTITY;
    apply();
  }, [apply, clearSingleTimer]);

  const rebase = useCallback(() => {
    gestureRef.current = { start: { ...viewRef.current }, points: [...pointersRef.current.values()].slice(0, 2) };
  }, []);

  const handleTap = useCallback(
    (point: Point) => {
      const now = performance.now();
      const last = lastTapRef.current;
      clearSingleTimer();
      if (last && now - last.time < DOUBLE_TAP_MS && distance(last.point, point) < DOUBLE_TAP_SLOP_PX) {
        reset();
        return;
      }
      lastTapRef.current = { time: now, point };
      // Đang phóng thì chạm một lần không làm gì (chỉ chờ chạm thứ hai để về 1x).
      if (viewRef.current.scale !== 1) return;
      singleTimerRef.current = window.setTimeout(() => {
        singleTimerRef.current = null;
        // Ngón đang đặt lúc hẹn giờ tới (sắp chụm, kéo): bỏ lượt chạm một lần này.
        if (viewRef.current.scale === 1 && pointersRef.current.size === 0) optionsRef.current.onSingleTap();
      }, DOUBLE_TAP_MS);
    },
    [clearSingleTimer, reset],
  );

  const bindFrame = useCallback(
    (element: HTMLElement | null) => {
      detachRef.current?.();
      detachRef.current = null;
      frameRef.current = element;
      pointersRef.current.clear();
      gestureRef.current = null;
      pressRef.current = null;
      if (!element) return;

      const locate = (event: PointerEvent): Point => {
        const rect = element.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
      };
      const onDown = (event: PointerEvent) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        const pointers = pointersRef.current;
        // Chỉ theo dõi tối đa hai ngón.
        if (pointers.size >= 2) return;
        const point = locate(event);
        pointers.set(event.pointerId, point);
        try {
          element.setPointerCapture(event.pointerId);
        } catch {
          // Điểm giả (không có ngón thật) có thể không bắt được: bỏ qua, vẫn nhận sự kiện trong khung.
        }
        if (pointers.size === 1) pressRef.current = { start: point, moved: false, multi: false };
        else {
          if (pressRef.current) pressRef.current.multi = true;
          // Ngón thứ hai đặt xuống: bỏ việc chạm một lần đang chờ.
          clearSingleTimer();
        }
        rebase();
      };
      const onMove = (event: PointerEvent) => {
        const pointers = pointersRef.current;
        if (!pointers.has(event.pointerId)) return;
        const point = locate(event);
        pointers.set(event.pointerId, point);
        const press = pressRef.current;
        if (press && !press.moved && pointers.size === 1 && distance(press.start, point) > TAP_SLOP_PX) press.moved = true;
        const gesture = gestureRef.current;
        if (!gesture) return;
        const points = [...pointers.values()];
        const start = gesture.start;
        let next: View | null = null;
        if (points.length >= 2) {
          if (gesture.points.length < 2) {
            rebase();
            return;
          }
          const startDistance = distance(gesture.points[0], gesture.points[1]);
          if (startDistance <= 0) return;
          const startMiddle = middle(gesture.points[0], gesture.points[1]);
          const nowMiddle = middle(points[0], points[1]);
          const scale = clamp((start.scale * distance(points[0], points[1])) / startDistance, 1, MAX_SCALE);
          // Điểm ảnh nằm dưới điểm giữa hai ngón lúc đầu thì vẫn nằm dưới điểm giữa hiện tại.
          const anchorX = (startMiddle.x - start.x) / start.scale;
          const anchorY = (startMiddle.y - start.y) / start.scale;
          next = { scale, x: nowMiddle.x - anchorX * scale, y: nowMiddle.y - anchorY * scale };
        } else if (points.length === 1 && start.scale > 1 && gesture.points.length === 1) {
          next = {
            scale: start.scale,
            x: start.x + points[0].x - gesture.points[0].x,
            y: start.y + points[0].y - gesture.points[0].y,
          };
        }
        if (!next) return;
        viewRef.current = clampView(next);
        apply();
      };
      const onUp = (event: PointerEvent) => {
        const pointers = pointersRef.current;
        if (!pointers.has(event.pointerId)) return;
        pointers.delete(event.pointerId);
        if (pointers.size > 0) {
          // Nhấc một trong hai ngón: ngón còn lại dời ảnh tiếp từ chỗ đang đứng.
          rebase();
          return;
        }
        gestureRef.current = null;
        const press = pressRef.current;
        pressRef.current = null;
        // Lượt hủy, lượt mất bắt điểm (`lostpointercapture` không kèm `pointerup`) không tính là chạm.
        if (event.type !== "pointerup" || !press || press.moved || press.multi) return;
        handleTap(locate(event));
      };
      // Safari: chặn phóng cả trang khi chụm trong khung.
      const blockPageZoom = (event: Event) => event.preventDefault();
      // Khung đổi cỡ (tấm dưới đổi cao, xoay máy) khi đang phóng: giới hạn lại vị trí.
      const resizeObserver = new ResizeObserver(() => {
        if (viewRef.current.scale === 1) return;
        viewRef.current = clampView(viewRef.current);
        apply();
      });

      element.addEventListener("pointerdown", onDown);
      element.addEventListener("pointermove", onMove);
      element.addEventListener("pointerup", onUp);
      element.addEventListener("pointercancel", onUp);
      element.addEventListener("lostpointercapture", onUp);
      element.addEventListener("gesturestart", blockPageZoom, { passive: false });
      element.addEventListener("gesturechange", blockPageZoom, { passive: false });
      resizeObserver.observe(element);
      detachRef.current = () => {
        element.removeEventListener("pointerdown", onDown);
        element.removeEventListener("pointermove", onMove);
        element.removeEventListener("pointerup", onUp);
        element.removeEventListener("pointercancel", onUp);
        element.removeEventListener("lostpointercapture", onUp);
        element.removeEventListener("gesturestart", blockPageZoom);
        element.removeEventListener("gesturechange", blockPageZoom);
        resizeObserver.disconnect();
      };
    },
    [apply, clampView, clearSingleTimer, handleTap, rebase],
  );

  const bindContent = useCallback(
    (element: HTMLElement | null) => {
      contentRef.current = element;
      apply();
    },
    [apply],
  );

  useEffect(() => {
    reset();
  }, [resetKey, reset]);

  useEffect(() => clearSingleTimer, [clearSingleTimer]);

  return { bindFrame, bindContent };
}
