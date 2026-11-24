"use client";

// Chế độ Danh sách của dashboard và trang khách: mỗi dòng một lượt giao, mới nhất lên đầu. Trái: ảnh giao nhỏ (bấm
// phóng to). Giữa đúng 3 dòng: tên (hoặc bộ phận, "Chưa rõ tên"), mã tai, giờ giao. Thu hết thì chữ "Đã thu", có
// tai lỗi thì chữ đỏ "Lỗi". Ảnh nhỏ vẫn phóng to. Trang khách không truyền `onCollectAgain`, `onAddUnits`,
// `onDelete`, `onDeletePerson` nên không có sheet thao tác. Có thao tác thì vẫn mở sheet thao tác như cũ. Dữ liệu
// chỉ từ `IntercomBoard` (`handovers`, `issues`, `people`), không gọi thêm gì.

import { useEffect, useMemo, useState } from "react";
import { Phone, X } from "lucide-react";
import type { IntercomBoard, IntercomIssue, IntercomPhotoSize } from "@/lib/intercom/staffIntercom";
import { labelOwnerKey, personOwnerKey, type IntercomOwnerKey } from "./IntercomPersonPhotosSheet";
import { ThumbImage } from "./IntercomThumbImage";
import {
  UNNAMED_DEPARTMENT,
  compactCodes,
  compareCodes,
  departmentLabel,
  matchesBoardSearch,
  vnClock,
} from "./intercomView";

/**
 * Dòng thay "Chưa có..." khi bỏ riêng công tắc "Chỉ thẻ còn tai ở ngoài" thì vẫn có dữ liệu khớp; Danh sách và
 * Bảng dùng chung.
 */
export const INTERCOM_ALL_COLLECTED_HINT =
  'Các tai khớp bộ lọc đã thu về hết. Bấm biểu tượng Lọc, tắt "Chỉ thẻ còn tai ở ngoài" để xem lại các lượt đã giao.';

export type IntercomListFilters = {
  /** Nhóm dạng chuỗi, hoặc `null` là mọi nhóm. */
  group: string | null;
  department: string | null;
  openOnly: boolean;
  /** Ngày `YYYY-MM-DD` (theo `work_date` của lượt giao), hoặc `null` là mọi ngày. */
  date: string | null;
  /** Chuỗi tìm đã qua `foldText` (tên, bộ phận chứa chuỗi; mã tai trùng chuỗi), rỗng là không lọc. */
  query: string;
};

type ListEntry = {
  id: string;
  personId: string | null;
  /** Số của người cầm (`people[].phone`, chỉ nhánh nhân viên); null là chưa có số hoặc lượt không gắn người. */
  phone: string | null;
  name: string;
  unnamed: boolean;
  department: string;
  group: number;
  takenAt: string;
  workDate: string;
  issues: IntercomIssue[];
  openCodes: string[];
  /** Các lượt thu tai của dòng này, cũ trước. */
  collects: { id: string; takenAt: string }[];
};

/** Mã in trên thẻ và đầu tấm thao tác: tai còn ngoài; thu hết thì mọi mã của lượt. */
function cardCodes(e: ListEntry): string {
  return compactCodes(e.openCodes.length > 0 ? e.openCodes : e.issues.map((i) => i.unit_code));
}

export function IntercomBoardList({
  board,
  photoUrl,
  filters,
  onOpenPhoto,
  onFillName,
  onDelete,
  onDeletePerson,
  onCollectAgain,
  onAddUnits,
  onOpenOwner,
  deleteBusy = false,
}: {
  board: IntercomBoard;
  photoUrl: (handoverId: string, size: IntercomPhotoSize) => string;
  filters: IntercomListFilters;
  onOpenPhoto: (handoverId: string) => void;
  onFillName?: (handoverId: string) => void;
  onDelete?: (handoverId: string) => void;
  onDeletePerson?: (personId: string) => void;
  onCollectAgain?: (deliverHandoverId: string) => void;
  onAddUnits?: (deliverHandoverId: string) => void;
  onOpenOwner?: (ownerKey: IntercomOwnerKey) => void;
  deleteBusy?: boolean;
}) {
  const [actionId, setActionId] = useState<string | null>(null);
  // Thẻ đang hiện bong bóng "Chưa có số điện thoại" (bấm nút gọi mờ); tự tắt sau 2,5 giây.
  const [noPhoneHintId, setNoPhoneHintId] = useState<string | null>(null);
  // Đếm lượt bấm: bấm lại cùng thẻ cũng đặt lại hẹn giờ, mỗi lần bấm đủ 2,5 giây.
  const [noPhoneHintTick, setNoPhoneHintTick] = useState(0);
  useEffect(() => {
    if (!noPhoneHintId) return;
    const timer = window.setTimeout(() => setNoPhoneHintId(null), 2500);
    return () => window.clearTimeout(timer);
  }, [noPhoneHintId, noPhoneHintTick]);
  const hasActions = Boolean(onCollectAgain || onAddUnits || onDelete || onDeletePerson);
  const openOwner = hasActions ? undefined : onOpenOwner;
  const clickable = hasActions || Boolean(openOwner);
  const openCard = (e: ListEntry) => {
    if (hasActions) setActionId(e.id);
    else openOwner?.(e.personId ? personOwnerKey(e.personId) : labelOwnerKey(e.name));
  };

  const entries = useMemo(() => {
    const peopleById = new Map(board.people.map((p) => [p.id, p]));
    const handoverById = new Map(board.handovers.map((h) => [h.id, h]));
    const issuesByHandover = new Map<string, IntercomIssue[]>();
    for (const issue of board.issues) {
      const list = issuesByHandover.get(issue.deliver_handover_id) ?? [];
      list.push(issue);
      issuesByHandover.set(issue.deliver_handover_id, list);
    }
    const out: ListEntry[] = [];
    for (const h of board.handovers) {
      if (h.kind !== "deliver") continue;
      const issues = (issuesByHandover.get(h.id) ?? []).sort((a, b) => compareCodes(a.unit_code, b.unit_code));
      const person = h.person_id ? peopleById.get(h.person_id) : null;
      const department = person?.department ?? h.department ?? issues[0]?.department ?? "";
      const group = person?.group_no ?? h.group_no ?? issues[0]?.group_no ?? 1;
      const openCodes = issues.filter((i) => !i.collect_handover_id).map((i) => i.unit_code);
      const collects = [...new Set(issues.map((i) => i.collect_handover_id).filter((id): id is string => Boolean(id)))]
        .map((id) => ({ id, takenAt: handoverById.get(id)?.taken_at ?? "" }))
        .filter((c) => c.takenAt)
        .sort((a, b) => (a.takenAt < b.takenAt ? -1 : a.takenAt > b.takenAt ? 1 : 0));
      out.push({
        id: h.id,
        personId: person ? person.id : null,
        phone: person?.phone ?? null,
        name: person
          ? person.full_name
          : department === UNNAMED_DEPARTMENT
            ? UNNAMED_DEPARTMENT
            : departmentLabel(department, group),
        unnamed: !person,
        department,
        group,
        takenAt: h.taken_at,
        workDate: h.work_date,
        issues,
        openCodes,
        collects,
      });
    }
    return out.sort((a, b) => (a.takenAt < b.takenAt ? 1 : a.takenAt > b.takenAt ? -1 : 0));
  }, [board]);

  const actionEntry = actionId ? (entries.find((e) => e.id === actionId) ?? null) : null;
  useEffect(() => {
    if (!actionEntry) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setActionId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actionEntry]);

  // Mọi điều kiện lọc trừ công tắc "Chỉ thẻ còn tai ở ngoài".
  const matching = entries.filter(
    (e) =>
      (filters.group === null || String(e.group) === filters.group) &&
      (filters.department === null || e.department === filters.department) &&
      (filters.date === null || e.workDate === filters.date) &&
      matchesBoardSearch(
        filters.query,
        [e.name, e.department],
        e.issues.map((i) => i.unit_code),
      ),
  );
  const visible = filters.openOnly ? matching.filter((e) => e.openCodes.length > 0) : matching;

  const runAction = (action: () => void) => {
    setActionId(null);
    action();
  };

  if (visible.length === 0) {
    return (
      <p className="rounded-card border border-border bg-surface px-3 py-6 text-base text-muted">
        {filters.openOnly && matching.length > 0 ? INTERCOM_ALL_COLLECTED_HINT : "Chưa có lượt giao nào khớp bộ lọc."}
      </p>
    );
  }

  return (
    <>
    <ul className="space-y-2">
      {visible.map((e) => {
        const hasFault = e.issues.some((i) => i.fault_reason);
        return (
          <li key={e.id} className="relative flex items-center gap-3 rounded-card border border-border bg-surface p-2">
            <button
              type="button"
              onClick={() => onOpenPhoto(e.id)}
              className="size-16 shrink-0 overflow-hidden rounded-control border border-border bg-surface-2 active:opacity-70"
              aria-label={`Ảnh giao lúc ${vnClock(e.takenAt)}`}
            >
              <ThumbImage src={photoUrl(e.id, "thumb")} />
            </button>
            <div
              className={clickable ? "min-w-0 flex-1 cursor-pointer rounded-control active:bg-surface-2" : "min-w-0 flex-1"}
              role={clickable ? "button" : undefined}
              tabIndex={clickable ? 0 : undefined}
              aria-label={
                hasActions ? `Thao tác lượt giao ${e.name}` : openOwner ? `Xem ảnh giao nhận của ${e.name}` : undefined
              }
              onClick={clickable ? () => openCard(e) : undefined}
              onKeyDown={
                clickable
                  ? (ev) => {
                      if (ev.target !== ev.currentTarget) return;
                      if (ev.key === "Enter" || ev.key === " ") {
                        ev.preventDefault();
                        openCard(e);
                      }
                    }
                  : undefined
              }
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 truncate text-base font-semibold text-fg">{e.name}</div>
              </div>
              <div className="truncate text-base text-fg">{cardCodes(e)}</div>
              <div className="text-sm text-muted">{vnClock(e.takenAt)}</div>
            </div>
            {e.openCodes.length > 0 ? (
              onCollectAgain ? (
                <div className="flex shrink-0 items-center gap-2">
                  {e.phone ? (
                    <a
                      href={`tel:${e.phone}`}
                      className="flex size-11 items-center justify-center rounded-control border border-success text-success active:bg-success/10"
                      aria-label={`Gọi ${e.name}`}
                    >
                      <Phone className="size-5" aria-hidden />
                    </a>
                  ) : (
                    <button
                      type="button"
                      aria-disabled="true"
                      onClick={() => {
                        setNoPhoneHintId(e.id);
                        setNoPhoneHintTick((t) => t + 1);
                      }}
                      className="flex size-11 items-center justify-center rounded-control border border-success text-success opacity-40 active:bg-success/10"
                      aria-label="Chưa có số điện thoại"
                    >
                      <Phone className="size-5" aria-hidden />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onCollectAgain(e.id)}
                    className="h-11 shrink-0 rounded-control bg-brand-cta px-4 text-base font-semibold text-white active:bg-brand-cta-hover"
                    aria-label={`Thu ${compactCodes(e.openCodes)} của ${e.name}`}
                  >
                    Thu
                  </button>
                </div>
              ) : (
                <span className="shrink-0 text-sm font-semibold text-warning">Đang giữ</span>
              )
            ) : hasFault ? (
              <span className="shrink-0 text-sm font-semibold text-danger">Lỗi</span>
            ) : (
              <span className="shrink-0 text-sm font-medium text-success">Đã thu</span>
            )}
            {noPhoneHintId === e.id ? (
              <div
                role="status"
                className="absolute right-2 bottom-full z-10 mb-1 whitespace-nowrap rounded-control border border-border bg-surface-2 px-2 py-1 text-sm text-fg shadow-sm"
              >
                Chưa có số điện thoại
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
    {actionEntry ? (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        role="dialog"
        aria-modal="true"
        aria-label={`Thao tác lượt giao ${actionEntry.name}`}
        onClick={(ev) => {
          if (ev.target === ev.currentTarget) setActionId(null);
        }}
      >
        <div className="max-h-full w-full max-w-md space-y-3 overflow-y-auto rounded-card bg-surface p-4">
          <button
            type="button"
            onClick={() => onOpenPhoto(actionEntry.id)}
            className="block w-full overflow-hidden rounded-control border border-border bg-surface-2 active:opacity-70"
            aria-label={`Phóng to ảnh giao lúc ${vnClock(actionEntry.takenAt)}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- ảnh qua route R2 có quyền, không qua bộ tối ưu ảnh */}
            <img src={photoUrl(actionEntry.id, "full")} alt="" className="h-auto w-full" />
          </button>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="break-words text-block font-semibold text-fg">{actionEntry.name}</h2>
              <p className="break-words text-base text-muted">
                {cardCodes(actionEntry)} · Giao {vnClock(actionEntry.takenAt)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setActionId(null)}
              className="flex size-11 shrink-0 items-center justify-center rounded-control border border-border text-fg active:bg-surface-2"
              aria-label="Đóng"
            >
              <X className="size-5" aria-hidden />
            </button>
          </div>
          <div className="flex flex-col gap-2">
            {onCollectAgain && actionEntry.openCodes.length > 0 ? (
              <button
                type="button"
                onClick={() => runAction(() => onCollectAgain(actionEntry.id))}
                className="h-12 w-full rounded-control bg-brand-cta px-3 text-base font-semibold text-white active:bg-brand-cta-hover"
                aria-label={`Thu về ${compactCodes(actionEntry.openCodes)} của ${actionEntry.name}`}
              >
                Thu về
              </button>
            ) : null}
            {onFillName && actionEntry.unnamed ? (
              <button
                type="button"
                onClick={() => runAction(() => onFillName(actionEntry.id))}
                className="h-12 w-full rounded-control border border-brand px-3 text-base font-semibold text-brand active:bg-surface-2"
                aria-label={`Điền tên cho lượt giao ${actionEntry.name}`}
              >
                Điền tên
              </button>
            ) : null}
            {onAddUnits ? (
              <button
                type="button"
                onClick={() => runAction(() => onAddUnits(actionEntry.id))}
                className="h-12 w-full rounded-control border border-brand px-3 text-base font-semibold text-brand active:bg-surface-2"
                aria-label={`Sửa, thêm tai cho ${actionEntry.name}`}
              >
                Sửa
              </button>
            ) : null}
            {onDelete
              ? actionEntry.collects.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    disabled={deleteBusy}
                    onClick={() => runAction(() => onDelete(c.id))}
                    className="h-12 w-full rounded-control border border-danger px-3 text-base font-medium text-danger active:bg-danger/10 disabled:opacity-50"
                  >
                    Xoá ảnh thu {vnClock(c.takenAt)}
                  </button>
                ))
              : null}
            {onDelete ? (
              <button
                type="button"
                disabled={deleteBusy}
                onClick={() => runAction(() => onDelete(actionEntry.id))}
                className="h-12 w-full rounded-control border border-danger px-3 text-base font-medium text-danger active:bg-danger/10 disabled:opacity-50"
              >
                Xoá ảnh giao
              </button>
            ) : null}
            {onDeletePerson && actionEntry.personId ? (
              <button
                type="button"
                disabled={deleteBusy}
                onClick={() => {
                  const personId = actionEntry.personId;
                  if (personId) runAction(() => onDeletePerson(personId));
                }}
                className="h-12 w-full rounded-control border border-danger px-3 text-base font-medium text-danger active:bg-danger/10 disabled:opacity-50"
              >
                Xoá người và ảnh
              </button>
            ) : null}
            {!(onCollectAgain && actionEntry.openCodes.length > 0) &&
            !(onFillName && actionEntry.unnamed) &&
            !onAddUnits &&
            !onDelete &&
            !(onDeletePerson && actionEntry.personId) ? (
              <p className="text-base text-muted">Lượt này đã thu hết, không còn thao tác nào.</p>
            ) : null}
          </div>
        </div>
      </div>
    ) : null}
    </>
  );
}
