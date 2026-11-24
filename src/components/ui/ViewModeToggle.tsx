"use client";

// Nút đổi giữa DẠNG BẢNG và DẠNG THẺ, dùng chung cho mọi trang danh sách. Đổi Bảng và Thẻ chỉ có nghĩa từ `768px`: dưới mức đó
// luôn là Thẻ nên chỗ gọi tự giấu cụm nút.

import type { LucideIcon } from "lucide-react";
import { LayoutGrid, Rows3, Table2 } from "lucide-react";
import { SegmentedGroup } from "./SegmentedGroup";
import type { SegmentedItemProps, SegmentedOption } from "./SegmentedGroup";

export type ViewMode = "cards" | "table" | "list";

const MODE_LABEL: Record<ViewMode, string> = { list: "Danh sách", table: "Bảng", cards: "Thẻ" };
const MODE_ICON: Record<ViewMode, LucideIcon> = { list: Rows3, table: Table2, cards: LayoutGrid };

function ModeButton({
  mode,
  current,
  onPick,
  Icon,
  label,
}: {
  mode: ViewMode;
  current: ViewMode;
  onPick: (v: ViewMode) => void;
  Icon: LucideIcon;
  label: string;
}) {
  const active = mode === current;
  return (
    <button
      type="button"
      onClick={() => onPick(mode)}
      aria-label={label}
      aria-pressed={active}
      className={
        active
          ? "flex size-10 items-center justify-center rounded-full border border-brand bg-brand/12 text-brand-strong"
          : "flex size-10 items-center justify-center rounded-full border border-border bg-surface-2 text-muted"
      }
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}

type ViewItemProps = SegmentedItemProps & { title: string };

/**
 * Cặp nút Thẻ và Bảng (không `modes`, chỗ gọi lo phần giấu ở màn hẹp), hoặc nhóm viên theo `modes` (ví dụ
 * `["list", "table"]`).
 */
export function ViewModeToggle({
  value,
  onChange,
  modes,
}: {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
  modes?: ViewMode[];
}) {
  if (modes) {
    const options: SegmentedOption<ViewMode>[] = modes.map((m) => {
      const Icon = MODE_ICON[m];
      return { value: m, label: MODE_LABEL[m], icon: <Icon className="size-4" aria-hidden /> };
    });
    return (
      <>
        <SegmentedGroup
          options={options}
          value={value}
          onChange={onChange}
          ariaLabel="Chế độ xem"
          className="max-xl:hidden"
          itemProps={(v): ViewItemProps => ({ title: MODE_LABEL[v] })}
        />
        <SegmentedGroup
          options={options}
          value={value}
          onChange={onChange}
          ariaLabel="Chế độ xem"
          labelHidden
          className="xl:hidden"
        />
      </>
    );
  }
  return (
    <div className="hidden items-center gap-1 md:flex">
      <ModeButton mode="cards" current={value} onPick={onChange} Icon={LayoutGrid} label="Xem dạng thẻ" />
      <ModeButton mode="table" current={value} onPick={onChange} Icon={Table2} label="Xem dạng bảng" />
    </div>
  );
}
