"use client";

// Thanh công cụ của màn danh sách. KHE CÓ TÊN, THỨ TỰ CỨNG, màn không đổi được thứ tự: `view` ·
// `viewSettings` · `search` · `filter` · `timeRange` · `sort` · `tools` · `rightPanelToggle` · `create` (sát
// phải). Nút Tạo là khe `create` cuối thanh: nút tròn 40 biểu tượng +, không dồn vào ⋮. Không có khe công tắc ẩn
// mặc định: công tắc là dòng đầu tấm Lọc; khe `filter` chỉ nhận trạng thái của nó để nút Lọc đếm cả nó và viền
// nhấn khi bật. Mốc bề ngang:
// - từ 1280: một hàng, nút có chữ.
// - dưới 1280: chữ của `ToolbarButton` ẩn, còn icon; rê chuột vẫn ra tên.
// - dưới 1024: `sort` và `tools` dồn vào một nút ⋮ "Thêm công cụ" sát phải; `rightPanelToggle` ẩn. Lọc, khoảng
// thời gian giữ trên thanh dạng icon. Rồi mới cho xuống dòng (`flex-wrap`). Tấm nổi của thanh định vị theo CẢ
// THANH (gốc `relative`), không theo nút: nút Lọc ở màn 390 có thể rơi xuống hàng hai sát trái, tấm 92vw canh phải
// theo nút sẽ tràn ra ngoài mép trái.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, ReactNode, Ref, RefObject } from "react";
import { ArrowUpDown, EllipsisVertical, ListFilter, PanelRight, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { IconButton } from "./Control";

const FOCUS_BUTTON = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

const FOCUS_FIELD = "focus:border-brand focus:outline-none focus:ring-3 focus:ring-brand/35";

// ToolbarButton

type ToolbarButtonProps = {
  icon: ReactNode;
  label: string;
  /** Viền nhấn cam, ví dụ Lọc đang có điều kiện. */
  active?: boolean;
  /** Số nhỏ ở góc nút, hiện ở mọi bề ngang (chữ ẩn dưới 1280 thì số vẫn còn). */
  badge?: number | null;
  ref?: Ref<HTMLButtonElement>;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label" | "title">;

/**
 * Tự viết chuỗi class, không dùng `Button`: `cn` chỉ nối chuỗi, chồng `border-brand` lên `border-border` của
 * biến thể `neutral` thì bên nào thắng tuỳ thứ tự trong CSS build, không tuỳ thứ tự trong chuỗi.
 */
export function ToolbarButton({ icon, label, active = false, badge, className, type = "button", ...rest }: ToolbarButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        "touch-target relative inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-full border px-3 text-body font-medium",
        "max-xl:w-10 max-xl:px-0 disabled:opacity-55",
        FOCUS_BUTTON,
        active
          ? "border-brand bg-brand/12 text-brand-strong"
          : "border-border bg-surface-2 text-fg active:bg-surface",
        className,
      )}
      {...rest}
    >
      {icon}
      <span className="max-xl:hidden">{label}</span>
      {typeof badge === "number" && badge > 0 ? (
        <span data-toolbar-badge className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-brand text-[0.625rem] font-semibold tabular-nums text-white">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

// useClampToViewport

/** Khoảng chừa tối thiểu giữa tấm nổi và mép khung nhìn. */
const VIEWPORT_GUTTER = 16;

/**
 * Giữ tấm nổi trong khung nhìn: mép trái ≥ 16, mép phải ≤ bề rộng khung nhìn trừ 16. Đo
 * `getBoundingClientRect()` sau khi mở và mỗi lần `resize`, rồi dịch bằng `style.translate`; tấm rộng hơn khung
 * nhìn trừ 32 thì đặt `max-width` vừa khung. Dùng cho tấm thời gian,
 * `ToolbarPopover`, tấm Lọc.
 */
export function useClampToViewport(ref: RefObject<HTMLElement | null>, open: boolean) {
  useLayoutEffect(() => {
    if (!open) return;
    const node = ref.current;
    if (!node) return;
    const clamp = () => {
      node.style.translate = "";
      node.style.maxWidth = "";
      const viewportWidth = document.documentElement.clientWidth;
      const room = Math.max(viewportWidth - 2 * VIEWPORT_GUTTER, 0);
      let rect = node.getBoundingClientRect();
      if (rect.width > room) {
        node.style.maxWidth = `${room}px`;
        rect = node.getBoundingClientRect();
      }
      let shift = 0;
      if (rect.right > viewportWidth - VIEWPORT_GUTTER) shift = viewportWidth - VIEWPORT_GUTTER - rect.right;
      if (rect.left + shift < VIEWPORT_GUTTER) shift = VIEWPORT_GUTTER - rect.left;
      if (shift !== 0) node.style.translate = `${shift}px 0`;
    };
    clamp();
    window.addEventListener("resize", clamp);
    return () => {
      window.removeEventListener("resize", clamp);
      node.style.translate = "";
      node.style.maxWidth = "";
    };
  }, [ref, open]);
}

// ToolbarPopover

/**
 * Tấm nổi của thanh: đóng khi bấm ra ngoài hoặc Esc.
 * - `anchor`: nút mở tấm. Nhấn chuột trên nút không tính là bấm ra ngoài, không thì tấm đóng lúc nhấn rồi mở lại
 * lúc nhả.
 * - Định vị `absolute top-full` theo khối `relative` gần nhất (`ListToolbar` đặt khối ấy là cả thanh); `align`
 * chọn canh mép trái hay mép phải khối ấy. Nghe `mousedown`: `click` trên
 * `<option>` của `select` có đích nằm NGOÀI tấm. không `overflow-hidden`, `overflow-auto` ở khung tấm: lịch
 * bị xén. Ruột tự cuộn nếu cần.
 */
export function ToolbarPopover({
  open,
  onClose,
  anchor,
  label,
  align = "end",
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  /** Tên tấm cho trình đọc màn hình. */
  label: string;
  align?: "start" | "end";
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Giữ `onClose` mới nhất mà không gắn lại trình nghe mỗi lượt vẽ (chỗ gọi hay truyền hàm viết tại chỗ).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchor.current?.contains(target)) return;
      onCloseRef.current();
    };
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Esc: bỏ qua phím đang ghép chữ hoặc đã có chỗ xử lý; xử lý thì `preventDefault` để popup
    // bên ngoài bỏ qua, rồi trả focus về nút mở. Nghe ở pha CAPTURE: bộ nghe của popup gắn trên `document` từ trước,
    // nghe pha nổi thì nó chạy trước tấm.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
      e.preventDefault();
      onCloseRef.current();
      const node = anchor.current;
      const button = node instanceof HTMLButtonElement ? node : node?.querySelector<HTMLElement>("button");
      if (button && button.getClientRects().length > 0) button.focus();
      else if (opener?.isConnected && opener.getClientRects().length > 0) opener.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, anchor]);

  useClampToViewport(ref, open);

  if (!open) return null;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={cn(
        "absolute top-full z-30 mt-2 rounded-card border border-border bg-raised shadow-[var(--shadow-e2)]",
        align === "start" ? "left-0" : "right-0",
        className ?? "w-[min(92vw,40rem)]",
      )}
    >
      {children}
    </div>
  );
}

// ToolbarSearch

/**
 * Dưới 768: tối thiểu 120 để thanh còn một hàng; ô đang focus thì khối bọc thành lớp phủ theo gốc `relative` của
 * `ListToolbar` (rộng bằng thanh, cao 40, `z-20` trên các nút, dưới `z-30` của tấm nổi); mất focus hoặc bấm ✕
 * khi ô rỗng thì thu về (✕ lần 1 xoá chữ, lần 2 đóng). Chỉ đổi class của khối bọc, không thêm bớt cấp DOM theo
 * focus (React dựng lại ô: mất focus, mất chữ đang gõ). `size="lg"`: chữ ô 16 (`text-base`), ô vẫn cao 40.
 */
export function ToolbarSearch({
  value,
  onChange,
  placeholder,
  label,
  size = "md",
  plainSearch = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Tên ô cho trình đọc màn hình, ví dụ `"Tìm dự án"`. */
  label: string;
  size?: "md" | "lg";
  /**
   * Bật thì ô không có vành focus cam (chỉ viền xám đậm) và lớp phủ lúc bung bo tròn theo ô thay vì vuông. Huy
   * hiệu nút cạnh bên không còn được che: chỗ gọi tự ẩn `[data-toolbar-badge]` khi ô bung. Mặc định tắt.
   */
  plainSearch?: boolean;
}) {
  // `value` từ ngoài chỉ ghi vào ô khi ô không đang focus, hoặc khi chỗ gọi xoá về rỗng.
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const input = inputRef.current;
    if (!input || input.value === value) return;
    if (value === "" || document.activeElement !== input) input.value = value;
  }, [value]);

  return (
    <div
      data-plain-search={plainSearch ? "" : undefined}
      className={cn(
        "relative min-w-[120px] flex-1 md:min-w-[200px]",
        // Vành 4px màu thẻ (bóng, không đổi bố cục ô) che huy hiệu `-top-1 -right-1` của nút Lọc; góc vuông vì bo tròn để
        // lộ huy hiệu ở nút cuối hàng.
        focused &&
          "max-md:absolute max-md:inset-x-0 max-md:top-0 max-md:z-20 max-md:bg-card max-md:shadow-[0_0_0_4px_var(--card)]",
        // Vành chỉ là hình; `::before` trùm vành 4px để chạm sát mép rơi vào khối, không vào nút, huy hiệu bên dưới. `z`
        // âm trong ngữ cảnh xếp lớp `z-20` của khối: nằm dưới ô, ✕, không nuốt chạm của chúng.
        focused &&
          "max-md:before:absolute max-md:before:-inset-1 max-md:before:-z-10 max-md:before:content-['']",
        focused && plainSearch && "max-md:rounded-full max-md:before:rounded-full",
      )}
      // Chạm vành (đích là chính khối) giữ focus ở ô, như chạm trúng ô. Chỉ chặn khi đích là khối: chặn cả sự kiện nổi
      // lên từ ô thì chạm giữa ô không đặt được con trỏ.
      onMouseDown={(e) => {
        if (focused && e.target === e.currentTarget) e.preventDefault();
      }}
    >
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
      <input
        ref={inputRef}
        defaultValue={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        aria-label={label}
        // Cảm ứng: chữ dừng cách mép phải 44px, ra khỏi vùng chạm nới của ✕; chạm cuối chữ đặt con trỏ, không xoá chữ.
        className={cn(
          "h-10 w-full rounded-full border border-border bg-surface-2 pl-9 pr-9 text-fg placeholder:text-faint [@media(pointer:coarse)]:pr-11",
          size === "lg" ? "text-base" : "text-body",
          plainSearch ? "focus:border-faint focus:outline-none" : FOCUS_FIELD,
        )}
      />
      {/* ✕ hiện khi có chữ HOẶC ô đang focus: lần 1 xoá chữ, lần 2 (ô rỗng) đóng ô. */}
      {value || focused ? (
        <button
          type="button"
          // Giữ focus ở ô khi nhấn ✕: không thì ô mất focus trước `click`, khối thu về giữa chừng và cú bấm rơi sang nút bên
          // dưới (Safari không focus nút khi bấm). Có chữ: chỉ xoá, ô giữ focus, lớp phủ, ✕ đứng yên.
          onMouseDown={(e) => e.preventDefault()}
          // Rỗng: bỏ focus để ô đóng (dưới 768 lớp phủ thu về). Ô rỗng ✕ ra khỏi thứ tự Tab: Tab sang nó làm ô mất focus, ✕
          // tháo khỏi DOM, focus rơi về `BODY`; đóng bằng bàn phím là Tab ra ngoài.
          tabIndex={value ? undefined : -1}
          // Bàn phím (Enter, Space: `click` có `detail` 0) khi có chữ thì đưa focus về ô, vì ✕ ẩn khi rỗng mà ô không focus.
          // Chuột, chạm khi ô không focus (đã chạm ra ngoài, mở bằng `?q=`): chỉ xoá, ô vẫn đóng.
          onClick={(e) => {
            if (!value) {
              inputRef.current?.blur();
              return;
            }
            if (inputRef.current) inputRef.current.value = "";
            onChange("");
            if (e.detail === 0) inputRef.current?.focus();
          }}
          aria-label={value ? "Xoá từ khoá" : "Đóng tìm kiếm"}
          title={value ? "Xoá từ khoá" : "Đóng tìm kiếm"}
          // Cảm ứng: `::after` trong suốt 44x44 canh giữa nút, cùng cách tính `touch-target` (lớp đó đặt `relative`, phá nút
          // `absolute` nên không gắn được). Hình ✕ giữ 24x24; máy tính không đổi gì.
          className={cn(
            "absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-faint",
            "[@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:left-1/2 [@media(pointer:coarse)]:after:top-1/2 [@media(pointer:coarse)]:after:h-[max(100%,44px)] [@media(pointer:coarse)]:after:w-[max(100%,44px)] [@media(pointer:coarse)]:after:[transform:translate(-50%,-50%)] [@media(pointer:coarse)]:after:content-['']",
          )}
        >
          <X className="size-4" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

// ListToolbar

/**
 * Một mục của khe `tools` (Nhập, Xuất, Lịch): từ 1280 nút icon kèm chữ, 1024 tới 1280 nút chỉ icon (như Sắp
 * xếp), dưới 1024 thành mục menu ⋮.
 */
export type ToolbarItem = {
  key: string;
  icon: ReactNode;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
};

export type ListToolbarFilter = {
  /** Số điều kiện đã đủ. */
  activeCount: number;
  /** Công tắc ẩn mặc định đang bật: nút Lọc đếm thêm một và viền nhấn. */
  hideDefaultOn?: boolean;
  /**
   * Vẽ tấm Lọc với `open`, `onClose` thanh đưa xuống. Tấm tự định vị `absolute
   * right-0 top-full`, nên rơi vào gốc `relative` của thanh.
   */
  renderPanel: (state: { open: boolean; onClose: () => void }) => ReactNode;
};

export type ListToolbarSort = {
  /** Số tiêu chí đang áp: viền nhấn và số ở góc nút. */
  activeCount: number;
  /** Ruột tấm. */
  panel: ReactNode;
};

type OpenKey = "viewSettings" | "filter" | "sort" | "more";

/** Mục của menu ⋮. */
const MENU_ITEM =
  "flex h-10 w-full items-center gap-2 rounded-full px-3 text-body text-fg hover:bg-surface-2 active:bg-surface-2 disabled:opacity-55 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand";

function Separator({ className }: { className?: string }) {
  return <span aria-hidden className={cn("h-6 w-px shrink-0 bg-border", className)} />;
}

export function ListToolbar({
  view,
  viewSettings,
  search,
  filter,
  timeRange,
  sort,
  tools,
  rightPanelToggle,
  create,
  className,
}: {
  /** `ViewModeToggle modes={["list", "table"]}`. */
  view?: ReactNode;
  /** Nội dung cài đặt theo kiểu đang xem; thanh bọc thành nút "Cài đặt chế độ xem" mở tấm. */
  viewSettings?: { modeLabel: string; content: ReactNode } | null;
  /** `ToolbarSearch`. */
  search?: ReactNode;
  filter?: ListToolbarFilter | null;
  timeRange?: ReactNode;
  sort?: ListToolbarSort | null;
  /** Nhập, Xuất. */
  tools?: ToolbarItem[];
  /** Nút đóng mở cột phải; ẩn dưới 1024. */
  rightPanelToggle?: { open: boolean; onToggle: () => void } | null;
  /**
   * Nút Tạo: vẽ SAU `rightPanelToggle`, cuối thanh sát phải ở mọi bề ngang, không dồn vào ⋮. `label` vào
   * `aria-label`, `title`. Màn tự gác quyền: không có quyền tạo thì truyền `null`.
   */
  create?: { label: string; onClick: () => void } | null;
  className?: string;
}) {
  const [openKey, setOpenKey] = useState<OpenKey | null>(null);
  const viewSettingsRef = useRef<HTMLSpanElement>(null);
  const sortRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLSpanElement>(null);

  const toggle = (key: OpenKey) => setOpenKey((k) => (k === key ? null : key));
  // Chỉ đóng nếu tấm ấy còn đang mở: bấm sang nút khác thì `mousedown` đóng tấm cũ rồi `click` mở tấm mới.
  const closeIf = (key: OpenKey) => () => setOpenKey((k) => (k === key ? null : k));

  const filterCount = filter ? filter.activeCount + (filter.hideDefaultOn ? 1 : 0) : 0;
  const filterOpen = openKey === "filter";
  // Bấm lại nút Lọc: tấm Lọc bỏ qua `mousedown` trên nút mở, nên `toggle("filter")` ở `click` đóng
  // tấm.

  const toolItems = tools ?? [];
  const hasOverflow = Boolean(sort) || toolItems.length > 0;

  return (
    <div className={cn("relative flex min-w-0 flex-1 flex-wrap items-center gap-2", className)}>
      {view}

      {viewSettings ? (
        <>
          <span ref={viewSettingsRef} className="contents">
            <IconButton
              icon={<SlidersHorizontal className="size-4" aria-hidden />}
              label="Cài đặt chế độ xem"
              aria-haspopup="dialog"
              aria-expanded={openKey === "viewSettings"}
              onClick={() => toggle("viewSettings")}
            />
          </span>
          <ToolbarPopover
            open={openKey === "viewSettings"}
            onClose={closeIf("viewSettings")}
            anchor={viewSettingsRef}
            label="Cài đặt chế độ xem"
            align="start"
            className="w-[min(92vw,30rem)]"
          >
            <div className="border-b border-border px-3 py-3">
              <span className="text-title font-semibold text-fg">Cài đặt chế độ xem · {viewSettings.modeLabel}</span>
            </div>
            <div className="flex flex-col gap-2 px-3 py-3">{viewSettings.content}</div>
          </ToolbarPopover>
        </>
      ) : null}

      {search}

      {filter ? (
        <>
          <ToolbarButton
            icon={<ListFilter className="size-4" aria-hidden />}
            label="Lọc"
            active={filterCount > 0}
            badge={filterCount}
            aria-haspopup="dialog"
            aria-expanded={filterOpen}
            // Safari không focus nút khi bấm chuột: focus tay để tấm Lọc chụp đúng nút mở (bỏ qua nhấn lại, Esc trả
            // focus).
            onMouseDown={(e) => e.currentTarget.focus()}
            onClick={() => toggle("filter")}
          />
          {filter.renderPanel({ open: filterOpen, onClose: closeIf("filter") })}
        </>
      ) : null}

      {timeRange}

      {sort ? (
        <ToolbarButton
          ref={sortRef}
          icon={<ArrowUpDown className="size-4" aria-hidden />}
          label="Sắp xếp"
          active={sort.activeCount > 0}
          badge={sort.activeCount}
          aria-haspopup="dialog"
          aria-expanded={openKey === "sort"}
          onClick={() => toggle("sort")}
          className="max-lg:hidden"
        />
      ) : null}

      {toolItems.length > 0 ? (
        <>
          <Separator className="max-lg:hidden" />
          {toolItems.map((item) => (
            <ToolbarButton
              key={item.key}
              icon={item.icon}
              label={item.label}
              disabled={item.disabled}
              onClick={item.onSelect}
              className="max-lg:hidden"
            />
          ))}
        </>
      ) : null}

      {/* ⋮ dưới 1024: đứng đúng chỗ hai khe `sort`, `tools`, là nút sát phải vì `rightPanelToggle` đã ẩn. */}
      {hasOverflow ? (
        <span ref={moreRef} className="contents">
          <IconButton
            icon={<EllipsisVertical className="size-4" aria-hidden />}
            label="Thêm công cụ"
            aria-haspopup="dialog"
            aria-expanded={openKey === "more"}
            onClick={() => toggle("more")}
            className="ml-auto lg:hidden"
          />
        </span>
      ) : null}
      <ToolbarPopover
        open={openKey === "more"}
        onClose={closeIf("more")}
        anchor={moreRef}
        label="Thêm công cụ"
        className="w-56 p-2"
      >
        <div className="flex flex-col gap-1">
          {sort ? (
            <button type="button" className={MENU_ITEM} onClick={() => setOpenKey("sort")}>
              <ArrowUpDown className="size-4 shrink-0" aria-hidden />
              <span className="flex-1 text-left">Sắp xếp</span>
              {sort.activeCount > 0 ? <span className="text-label tabular-nums text-muted">{sort.activeCount}</span> : null}
            </button>
          ) : null}
          {toolItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className={MENU_ITEM}
              disabled={item.disabled}
              onClick={() => {
                setOpenKey(null);
                item.onSelect();
              }}
            >
              <span className="inline-flex shrink-0" aria-hidden>
                {item.icon}
              </span>
              <span className="flex-1 text-left">{item.label}</span>
            </button>
          ))}
        </div>
      </ToolbarPopover>

      {/* Tấm Sắp xếp: mở từ nút (từ 1024) hoặc từ mục ⋮ (dưới 1024). */}
      {sort ? (
        <ToolbarPopover open={openKey === "sort"} onClose={closeIf("sort")} anchor={sortRef} label="Sắp xếp">
          {sort.panel}
        </ToolbarPopover>
      ) : null}

      {rightPanelToggle ? (
        <>
          <Separator className="ml-auto max-lg:hidden" />
          <IconButton
            icon={<PanelRight className="size-4" aria-hidden />}
            label="Ẩn hiện cột phải"
            aria-pressed={rightPanelToggle.open}
            onClick={rightPanelToggle.onToggle}
            className="max-lg:hidden"
          />
        </>
      ) : null}

      {/* Nút Tạo: con cuối của thanh, sát phải. Trên một hàng chỉ MỘT phần tử mang `ml-auto` (hai cái thì chia đôi chỗ trống, ⋮ trôi giữa hàng): dưới 1024 có ⋮ thì ⋮ giữ `ml-auto`, nút Tạo đứng ngay sau (khe 8) nên cả hai cùng sát phải dù cùng hàng ô tìm hay rơi xuống hàng hai; dưới 1024 không có ⋮ thì nút Tạo tự `ml-auto`. Từ 1024 ⋮ ẩn: có `rightPanelToggle` thì Separator đã `ml-auto`, nút Tạo đứng sau nút cột phải; không có thì nút Tạo tự `ml-auto`. */}
      {create ? (
        <IconButton
          variant="primary"
          icon={<Plus className="size-5" aria-hidden />}
          label={create.label}
          onClick={create.onClick}
          className={cn(
            "hover:opacity-90 active:opacity-80",
            !hasOverflow && "max-lg:ml-auto",
            !rightPanelToggle && "lg:ml-auto",
          )}
        />
      ) : null}
    </div>
  );
}
