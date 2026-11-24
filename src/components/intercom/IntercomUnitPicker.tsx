"use client";

// Chọn mã tai theo bộ, dùng chung cho màn Giao và hộp Sửa lượt giao. Mỗi bộ một hàng tiêu đề (tên bộ, ghi chú tem,
// số mã còn trống, số đã chọn); bấm mới mở lưới mã cùng nút "Chọn cả bộ". Mã đang ở ngoài ẨN hẳn; bộ không còn mã
// trống thì ghi "đã giao hết".

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { IntercomUnit } from "@/lib/intercom/staffIntercom";
import type { IntercomUnitWithNote } from "@/lib/intercom/staffIntercomProject";
import { cn } from "@/lib/cn";
import { unitsByPrefix } from "./intercomView";

/** Ghi chú tem của bộ: `_intercom_board_json` trả `tag_note` trong mỗi mã. */
function tagNoteOf(units: readonly IntercomUnit[]): string | null {
  for (const unit of units as readonly Partial<IntercomUnitWithNote>[]) {
    if (typeof unit.tag_note === "string" && unit.tag_note.trim() !== "") return unit.tag_note;
  }
  return null;
}

export function IntercomUnitPicker({
  units,
  outUnits,
  selected,
  onChange,
}: {
  units: readonly IntercomUnit[];
  /** Mã đang ở ngoài (ẩn khỏi lưới). */
  outUnits: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  onChange: (update: (prev: Set<string>) => Set<string>) => void;
}) {
  const [openPrefixes, setOpenPrefixes] = useState<Set<string>>(new Set());

  const toggleUnit = (id: string) =>
    onChange((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-3">
      {unitsByPrefix(units).map((section) => {
        const free = section.units.filter((u) => !outUnits.has(u.id));
        const allOn = free.length > 0 && free.every((u) => selected.has(u.id));
        const hint = tagNoteOf(section.units);
        if (free.length === 0) {
          return (
            <p key={section.prefix} className="text-sm text-muted">
              Bộ {section.prefix}: đã giao hết
            </p>
          );
        }
        const pickedCount = free.filter((u) => selected.has(u.id)).length;
        const sectionOpen = openPrefixes.has(section.prefix);
        return (
          <section key={section.prefix} className="space-y-1.5">
            {/* Hàng tiêu đề bộ: bấm mới mở lưới mã của bộ. */}
            <button
              type="button"
              aria-expanded={sectionOpen}
              onClick={() =>
                setOpenPrefixes((prev) => {
                  const next = new Set(prev);
                  if (next.has(section.prefix)) next.delete(section.prefix);
                  else next.add(section.prefix);
                  return next;
                })
              }
              className="flex min-h-12 w-full items-center gap-2 rounded-control border border-border bg-surface-2 px-3 py-1.5 text-left active:bg-surface"
            >
              <span className="min-w-0 flex-1">
                <span className="text-block font-semibold text-fg">Bộ {section.prefix}</span>
                {hint ? <span className="ml-2 text-sm text-muted">{hint}</span> : null}
                <span className="block text-sm text-muted">
                  Còn {free.length} trống
                  {pickedCount > 0 ? <span className="font-semibold text-brand"> · đã chọn {pickedCount}</span> : null}
                </span>
              </span>
              <ChevronDown
                className={cn("size-5 shrink-0 text-muted transition-transform", sectionOpen && "rotate-180")}
                aria-hidden
              />
            </button>
            {sectionOpen ? (
              <>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() =>
                      onChange((prev) => {
                        const next = new Set(prev);
                        for (const u of free) {
                          if (allOn) next.delete(u.id);
                          else next.add(u.id);
                        }
                        return next;
                      })
                    }
                    className="h-11 shrink-0 rounded-control px-3 text-base text-brand active:bg-surface-2"
                  >
                    {allOn ? "Bỏ cả bộ" : "Chọn cả bộ"}
                  </button>
                </div>
                {/* Mã đang ở ngoài ẨN hẳn; thu về thì hiện lại sau lượt làm mới. */}
                <div className="grid grid-cols-6 gap-1.5">
                  {free.map((u) => {
                    const on = selected.has(u.id);
                    return (
                      <button
                        key={u.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleUnit(u.id)}
                        className={cn(
                          "h-11 rounded-control text-base font-semibold",
                          on ? "bg-brand-cta text-white" : "border border-border bg-surface text-fg active:bg-surface-2",
                        )}
                      >
                        {u.code}
                      </button>
                    );
                  })}
                </div>
              </>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
