"use client";

// Khối gập của màn chi tiết dự án intercom: mũi tên, icon, nhãn, số lượng là nút gập; nút Thêm đứng cạnh, không
// lồng trong nút gập. Bấm Thêm mở khối trong cùng lượt: `Modal`, `useConfirm` không dùng portal nên popup nằm
// trong thân `hidden` sẽ không hiện. Thân khối gập chỉ ẩn, không gỡ khỏi cây: giữ chữ đang gõ ở ô không điều khiển
// và số lượng tải trong khối. Không dùng `CollapsibleBlock` vì khối đó tự giữ trạng thái gập, không có cách mở từ
// ngoài.

import { useId, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown, Plus, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

export function IntercomAccordionBlock({
  title,
  icon: Icon,
  count,
  defaultOpen = false,
  onAdd,
  children,
}: {
  title: string;
  icon: LucideIcon;
  /** Số lượng trong ngoặc sau nhãn; không truyền (khối Link, hoặc đang tải) thì không in ngoặc. */
  count?: number;
  defaultOpen?: boolean;
  /** Có thì hiện nút Thêm cùng hàng tiêu đề; không truyền khi người xem không được thêm. */
  onAdd?: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();

  return (
    <section className="rounded-card border border-border bg-surface p-3">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((value) => !value)}
            className="flex min-h-11 w-full items-center gap-2 rounded-control text-left active:bg-surface-2 focus-visible:outline-2 focus-visible:outline-fg"
          >
            <ChevronDown
              className={cn("size-4 shrink-0 text-muted motion-safe:transition-transform", open ? null : "-rotate-90")}
              aria-hidden
            />
            <Icon className="size-4 shrink-0 text-fg" aria-hidden />
            <span className="min-w-0 text-block font-semibold text-fg">
              {title}
              {count === undefined ? "" : ` (${count})`}
            </span>
          </button>
        </h2>
        {onAdd ? (
          <button
            type="button"
            aria-label={`Thêm vào ${title}`}
            onClick={() => {
              setOpen(true);
              onAdd();
            }}
            className="flex h-11 shrink-0 items-center gap-1.5 rounded-control border border-border bg-surface px-3 text-base text-fg active:bg-surface-2"
          >
            <Plus className="size-4" aria-hidden />
            Thêm
          </button>
        ) : null}
      </div>
      <div id={bodyId} hidden={!open} className="space-y-2 pt-2">
        {children}
      </div>
    </section>
  );
}
