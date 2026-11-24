"use client";

// Ẩn, hiện Header điện thoại và các hàng đi cùng theo hướng cuộn. Cuộn xuống quá ngưỡng thì ẩn, cuộn lên thì hiện;
// gần đầu vùng luôn hiện; đổi route, đổi mục đỉnh của khe thì hiện lại. Trạng thái ghi lên `<html>` bằng
// `data-chrome-hidden`: CSS đọc thuộc tính này nên đổi trạng thái không vẽ lại vỏ. Một đường ghi: mọi lần đổi
// trạng thái đi qua `writeHidden`. Ngoại lệ duy nhất là phép thử ẩn rồi đo ở màn khung: ghi tạm, thử hỏng thì gỡ
// trực tiếp, không đổi trạng thái React. Không `useEffect` theo `hidden`: thử đạt rồi đổi route trong cùng lượt
// gộp thì thuộc tính sẽ kẹt. Màn khung ẩn bằng `display: none` nên vùng cuộn nở ra. Danh sách dư ít mà ẩn thì hết
// cuộn, lọt đầu vùng, hiện lại, dao động; phép thử đo phần dư thật sau khi ẩn để chặn từ gốc, không cộng tay cao
// các hàng (`flex-wrap`, `gap`, danh sách `invisible`).

import { useEffect, useState } from "react";

/** Quãng cuộn tích luỹ cùng một hướng (px) trước khi đổi trạng thái, để rung tay không làm thanh nhấp nháy. */
const SCROLL_THRESHOLD = 10;
/** Dưới mức này (px) coi là đầu vùng: luôn hiện. */
const TOP_ZONE = 16;
/** Phần dư tối thiểu sau khi ẩn: còn lại không quá số này thì không ẩn. */
const MIN_SPARE_AFTER_HIDE = TOP_ZONE + SCROLL_THRESHOLD;
/** Nhịp sau mỗi lần đổi trạng thái (ms): bỏ qua các `scroll` do trình duyệt kẹp `scrollTop`. */
const SETTLE_MS = 300;
const HIDDEN_ATTRIBUTE = "data-chrome-hidden";
const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

type ScrollSource = Element | Document;

export type ChromeHiddenOptions = {
  /** Mã mục đỉnh của khe: đổi thì hiện lại. */
  resetKey?: string | null;
  /** Tắt hẳn (ngoài khổ điện thoại, hội thoại): gỡ thuộc tính, không nghe gì. */
  enabled?: boolean;
  /**
   * Chỉ nghe cuộn của trang, bỏ mọi điều kiện chặn, phép thử, nhịp 300ms, tác nhân kẹt ẩn, `resetKey` (vỏ
   * Intercom).
   */
  documentOnly?: boolean;
};

function scrollMetrics(source: ScrollSource): { scrollHeight: number; clientHeight: number } {
  if (source instanceof Document) {
    return { scrollHeight: source.documentElement.scrollHeight, clientHeight: window.innerHeight };
  }
  return { scrollHeight: source.scrollHeight, clientHeight: source.clientHeight };
}

function rawScrollTop(source: ScrollSource): number {
  return source instanceof Document ? window.scrollY : source.scrollTop;
}

function restoreScrollTop(source: ScrollSource, top: number): void {
  if (source instanceof Document) window.scrollTo(window.scrollX, top);
  else source.scrollTop = top;
}

/** Vị trí cuộn kẹp trong khoảng hợp lệ: cú nảy đàn hồi của iOS ở hai đầu không được tính là đổi hướng. */
function boundedOffset(source: ScrollSource): number {
  const { scrollHeight, clientHeight } = scrollMetrics(source);
  return Math.min(Math.max(rawScrollTop(source), 0), Math.max(0, scrollHeight - clientHeight));
}

function isHideBlocked(): boolean {
  if (document.activeElement?.matches(EDITABLE_SELECTOR)) return true;
  if (document.querySelector('[data-workspace-region="toolbar"] [aria-expanded="true"]')) return true;
  if (document.querySelector('[role="dialog"]')) return true;
  return document.body.style.overflow === "hidden";
}

export function useChromeHidden(pathname: string, options: ChromeHiddenOptions = {}): boolean {
  const { resetKey = null, enabled = true, documentOnly = false } = options;
  const effectResetKey = documentOnly ? null : resetKey;
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;

    let isHidden = false;
    let travel = 0;
    let settleUntil = 0;
    let settleTimer = 0;
    let frame = 0;
    let stuckFrame = 0;
    let tracked: ScrollSource | null = null;
    let touchY: number | null = null;
    let touchPull = 0;
    let stopStuckWatch: (() => void) | null = null;

    const pending = new Set<ScrollSource>();
    const lastY = new WeakMap<ScrollSource, number>();
    // Cặp cao đọc lúc đang hiện của lần thử hỏng: cùng cặp thì không thử lại.
    const failedTrials = new WeakMap<ScrollSource, { scrollHeight: number; clientHeight: number }>();
    lastY.set(document, boundedOffset(document));

    const writeHidden = (next: boolean) => {
      if (next) root.setAttribute(HIDDEN_ATTRIBUTE, "");
      else root.removeAttribute(HIDDEN_ATTRIBUTE);
      isHidden = next;
      setHidden(next);
    };

    const checkStuck = () => {
      stuckFrame = 0;
      if (!isHidden || !tracked) return;
      const connected = tracked instanceof Document || tracked.isConnected;
      const { scrollHeight, clientHeight } = scrollMetrics(tracked);
      if (!connected || scrollHeight <= clientHeight) changeHidden(false);
    };

    const scheduleStuckCheck = () => {
      if (stuckFrame === 0) stuckFrame = window.requestAnimationFrame(checkStuck);
    };

    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? null;
      touchPull = 0;
    };

    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      if (y === undefined) return;
      const previous = touchY;
      touchY = y;
      if (previous === null || !tracked) return;
      if (boundedOffset(tracked) >= TOP_ZONE) {
        touchPull = 0;
        return;
      }
      touchPull += y - previous;
      if (isHidden && touchPull > SCROLL_THRESHOLD) changeHidden(false);
    };

    // Ba tác nhân cho các ca không có sự kiện `scroll`, chỉ bật khi đang ẩn.
    const startStuckWatch = (source: ScrollSource) => {
      stopStuckWatch?.();
      const target = source instanceof Document ? source.documentElement : source;
      const mutations = new MutationObserver(scheduleStuckCheck);
      mutations.observe(source instanceof Document ? source.body : source, { childList: true, subtree: true });
      // Bắn ngay lúc gắn và khi khung nở do chính lượt ẩn: `checkStuck` chỉ xét rời DOM và hết cuộn nên không tự hiện.
      const resizes = new ResizeObserver(scheduleStuckCheck);
      resizes.observe(target);
      touchY = null;
      touchPull = 0;
      document.addEventListener("touchstart", onTouchStart, { passive: true });
      document.addEventListener("touchmove", onTouchMove, { passive: true });
      stopStuckWatch = () => {
        mutations.disconnect();
        resizes.disconnect();
        document.removeEventListener("touchstart", onTouchStart);
        document.removeEventListener("touchmove", onTouchMove);
        stopStuckWatch = null;
      };
    };

    const onSettled = () => {
      settleTimer = 0;
      if (isHidden && tracked && boundedOffset(tracked) < TOP_ZONE) changeHidden(false);
    };

    function changeHidden(next: boolean) {
      writeHidden(next);
      travel = 0;
      settleUntil = performance.now() + SETTLE_MS;
      if (settleTimer !== 0) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(onSettled, SETTLE_MS);
      if (next && tracked) startStuckWatch(tracked);
      else stopStuckWatch?.();
    }

    const tryHide = (source: ScrollSource) => {
      if (isHideBlocked()) return;
      if (!document.querySelector("[data-mobile-frame]")) {
        changeHidden(true);
        return;
      }
      const shown = scrollMetrics(source);
      const failed = failedTrials.get(source);
      if (failed && failed.scrollHeight === shown.scrollHeight && failed.clientHeight === shown.clientHeight) {
        travel = 0;
        return;
      }
      const savedTop = rawScrollTop(source);
      root.setAttribute(HIDDEN_ATTRIBUTE, "");
      // Đọc `scrollHeight` tự ép tính lại bố cục; chạy trong khung hình nên trình duyệt chưa vẽ.
      const { scrollHeight, clientHeight } = scrollMetrics(source);
      if (scrollHeight - clientHeight > MIN_SPARE_AFTER_HIDE) {
        changeHidden(true);
        return;
      }
      root.removeAttribute(HIDDEN_ATTRIBUTE);
      restoreScrollTop(source, savedTop);
      failedTrials.set(source, shown);
      travel = 0;
    };

    const evaluateDocumentOnly = () => {
      const y = boundedOffset(document);
      const delta = y - (lastY.get(document) ?? y);
      lastY.set(document, y);
      if (y < TOP_ZONE) {
        travel = 0;
        writeHidden(false);
        return;
      }
      if (delta === 0) return;
      travel = Math.sign(delta) === Math.sign(travel) ? travel + delta : delta;
      if (travel > SCROLL_THRESHOLD) writeHidden(true);
      else if (travel < -SCROLL_THRESHOLD) writeHidden(false);
    };

    const evaluate = (source: ScrollSource) => {
      const y = boundedOffset(source);
      const previous = lastY.get(source);
      lastY.set(source, y);
      // `scrollTop` không đổi: cuộn ngang, hoặc lượt kẹp rồi trả.
      if (previous === undefined || y === previous) return;
      const delta = y - previous;
      if (performance.now() < settleUntil) {
        travel = 0;
        return;
      }
      if (source !== tracked) {
        tracked = source;
        travel = 0;
        if (isHidden) startStuckWatch(source);
      }
      if (y < TOP_ZONE) {
        travel = 0;
        if (isHidden) changeHidden(false);
        return;
      }
      travel = Math.sign(delta) === Math.sign(travel) ? travel + delta : delta;
      if (travel > SCROLL_THRESHOLD && !isHidden) tryHide(source);
      else if (travel < -SCROLL_THRESHOLD && isHidden) changeHidden(false);
    };

    const flush = () => {
      frame = 0;
      if (documentOnly) {
        evaluateDocumentOnly();
        return;
      }
      const sources = [...pending];
      pending.clear();
      sources.forEach(evaluate);
    };

    const onScroll = (e: Event) => {
      const target = e.target;
      if (target === document) {
        pending.add(document);
      } else {
        if (documentOnly || !(target instanceof Element)) return;
        // Chỉ vùng trong `<main>` và có cuộn dọc thật (loại phần lớn `overflow-x-auto`).
        if (!target.closest("main") || target.scrollHeight <= target.clientHeight) return;
        pending.add(target);
      }
      if (frame === 0) frame = window.requestAnimationFrame(flush);
    };

    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      if (frame !== 0) window.cancelAnimationFrame(frame);
      if (stuckFrame !== 0) window.cancelAnimationFrame(stuckFrame);
      if (settleTimer !== 0) window.clearTimeout(settleTimer);
      stopStuckWatch?.();
      // Đổi route, đổi mục đỉnh, tắt `enabled`, gỡ khỏi cây đều đi qua đây nên hiện ngay, không chờ nhịp.
      writeHidden(false);
    };
  }, [pathname, effectResetKey, enabled, documentOnly]);

  return hidden;
}
