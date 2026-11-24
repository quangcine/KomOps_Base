"use client";

// Thanh ngang "đã giao theo bộ phận" dưới hàng công cụ, dùng chung cho dashboard nhân viên và trang khách. Mỗi
// đoạn là số tai Ở NGOÀI của một bộ phận (bộ phận ghi trên tai), tự tách theo mọi bộ phận có trong dữ liệu, sắp
// giảm dần; đoạn cuối "Còn" là tai trong kho. Độ rộng theo tỉ lệ trên Tổng số. Các bộ lọc Nhóm, Bộ phận, ô tìm
// không áp vào thanh này.

import { useMemo } from "react";
import type { IntercomBoard } from "@/lib/intercom/staffIntercom";
import { dayLabel, normalizedDepartment, peakUnitsByDepartment, vnHourMinute } from "./intercomView";

/** Bảng màu phân loại cho bộ phận (kho chưa có token màu biểu đồ). Không có đỏ (đỏ là Lỗi). */
const DEPARTMENT_COLORS = [
  "#2563eb", // xanh dương
  "#0f766e", // xanh ngọc
  "#7c3aed",
  "#b45309", // hổ phách
  "#0369a1", // xanh trời
  "#4d7c0f", // xanh lá mạ
  "#a21caf", // tím hồng
  "#4338ca", // chàm
  "#15803d", // xanh lá
  "#9a3412", // nâu cam
] as const;

/** Đoạn hẹp hơn mức này (phần trăm Tổng số) thì ẩn số trong thanh. */
const MIN_LABEL_PERCENT = 5;

type Segment = { key: string; label: string; count: number; color: string | null };

function hashName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return hash;
}

/**
 * Màu ổn định theo tên: băm tên ra ô màu; trùng ô thì dò ô kế tiếp (xét tên theo thứ tự chữ để kết quả không đổi
 * theo số đếm).
 */
function assignColors(names: readonly string[]): Map<string, string> {
  const colors = new Map<string, string>();
  const used = new Set<number>();
  for (const name of [...names].sort((a, b) => a.localeCompare(b, "vi"))) {
    let slot = hashName(name) % DEPARTMENT_COLORS.length;
    for (let tries = 0; tries < DEPARTMENT_COLORS.length && used.has(slot); tries += 1) {
      slot = (slot + 1) % DEPARTMENT_COLORS.length;
    }
    used.add(slot);
    colors.set(name, DEPARTMENT_COLORS[slot] ?? DEPARTMENT_COLORS[0]);
  }
  return colors;
}

type BarSummary = { counts: Map<string, number>; label: string; description: string };

function barSummaryFor(board: IntercomBoard, dateFilter: string | null): BarSummary {
  if (dateFilter === null || dateFilter === board.today) {
    const counts = new Map<string, number>();
    // Tai đang ở ngoài lúc này (chưa thu).
    for (const issue of board.issues) {
      if (issue.collect_handover_id) continue;
      const name = normalizedDepartment(issue.department);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return { counts, label: "Hôm nay", description: "Đang giao lúc này" };
  }
  const label = dayLabel(board.project.start_date, dateFilter);
  if (dateFilter > board.today) return { counts: new Map(), label, description: "Chưa giao" };
  const peak = peakUnitsByDepartment(board, dateFilter);
  // Không có tai thì `atDayStart` cũng đúng, nên xét nhánh rỗng trước.
  if (peak.counts.size === 0) return { counts: peak.counts, label, description: "Không giao tai nào" };
  if (peak.atDayStart) return { counts: peak.counts, label, description: "Giao nhiều nhất từ đầu ngày" };
  return { counts: peak.counts, label, description: `Giao nhiều nhất lúc ${vnHourMinute(peak.at)}` };
}

export function IntercomDeptBar({ board, dateFilter = null }: { board: IntercomBoard; dateFilter?: string | null }) {
  const { total, segments, label, description } = useMemo(() => {
    const day = barSummaryFor(board, dateFilter);
    // Gán màu trên mọi bộ phận của dự án, không chỉ bộ phận đang có số: đổi ngày thì một bộ phận giữ nguyên màu.
    const colors = assignColors([...new Set(board.issues.map((i) => normalizedDepartment(i.department)))]);
    const departments: Segment[] = [...day.counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "vi"))
      .map(([name, count]) => ({ key: `d:${name}`, label: name, count, color: colors.get(name) ?? null }));
    const out = departments.reduce((sum, s) => sum + s.count, 0);
    const units = board.units.length;
    return {
      total: units,
      segments: [...departments, { key: "remaining", label: "Còn", count: Math.max(0, units - out), color: null }],
      label: day.label,
      description: day.description,
    };
  }, [board, dateFilter]);

  if (total === 0) return null;
  // Tổng số là mẫu số; dữ liệu lệch (đang ngoài nhiều hơn Tổng số) thì lấy tổng các đoạn để thanh không tràn.
  const base = Math.max(total, segments.reduce((sum, s) => sum + s.count, 0));
  const visible = segments.filter((s) => s.count > 0);

  return (
    <div className="space-y-2 rounded-card border border-border bg-surface p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-fg">{label}</p>
        <p className="text-sm text-muted">{description}</p>
      </div>
      <div
        className="flex h-8 w-full overflow-hidden rounded-full bg-surface-2"
        role="img"
        aria-label={`Đã giao theo bộ phận: ${segments.map((s) => `${s.label} ${s.count}`).join(", ")}`}
      >
        {visible.map((s) => {
          const percent = (s.count / base) * 100;
          return (
            <div
              key={s.key}
              className={`flex min-w-0 items-center justify-center text-sm font-semibold ${
                s.color ? "text-white" : "bg-border-strong text-fg"
              }`}
              style={{ width: `${percent}%`, ...(s.color ? { backgroundColor: s.color } : null) }}
            >
              {percent >= MIN_LABEL_PERCENT ? <span className="whitespace-nowrap">{s.count}</span> : null}
            </div>
          );
        })}
      </div>
      {/* Không có chữ "Tổng": người xem cộng từ số trên thanh. */}
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-fg">
        {segments.map((s) => (
          <li key={s.key} className="flex min-w-0 items-center gap-1.5">
            <span
              className={`size-3 shrink-0 rounded-full ${s.color ? "" : "bg-border-strong"}`}
              style={s.color ? { backgroundColor: s.color } : undefined}
              aria-hidden
            />
            <span className="min-w-0 break-words">{s.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
