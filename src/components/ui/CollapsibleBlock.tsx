"use client";

// Khối nội dung gập mở được. Khối gập vẫn giữ chỗ trong cột tràn (chỉ còn tiêu đề).
// · `BlockColumns`: cột tràn CSS `columns` (cột tối thiểu 325px, khe 12, dưới 768 là 8): khối ngắn thì khối sau
// đẩy lên, không ô trống; KHÔNG dùng `grid` hàng đều. Khối trải ngang (`[column-span:all]`) phải kèm
// `not-first:mt-3 max-md:not-first:mt-2`: trình duyệt cắt lề đáy của khối cuối mỗi cột ở chỗ ngắt cột, thiếu lề
// trên thì khối trải ngang dính sát khối trên. Không có Provider thì mỗi khối tự nhớ riêng (state cục bộ). Không
// ghi `localStorage`.

import { createContext, useCallback, useContext, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

type CollapseMemory = {
  isCollapsed: (key: string, fallback: boolean) => boolean;
  toggle: (key: string, fallback: boolean) => void;
};

const CollapseMemoryContext = createContext<CollapseMemory | null>(null);

/** Giữ trạng thái gập của mọi khối bên trong theo tên khối, trong phiên trang (mất khi tải lại trang). */
export function CollapseMemoryProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Khoá chưa từng bấm thì lấy `fallback` (= `defaultCollapsed` của khối); bấm thì đảo đúng giá trị đang thấy.
  const isCollapsed = useCallback((key: string, fallback: boolean) => collapsed[key] ?? fallback, [collapsed]);
  const toggle = useCallback(
    (key: string, fallback: boolean) => setCollapsed((prev) => ({ ...prev, [key]: !(prev[key] ?? fallback) })),
    [],
  );
  const value = useMemo(() => ({ isCollapsed, toggle }), [isCollapsed, toggle]);
  return <CollapseMemoryContext.Provider value={value}>{children}</CollapseMemoryContext.Provider>;
}

/** Cột tràn chứa các `CollapsibleBlock`: rộng nhiều cột cạnh nhau, hẹp còn một cột. */
export function BlockColumns({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("columns-[325px] gap-3 max-md:gap-2", className)}>{children}</div>;
}

export function CollapsibleBlock({
  title,
  memoryKey,
  badge,
  aside,
  action,
  children,
  className,
  defaultCollapsed = false,
}: {
  /** Tiêu đề khối (chữ trên nút gập). */
  title: string;
  /** Khoá nhớ trạng thái gập; bỏ trống là `title` (cùng tên khối thì cùng trạng thái khi đổi bản ghi). */
  memoryKey?: string;
  /** Vẽ sau tiêu đề, trong nút (ví dụ một nhãn nhỏ). */
  badge?: ReactNode;
  /** Chữ phụ sau tiêu đề, trong nút (ví dụ "12 tháng gần nhất"). */
  aside?: ReactNode;
  /** Nút thao tác ở góc trên phải, NGOÀI nút gập. */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * Mở trang ở trạng thái gập (mặc định `false`: mở). Có Provider thì chỉ áp khi khoá chưa từng bấm trong phiên
   * trang.
   */
  defaultCollapsed?: boolean;
}) {
  const memory = useContext(CollapseMemoryContext);
  const [localCollapsed, setLocalCollapsed] = useState(defaultCollapsed);
  const key = memoryKey ?? title;
  const collapsed = memory ? memory.isCollapsed(key, defaultCollapsed) : localCollapsed;
  const toggle = () => (memory ? memory.toggle(key, defaultCollapsed) : setLocalCollapsed((v) => !v));
  const bodyId = useId();

  return (
    <section
      aria-label={title}
      className={cn(
        "mb-3 min-w-0 break-inside-avoid rounded-card border border-border p-3 max-md:mb-2 max-md:p-2",
        className,
      )}
    >
      <div className="flex items-center gap-1">
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        onClick={toggle}
        className={cn(
          "-m-1 flex min-h-10 items-center gap-2 rounded-lg p-1 text-left hover:bg-surface-2 active:bg-surface-2 focus-visible:outline-2 focus-visible:outline-fg",
          action != null ? "min-w-0 flex-1" : "w-[calc(100%+0.5rem)]",
        )}
      >
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-base font-semibold text-fg">{title}</span>
          {badge}
          {aside ? <span className="text-label text-muted">{aside}</span> : null}
        </span>
        <ChevronDown
          className={cn("size-4 shrink-0 text-muted motion-safe:transition-transform", collapsed ? "-rotate-90" : null)}
          aria-hidden
        />
      </button>
      {action != null ? <div className="-my-1 flex shrink-0 items-center gap-1">{action}</div> : null}
      </div>
      <div id={bodyId} hidden={collapsed} className="pt-1">
        {children}
      </div>
    </section>
  );
}
