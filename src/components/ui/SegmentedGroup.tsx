"use client";

// `kind="tablist"` để dựng tab của một bản ghi; đừng gọi thẳng kiểu này để đổi kiểu xem.

import { useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/cn";

/** `badge`: vẽ sau chữ, trong viên; không truyền thì viên y cũ. */
export type SegmentedOption<T extends string> = { value: T; label: string; icon?: ReactNode; badge?: ReactNode };

/** Thuộc tính thêm cho từng viên, để gắn `id`, `aria-controls`. */
export type SegmentedItemProps = { id?: string; "aria-controls"?: string };

/** Viền focus vẽ vào trong: khung cuộn ngang xén viền ngoài; màu `fg` thấy được cả trên viên chọn nền cam. */
const FOCUS_ITEM = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-fg";

export function SegmentedGroup<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  kind = "group",
  labelHidden = false,
  className,
  itemProps,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
  kind?: "group" | "tablist";
  /** Chỉ hiện icon, viên vuông 32; chữ vào `title` và `aria-label`. */
  labelHidden?: boolean;
  className?: string;
  itemProps?: (v: T) => SegmentedItemProps;
}) {
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const usesTabRole = kind === "tablist";

  // Bàn phím kiểu tablist (WAI-ARIA): ←/→ vòng quanh, Home/End về đầu cuối; chọn luôn khi tới (tự kích hoạt).
  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!usesTabRole) return;
    const last = options.length - 1;
    let next: number;
    if (e.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (e.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else return;
    e.preventDefault();
    const target = options[next];
    if (!target) return;
    onChange(target.value);
    itemRefs.current[next]?.focus();
  }

  return (
    <div
      role={usesTabRole ? "tablist" : "group"}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex h-10 max-w-full shrink-0 gap-0.5 overflow-x-auto rounded-full border border-border bg-surface p-[3px]",
        className,
      )}
    >
      {options.map((opt, i) => {
        const isSelected = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            type="button"
            role={usesTabRole ? "tab" : undefined}
            aria-selected={usesTabRole ? isSelected : undefined}
            aria-pressed={usesTabRole ? undefined : isSelected}
            tabIndex={usesTabRole ? (isSelected ? 0 : -1) : undefined}
            aria-label={labelHidden ? opt.label : undefined}
            title={labelHidden ? opt.label : undefined}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => handleKeyDown(e, i)}
            className={cn(
              "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full text-body",
              labelHidden ? "w-8" : "px-3",
              isSelected ? "bg-brand-cta font-medium text-white" : "text-muted hover:bg-surface-2 hover:text-fg",
              FOCUS_ITEM,
              // Có huy hiệu: `relative` giữ chữ `sr-only` (absolute) của huy hiệu trong viên, không thoát khung cuộn.
              opt.badge ? "relative" : undefined,
            )}
            {...itemProps?.(opt.value)}
          >
            {opt.icon ? (
              <span className="inline-flex shrink-0" aria-hidden>
                {opt.icon}
              </span>
            ) : null}
            {labelHidden ? null : opt.label}
            {opt.badge ?? null}
          </button>
        );
      })}
    </div>
  );
}
