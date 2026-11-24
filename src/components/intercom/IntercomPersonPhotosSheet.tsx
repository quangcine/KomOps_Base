"use client";

// Gom MỌI lượt giao của một người (mọi ngày, theo `person_id`); lượt giao bộ phận, "Chưa rõ tên" gom theo đúng
// nhãn của thẻ Danh sách. Kèm mọi lượt thu của các tai trong các lượt giao ấy, giờ cũ tới mới. Chỉ dữ liệu
// `IntercomBoard` sẵn có; ảnh qua `photoUrl` (route khách), bấm ảnh phóng to qua `onOpenPhoto`. Không nút thao
// tác.

import { useEffect, useMemo } from "react";
import { X } from "lucide-react";
import type { IntercomBoard, IntercomIssue, IntercomPhotoSize } from "@/lib/intercom/staffIntercom";
import { CollapsibleBlock } from "@/components/ui/CollapsibleBlock";
import {
  UNNAMED_DEPARTMENT,
  compactCodes,
  compareCodes,
  dayLabel,
  departmentLabel,
  shortDate,
  vnClock,
  vnWorkday,
} from "./intercomView";

/** Khoá chủ thẻ: `p:<person_id>` hoặc `l:<nhãn thẻ>` (nhãn bộ phận cộng nhóm, hoặc "Chưa rõ tên"). */
export type IntercomOwnerKey = string;

/** Nhãn thẻ của lượt giao không có người, cùng cách tính tên thẻ ở `IntercomBoardList`. */
export function unnamedOwnerLabel(department: string, group: number): string {
  return department === UNNAMED_DEPARTMENT ? UNNAMED_DEPARTMENT : departmentLabel(department, group);
}

export function personOwnerKey(personId: string): IntercomOwnerKey {
  return `p:${personId}`;
}

export function labelOwnerKey(label: string): IntercomOwnerKey {
  return `l:${label}`;
}

type PhotoRow = {
  handoverId: string;
  kind: "deliver" | "collect";
  takenAt: string;
  codes: string[];
  faults: { code: string; reason: string }[];
};

type PhotoDay = { day: string; rows: PhotoRow[] };

type OwnerPhotos = {
  title: string;
  department: string | null;
  holdingCount: number;
  days: PhotoDay[];
};

/** Gom các lượt đã sắp giờ cũ tới mới theo ngày làm việc, ngày cũ trước; thứ tự trong ngày giữ nguyên. */
function groupRowsByWorkday(rows: readonly PhotoRow[]): PhotoDay[] {
  const rowsByDay = new Map<string, PhotoRow[]>();
  for (const row of rows) {
    const day = vnWorkday(row.takenAt);
    const list = rowsByDay.get(day) ?? [];
    list.push(row);
    rowsByDay.set(day, list);
  }
  return [...rowsByDay.keys()].sort().map((day) => ({ day, rows: rowsByDay.get(day) ?? [] }));
}

/** Tiêu đề khối ngày: trong khoảng ngày của dự án thì `Ngày N (dd/mm)`, ngoài khoảng thì chỉ `dd/mm`. */
function workdayHeading(project: IntercomBoard["project"], day: string): string {
  return day >= project.start_date && day <= project.end_date ? dayLabel(project.start_date, day) : shortDate(day);
}

function buildOwnerPhotos(board: IntercomBoard, ownerKey: IntercomOwnerKey): OwnerPhotos | null {
  const peopleById = new Map(board.people.map((p) => [p.id, p]));
  const handoverById = new Map(board.handovers.map((h) => [h.id, h]));
  const issuesByDeliver = new Map<string, IntercomIssue[]>();
  for (const issue of board.issues) {
    const list = issuesByDeliver.get(issue.deliver_handover_id) ?? [];
    list.push(issue);
    issuesByDeliver.set(issue.deliver_handover_id, list);
  }

  const deliverRows: PhotoRow[] = [];
  const matchedIssues: IntercomIssue[] = [];
  for (const h of board.handovers) {
    if (h.kind !== "deliver") continue;
    const issues = issuesByDeliver.get(h.id) ?? [];
    const person = h.person_id ? peopleById.get(h.person_id) : null;
    let key: IntercomOwnerKey;
    if (person) {
      key = personOwnerKey(person.id);
    } else {
      const department = h.department ?? issues[0]?.department ?? "";
      const group = h.group_no ?? issues[0]?.group_no ?? 1;
      key = labelOwnerKey(unnamedOwnerLabel(department, group));
    }
    if (key !== ownerKey) continue;
    matchedIssues.push(...issues);
    deliverRows.push({
      handoverId: h.id,
      kind: "deliver",
      takenAt: h.taken_at,
      codes: issues.map((i) => i.unit_code),
      faults: [],
    });
  }

  const collectIssues = new Map<string, IntercomIssue[]>();
  for (const issue of matchedIssues) {
    if (!issue.collect_handover_id) continue;
    const list = collectIssues.get(issue.collect_handover_id) ?? [];
    list.push(issue);
    collectIssues.set(issue.collect_handover_id, list);
  }
  const collectRows: PhotoRow[] = [];
  for (const [collectId, issues] of collectIssues) {
    const h = handoverById.get(collectId);
    if (!h) continue;
    collectRows.push({
      handoverId: collectId,
      kind: "collect",
      takenAt: h.taken_at,
      codes: issues.map((i) => i.unit_code),
      faults: issues
        .filter((i) => i.fault_reason)
        .sort((a, b) => compareCodes(a.unit_code, b.unit_code))
        .map((i) => ({ code: i.unit_code, reason: i.fault_reason ?? "" })),
    });
  }

  if (deliverRows.length === 0) return null;
  const rows = [...deliverRows, ...collectRows].sort((a, b) =>
    a.takenAt < b.takenAt ? -1 : a.takenAt > b.takenAt ? 1 : 0,
  );
  const holdingCount = new Set(matchedIssues.filter((i) => !i.collect_handover_id).map((i) => i.unit_id)).size;
  const personId = ownerKey.startsWith("p:") ? ownerKey.slice(2) : null;
  const person = personId ? peopleById.get(personId) : null;
  return {
    title: person ? person.full_name : ownerKey.slice(2),
    department: person ? person.department : null,
    holdingCount,
    days: groupRowsByWorkday(rows),
  };
}

export function IntercomPersonPhotosSheet({
  board,
  ownerKey,
  photoUrl,
  onOpenPhoto,
  onClose,
  viewerOpen,
}: {
  board: IntercomBoard;
  ownerKey: IntercomOwnerKey;
  photoUrl: (handoverId: string, size: IntercomPhotoSize) => string;
  onOpenPhoto: (handoverId: string) => void;
  onClose: () => void;
  /** Ảnh phóng to đang mở: phím Esc để cho trình xem ảnh đóng trước, sheet giữ nguyên. */
  viewerOpen: boolean;
}) {
  const data = useMemo(() => buildOwnerPhotos(board, ownerKey), [board, ownerKey]);

  useEffect(() => {
    if (viewerOpen) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewerOpen, onClose]);

  if (!data) return null;
  const sheetTitle = `Ảnh giao nhận của ${data.title}`;
  const currentWorkday = vnWorkday(new Date());

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      role="dialog"
      aria-modal="true"
      aria-label={sheetTitle}
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-full w-full max-w-md flex-col rounded-card bg-surface">
        <div className="flex items-start justify-between gap-2 border-b border-border p-4">
          <div className="min-w-0">
            <h2 className="break-words text-block font-semibold text-fg">{sheetTitle}</h2>
            {data.department ? <p className="break-words text-base text-muted">{data.department}</p> : null}
            <p className="text-base text-muted">
              {data.holdingCount > 0 ? `Đang giữ ${data.holdingCount} tai` : "Không giữ tai nào"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-11 shrink-0 items-center justify-center rounded-control border border-border text-fg active:bg-surface-2"
            aria-label="Đóng"
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>
        <div className="overflow-y-auto p-4">
          {data.days.map(({ day, rows }) => (
            <CollapsibleBlock
              key={day}
              title={workdayHeading(board.project, day)}
              defaultCollapsed={day !== currentWorkday}
            >
              <ul className="space-y-2">
                {rows.map((row) => {
                  const kindLabel = row.kind === "deliver" ? "Giao" : "Thu";
                  return (
                    <li key={row.handoverId} className="flex items-start gap-3 rounded-card border border-border p-2">
                      <button
                        type="button"
                        onClick={() => onOpenPhoto(row.handoverId)}
                        className="size-16 shrink-0 overflow-hidden rounded-control border border-border bg-surface-2 active:opacity-70"
                        aria-label={`Phóng to ảnh ${kindLabel.toLowerCase()} lúc ${vnClock(row.takenAt)}`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element -- ảnh qua route R2 có quyền, không qua bộ tối ưu ảnh */}
                        <img
                          src={photoUrl(row.handoverId, "thumb")}
                          alt=""
                          loading="lazy"
                          className="size-full object-cover"
                        />
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={
                              row.kind === "deliver"
                                ? "shrink-0 rounded-control bg-warning/15 px-2 text-sm font-semibold text-warning"
                                : "shrink-0 rounded-control bg-success/15 px-2 text-sm font-semibold text-success"
                            }
                          >
                            {kindLabel}
                          </span>
                          <span className="min-w-0 break-words text-base text-fg">{compactCodes(row.codes)}</span>
                        </div>
                        <div className="text-sm text-muted">{vnClock(row.takenAt)}</div>
                        {row.faults.map((f) => (
                          <div key={f.code} className="break-words text-sm font-medium text-danger">
                            {row.faults.length > 1 || row.codes.length > 1 ? `${f.code} · ` : ""}Lỗi: {f.reason}
                          </div>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </CollapsibleBlock>
          ))}
        </div>
      </div>
    </div>
  );
}
