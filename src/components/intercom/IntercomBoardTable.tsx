"use client";

// Bảng giao nhận intercom dùng chung cho dashboard nhân viên `/intercom/board` và trang khách `/ic/<mã>`. Dòng là
// người nhận và dòng bộ phận (lượt giao chưa gắn người, Tên trống). Dashboard nhân viên: một dòng mỗi lượt giao
// chưa gắn người, nút "Điền tên" ở ô Tên; trang khách giữ một dòng mỗi cặp Bộ phận, Nhóm. Cột ngày theo
// `day_count` của dự án: Mã tai, Ảnh giao, Ảnh nhận. Ảnh nhận đi theo ngày giao của tai.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Share2, Trash2, X } from "lucide-react";
import { MediaViewer, type MediaViewerItem } from "@/components/ui/MediaViewer";
import {
  deleteIntercomHandover,
  deleteIntercomPerson,
  type IntercomBoard,
  type IntercomHandover,
  type IntercomIssue,
  type IntercomPhotoSize,
} from "@/lib/intercom/staffIntercom";
import { cn } from "@/lib/cn";
import { getIntercomDriveTrashNote } from "@/lib/intercom/staffIntercomDrive";
import { useConfirm } from "@/components/ui/useConfirm";
import { ListToolbar, ToolbarButton, ToolbarPopover, ToolbarSearch } from "@/components/ui/ListToolbar";
import { ViewModeToggle } from "@/components/ui/ViewModeToggle";
import {
  addDays,
  compactCodes,
  compareCodes,
  departmentLabel,
  foldText,
  issueRowKey,
  matchesBoardSearch,
  readStoredView,
  shortDate,
  storeView,
  vnClock,
  vnTime,
  type IntercomBoardView,
} from "./intercomView";
import { INTERCOM_ALL_COLLECTED_HINT, IntercomBoardList } from "./IntercomBoardList";
import { IntercomAddUnitsDialog } from "./IntercomAddUnitsDialog";
import { ThumbImage } from "./IntercomThumbImage";
import { IntercomFillNameDialog } from "./IntercomFillNameDialog";
import { IntercomDeletePersonDialog } from "./IntercomDeletePersonDialog";
import { IntercomDeptBar } from "./IntercomDeptBar";
import {
  IntercomPersonPhotosSheet,
  labelOwnerKey,
  unnamedOwnerLabel,
  type IntercomOwnerKey,
} from "./IntercomPersonPhotosSheet";

type BoardRow = {
  key: string;
  name: string;
  department: string;
  group: number;
  /** Theo ngày thứ mấy (1 trở đi). */
  days: Map<number, IntercomIssue[]>;
  hasOpen: boolean;
  /** Dòng tách theo lượt giao chưa gắn người: id lượt giao; dòng người, dòng gom theo bộ phận: null. */
  deliverHandoverId: string | null;
  /** Giờ giao của lượt (dòng tách); dòng khác: "". */
  takenAt: string;
};

const ALL = "all";

// Khoá dòng riêng cho Bảng nhân viên: tai chưa gắn người tách theo lượt giao (`h:<id lượt giao>`), không gom theo
// bộ phận.
function boardRowKey(issue: IntercomIssue): string {
  return issue.person_id ? issueRowKey(issue) : `h:${issue.deliver_handover_id}`;
}

function buildRows(board: IntercomBoard, splitUnnamed: boolean): BoardRow[] {
  const rows = new Map<string, BoardRow>();
  const takenAtById = new Map(board.handovers.map((h) => [h.id, h.taken_at]));
  for (const person of board.people) {
    rows.set(`p:${person.id}`, {
      key: `p:${person.id}`,
      name: person.full_name,
      department: person.department,
      group: person.group_no,
      days: new Map(),
      hasOpen: false,
      deliverHandoverId: null,
      takenAt: "",
    });
  }
  for (const issue of board.issues) {
    const key = splitUnnamed ? boardRowKey(issue) : issueRowKey(issue);
    let row = rows.get(key);
    if (!row) {
      const split = key.startsWith("h:");
      row = {
        key,
        name: "",
        department: issue.department,
        group: issue.group_no,
        days: new Map(),
        hasOpen: false,
        deliverHandoverId: split ? issue.deliver_handover_id : null,
        takenAt: split ? (takenAtById.get(issue.deliver_handover_id) ?? "") : "",
      };
      rows.set(key, row);
    }
    const list = row.days.get(issue.day_number) ?? [];
    list.push(issue);
    row.days.set(issue.day_number, list);
    if (!issue.collect_handover_id) row.hasOpen = true;
  }
  return [...rows.values()].sort(
    (a, b) =>
      a.group - b.group ||
      a.department.localeCompare(b.department, "vi") ||
      // Dòng bộ phận (Tên trống) đứng cuối bộ phận đó.
      (a.name ? 0 : 1) - (b.name ? 0 : 1) ||
      a.name.localeCompare(b.name, "vi") ||
      // Dòng tách theo lượt giao: lượt cũ trước.
      a.takenAt.localeCompare(b.takenAt),
  );
}

function uniqueIds(ids: (string | null)[]): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

/** Tên lấy theo người hoặc bộ phận của các tai trong lượt. */
function handoverSummary(board: IntercomBoard, h: IntercomHandover): { codes: string; names: string; at: string } {
  const issues = board.issues.filter((i) =>
    h.kind === "deliver" ? i.deliver_handover_id === h.id : i.collect_handover_id === h.id,
  );
  const peopleById = new Map(board.people.map((p) => [p.id, p.full_name]));
  const names = [
    ...new Set(
      issues.map((i) => (i.person_id ? peopleById.get(i.person_id) : null) ?? departmentLabel(i.department, i.group_no)),
    ),
  ];
  if (names.length === 0 && h.department) names.push(departmentLabel(h.department, h.group_no ?? 1));
  return {
    codes: compactCodes(issues.map((i) => i.unit_code)) || "không còn mã nào",
    names: names.join(", ") || "chưa rõ tên",
    at: vnClock(h.taken_at),
  };
}

export function IntercomBoardTable({
  board,
  photoUrl,
  onPersonFilled,
  onUnitsAdded,
  onHandoverDeleted,
  onCollectAgain,
  dateFilter = null,
  openOnlyByDefault = false,
  fallbackView,
  sharePanel,
  ownerPhotos = false,
}: {
  board: IntercomBoard;
  /**
   * Ngày `YYYY-MM-DD` đang chọn ở ô ngày trên cùng, `null` là mọi ngày. Danh sách: lọc lượt giao theo ngày; Bảng:
   * chỉ hiện cột của ngày đó.
   */
  dateFilter?: string | null;
  photoUrl: (handoverId: string, size: IntercomPhotoSize) => string;
  /**
   * Chỉ dashboard nhân viên truyền: có thì hiện nút "Điền tên" ở lượt giao chưa gắn người, điền xong gọi để làm
   * mới.
   */
  onPersonFilled?: () => void | Promise<void>;
  onUnitsAdded?: () => void | Promise<void>;
  onHandoverDeleted?: () => void | Promise<void>;
  onCollectAgain?: (deliverHandoverId: string) => void;
  openOnlyByDefault?: boolean;
  /** Dạng xem khi chưa nhớ lựa chọn nào; không truyền thì theo khổ màn như cũ. */
  fallbackView?: IntercomBoardView;
  /** Ruột sheet Link khách (chỉ dashboard nhân viên truyền): có thì hàng công cụ có nút Share mở sheet này. */
  sharePanel?: ReactNode;
  /**
   * Bấm phần chữ thẻ Danh sách hoặc tên ở Bảng mở sheet chỉ xem "Ảnh giao nhận của <tên>" (mọi lượt giao của người
   * đó ở mọi ngày cộng các lượt thu tai của các lượt ấy). Dashboard nhân viên giữ sheet thao tác cũ.
   */
  ownerPhotos?: boolean;
}) {
  const [groupFilter, setGroupFilter] = useState<string>(ALL);
  const [departmentFilter, setDepartmentFilter] = useState<string>(ALL);
  const [openOnly, setOpenOnly] = useState(openOnlyByDefault);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [ownerKey, setOwnerKey] = useState<IntercomOwnerKey | null>(null);
  const [fillHandoverId, setFillHandoverId] = useState<string | null>(null);
  const [addUnitsHandoverId, setAddUnitsHandoverId] = useState<string | null>(null);
  // Đọc sau khi gắn (máy chủ không có `window`), trước đó vẽ Bảng.
  const [view, setView] = useState<IntercomBoardView>(fallbackView ?? "table");
  // Ô tìm: `ToolbarSearch` dùng chung (ô tự do `defaultValue` cộng ref bên trong, vì bàn phím tiếng Việt iOS); dưới
  // 768 bấm vào ô thì ô bung phủ cả hàng, che View, Lọc, Share; ✕ xoá chữ rồi đóng.
  const [searchText, setSearchText] = useState("");
  const searchQuery = foldText(searchText);
  const [shareOpen, setShareOpen] = useState(false);
  useEffect(() => setView(readStoredView(fallbackView)), [fallbackView]);
  const chooseView = (next: IntercomBoardView) => {
    setView(next);
    storeView(next);
  };
  const canFill = Boolean(onPersonFilled);
  const closeOwnerSheet = useCallback(() => setOwnerKey(null), []);
  const canDelete = Boolean(onHandoverDeleted);
  const { ask, dialog } = useConfirm();
  const [deleting, setDeleting] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [personToDelete, setPersonToDelete] = useState<{ id: string; fullName: string; department: string } | null>(null);

  const rows = useMemo(() => buildRows(board, canFill), [board, canFill]);
  const departments = useMemo(
    () => [...new Set(rows.map((r) => r.department).filter(Boolean))].sort((a, b) => a.localeCompare(b, "vi")),
    [rows],
  );
  const groups = useMemo(() => Array.from({ length: board.project.group_count }, (_, i) => i + 1), [board]);
  const days = useMemo(() => {
    const all = Array.from({ length: board.project.day_count }, (_, i) => i + 1);
    return dateFilter ? all.filter((d) => addDays(board.project.start_date, d - 1) === dateFilter) : all;
  }, [board, dateFilter]);

  // Mọi điều kiện lọc trừ công tắc "Chỉ thẻ còn tai ở ngoài".
  const matchingRows = rows.filter(
    (r) =>
      (groupFilter === ALL || String(r.group) === groupFilter) &&
      (departmentFilter === ALL || r.department === departmentFilter) &&
      matchesBoardSearch(
        searchQuery,
        [r.name, r.department],
        [...r.days.values()].flatMap((list) => list.map((i) => i.unit_code)),
      ),
  );
  const visibleRows = openOnly ? matchingRows.filter((r) => r.hasOpen) : matchingRows;
  // `buildRows` tạo sẵn dòng cho người chưa có tai, nên phải xét `r.days.size`: dự án chưa giao không được báo "đã
  // thu về hết".
  const allCollected = openOnly && visibleRows.length === 0 && matchingRows.some((r) => r.days.size > 0);

  const handoverById = useMemo(() => {
    const map = new Map<string, IntercomHandover>();
    for (const h of board.handovers) map.set(h.id, h);
    return map;
  }, [board]);

  const viewerItems: MediaViewerItem[] = useMemo(
    () =>
      board.handovers.map((h) => ({
        id: h.id,
        kind: "image" as const,
        src: photoUrl(h.id, "full"),
        caption: `${h.kind === "deliver" ? "Giao" : "Nhận"} · ${vnTime(h.taken_at)}`,
        alt: h.kind === "deliver" ? "Ảnh giao" : "Ảnh nhận",
      })),
    [board, photoUrl],
  );

  // Hộp xác nhận ghi rõ mã, tên, giờ; xoá xong làm mới bảng.
  const confirmDelete = async (id: string) => {
    const h = handoverById.get(id);
    if (!h || !onHandoverDeleted || deleting) return;
    const { codes, names, at } = handoverSummary(board, h);
    const isDeliver = h.kind === "deliver";
    const driveNote = await getIntercomDriveTrashNote([board.project.id]).catch(() => null);
    const ok = await ask({
      title: isDeliver ? "Xoá lượt giao" : "Xoá lượt thu",
      content: `${isDeliver ? "Giao" : "Thu"} ${codes} · ${names} · ${at}. ${
        isDeliver
          ? "Các tai của lượt này bị xoá khỏi bảng, ảnh giao bị xoá hẳn."
          : "Các tai của lượt này về lại trạng thái đang ở ngoài, ảnh nhận bị xoá hẳn."
      }${driveNote ? ` ${driveNote}` : ""}`,
      confirmLabel: "Xoá",
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    setDeleteNotice(null);
    try {
      await deleteIntercomHandover(id);
      setViewerId(null);
      await onHandoverDeleted();
      setDeleteNotice({ text: `Đã xoá lượt ${isDeliver ? "giao" : "thu"} ${codes} · ${names} · ${at}.`, error: false });
    } catch (e) {
      setDeleteNotice({ text: e instanceof Error ? e.message : "Chưa xoá được lượt, thử lại giúp tôi.", error: true });
    } finally {
      setDeleting(false);
    }
  };

  // Mở hộp gõ lại tên; xác nhận xong route xoá người cùng mọi lượt giao, thu của người đó ở mọi ngày (lượt thu chung
  // với người khác thì giữ).
  const confirmDeletePerson = (personId: string) => {
    const person = board.people.find((p) => p.id === personId);
    if (!person || !onHandoverDeleted || deleting) return;
    setPersonToDelete({ id: person.id, fullName: person.full_name, department: person.department });
  };

  const runDeletePerson = async () => {
    const target = personToDelete;
    setPersonToDelete(null);
    if (!target || !onHandoverDeleted || deleting) return;
    const label = `${target.fullName} (${target.department})`;
    setDeleting(true);
    setDeleteNotice(null);
    try {
      await deleteIntercomPerson(target.id);
      setViewerId(null);
      await onHandoverDeleted();
      setDeleteNotice({ text: `Đã xoá ${label} và mọi ảnh giao, thu của người này.`, error: false });
    } catch (e) {
      setDeleteNotice({ text: e instanceof Error ? e.message : "Chưa xoá được người này, thử lại giúp tôi.", error: true });
    } finally {
      setDeleting(false);
    }
  };

  const renderThumbs = (ids: string[], kind: "deliver" | "collect") => {
    if (ids.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-1">
        {ids.map((id) => {
          const h = handoverById.get(id);
          // Nút Điền tên đã dời sang ô Tên.
          const showDelete = canDelete && Boolean(h);
          if (h && showDelete) {
            return (
              <div key={id} className="flex flex-col items-start gap-1">
                <button
                  type="button"
                  onClick={() => setViewerId(id)}
                  className="size-11 shrink-0 overflow-hidden rounded-control border border-border bg-surface-2 active:opacity-70"
                  aria-label={`${kind === "deliver" ? "Ảnh giao" : "Ảnh nhận"} lúc ${vnTime(h.taken_at)}`}
                >
                  <ThumbImage src={photoUrl(id, "thumb")} />
                </button>
                {showDelete ? (
                  <button
                    type="button"
                    disabled={deleting}
                    onClick={() => void confirmDelete(id)}
                    className="h-11 whitespace-nowrap rounded-control border border-danger px-2 text-base font-medium text-danger active:bg-danger/10 disabled:opacity-50"
                  >
                    Xoá
                  </button>
                ) : null}
              </div>
            );
          }
          return (
            <button
              key={id}
              type="button"
              onClick={() => setViewerId(id)}
              className="size-11 shrink-0 overflow-hidden rounded-control border border-border bg-surface-2 active:opacity-70"
              aria-label={`${kind === "deliver" ? "Ảnh giao" : "Ảnh nhận"}${h ? ` lúc ${vnTime(h.taken_at)}` : ""}`}
            >
              <ThumbImage src={photoUrl(id, "thumb")} />
            </button>
          );
        })}
      </div>
    );
  };

  const stickyName = "sticky left-0 z-10 w-[120px] min-w-[120px] max-w-[120px] border-r border-border";
  const departmentCol = "w-[84px] min-w-[84px] max-w-[84px]";
  const groupCol = "w-[48px] min-w-[48px] max-w-[48px]";

  return (
    <div className="space-y-3">
      <ListToolbar
        className="max-md:[&:has([data-plain-search]_input:focus)_[data-toolbar-badge]]:hidden"
        view={
          <ViewModeToggle
            modes={["table", "list"]}
            value={view}
            onChange={(next) => chooseView(next === "list" ? "list" : "table")}
          />
        }
        search={
          <ToolbarSearch
            value={searchText}
            onChange={setSearchText}
            placeholder="Tên, bộ phận hoặc mã tai"
            label="Tìm theo tên, bộ phận hoặc mã tai"
            size="lg"
            plainSearch
          />
        }
        filter={{
          activeCount: (openOnly ? 1 : 0) + (groupFilter !== ALL ? 1 : 0) + (departmentFilter !== ALL ? 1 : 0),
          renderPanel: ({ open, onClose }) => (
            <IntercomFilterPopover open={open} onClose={onClose}>
              <button
                type="button"
                role="switch"
                aria-checked={openOnly}
                onClick={() => setOpenOnly((on) => !on)}
                className="flex min-h-11 w-full items-center justify-between gap-3 rounded-control border border-border bg-surface px-3 py-2 text-left active:bg-surface-2"
              >
                <span className="min-w-0 text-base text-fg">Chỉ thẻ còn tai ở ngoài</span>
                <span
                  aria-hidden
                  className={cn(
                    "relative h-7 w-12 shrink-0 rounded-full transition-colors",
                    openOnly ? "bg-brand-cta" : "bg-surface-2 ring-1 ring-inset ring-border",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 size-6 rounded-full bg-white shadow transition-[left]",
                      openOnly ? "left-[1.375rem]" : "left-0.5",
                    )}
                  />
                </span>
              </button>
              {groups.length > 1 ? (
                <select
                  value={groupFilter}
                  onChange={(e) => setGroupFilter(e.target.value)}
                  className="h-11 w-full rounded-control border border-border bg-surface px-2 text-base text-fg"
                  aria-label="Lọc theo Nhóm"
                >
                  <option value={ALL}>Mọi nhóm</option>
                  {groups.map((g) => (
                    <option key={g} value={String(g)}>
                      Nhóm {g}
                    </option>
                  ))}
                </select>
              ) : null}
              <select
                value={departmentFilter}
                onChange={(e) => setDepartmentFilter(e.target.value)}
                className="h-11 w-full rounded-control border border-border bg-surface px-2 text-base text-fg"
                aria-label="Lọc theo Bộ phận"
              >
                <option value={ALL}>Mọi bộ phận</option>
                {departments.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </IntercomFilterPopover>
          ),
        }}
        // Khe `timeRange` là chỗ ngay sau Lọc trong thứ tự cứng của `ListToolbar`: đặt Share ở đó để ô tìm bung phủ luôn
        // nút này.
        timeRange={
          sharePanel ? (
            <ToolbarButton
              icon={<Share2 className="size-4" aria-hidden />}
              label="Link khách"
              aria-haspopup="dialog"
              aria-expanded={shareOpen}
              onClick={() => setShareOpen(true)}
            />
          ) : null
        }
      />
      <IntercomDeptBar board={board} dateFilter={dateFilter} />

      {sharePanel && shareOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          role="dialog"
          aria-modal="true"
          aria-label="Link khách"
          onClick={(ev) => {
            if (ev.target === ev.currentTarget) setShareOpen(false);
          }}
        >
          <div className="max-h-full w-full max-w-md space-y-2 overflow-y-auto rounded-card bg-surface p-3">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setShareOpen(false)}
                aria-label="Đóng"
                className="flex size-11 items-center justify-center rounded-control text-fg active:bg-surface-2"
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>
            {sharePanel}
          </div>
        </div>
      ) : null}

      {deleteNotice ? (
        <p className={cn("text-base", deleteNotice.error ? "text-danger" : "text-success")} role="status">
          {deleteNotice.text}
        </p>
      ) : null}

      {view === "list" ? (
        <IntercomBoardList
          board={board}
          photoUrl={photoUrl}
          filters={{
            group: groupFilter === ALL ? null : groupFilter,
            department: departmentFilter === ALL ? null : departmentFilter,
            openOnly,
            date: dateFilter,
            query: searchQuery,
          }}
          onOpenPhoto={setViewerId}
          onFillName={canFill ? setFillHandoverId : undefined}
          onDelete={canDelete ? (id) => void confirmDelete(id) : undefined}
          onDeletePerson={canDelete ? confirmDeletePerson : undefined}
          onCollectAgain={onCollectAgain}
          onAddUnits={onUnitsAdded ? setAddUnitsHandoverId : undefined}
          onOpenOwner={ownerPhotos ? setOwnerKey : undefined}
          deleteBusy={deleting}
        />
      ) : (
        <div className="overflow-x-auto rounded-card border border-border bg-surface">
          <table className="border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th rowSpan={2} className={`${stickyName} bg-surface-2 px-2 py-2 font-semibold`}>
                  Tên
                </th>
                <th rowSpan={2} className={`${departmentCol} bg-surface-2 px-2 py-2 font-semibold`}>
                  Bộ phận
                </th>
                <th rowSpan={2} className={`${groupCol} bg-surface-2 px-2 py-2 font-semibold`}>
                  Nhóm
                </th>
                {days.map((d) => (
                  <th
                    key={d}
                    colSpan={3}
                    className={`border-b border-l border-border px-2 py-1.5 text-center font-semibold ${
                      addDays(board.project.start_date, d - 1) === board.today ? "bg-brand/10 text-fg" : "bg-surface-2"
                    }`}
                  >
                    Ngày {d} ({shortDate(addDays(board.project.start_date, d - 1))})
                  </th>
                ))}
              </tr>
              <tr className="text-left text-xs text-muted">
                {days.map((d) => (
                  <DayColumnHeads key={d} />
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.length === 0 ? (
                <tr>
                  <td colSpan={3 + days.length * 3} className="px-3 py-6 text-base text-muted">
                    <div className="sticky left-3 w-fit max-w-[calc(100vw-4rem)]">
                      {allCollected ? INTERCOM_ALL_COLLECTED_HINT : "Chưa có dòng nào khớp bộ lọc."}
                    </div>
                  </td>
                </tr>
              ) : (
                visibleRows.map((row) => (
                  <tr key={row.key} className="align-top">
                    <td className={`${stickyName} border-t border-border bg-surface px-2 py-2 font-medium text-fg`}>
                      {canDelete && row.key.startsWith("p:") ? (
                        <div className="flex items-start gap-1">
                          <span className="line-clamp-2 min-w-0 flex-1 break-words">{row.name}</span>
                          <button
                            type="button"
                            disabled={deleting}
                            onClick={() => confirmDeletePerson(row.key.slice(2))}
                            className="-my-2 flex size-11 shrink-0 items-center justify-center rounded-control text-danger active:bg-danger/10 disabled:opacity-50"
                            aria-label={`Xoá ${row.name} và mọi ảnh của người này`}
                          >
                            <Trash2 className="size-4" aria-hidden />
                          </button>
                        </div>
                      ) : canFill && row.deliverHandoverId ? (
                        <button
                          type="button"
                          onClick={() => setFillHandoverId(row.deliverHandoverId)}
                          className="h-11 whitespace-nowrap rounded-control border border-brand px-2 text-base font-medium text-brand active:bg-surface-2"
                          aria-label={`Điền tên cho lượt giao ${unnamedOwnerLabel(row.department, row.group)}${row.takenAt ? ` lúc ${vnClock(row.takenAt)}` : ""}`}
                        >
                          Điền tên
                        </button>
                      ) : ownerPhotos ? (
                        <button
                          type="button"
                          onClick={() =>
                            setOwnerKey(
                              row.key.startsWith("p:") ? row.key : labelOwnerKey(unnamedOwnerLabel(row.department, row.group)),
                            )
                          }
                          className="-mx-2 -my-2 block min-h-11 w-[calc(100%+1rem)] px-2 py-2 text-left font-medium text-fg active:bg-surface-2"
                          aria-label={`Xem ảnh giao nhận của ${row.name || unnamedOwnerLabel(row.department, row.group)}`}
                        >
                          <span className="line-clamp-2 break-words">{row.name}</span>
                        </button>
                      ) : (
                        <span className="line-clamp-2 break-words">{row.name}</span>
                      )}
                    </td>
                    <td className={`${departmentCol} border-t border-border bg-surface px-2 py-2 text-fg`}>
                      <span className="line-clamp-2 break-words">{row.department}</span>
                    </td>
                    <td className={`${groupCol} border-t border-border bg-surface px-2 py-2 text-center text-fg`}>
                      {row.group}
                    </td>
                    {days.map((d) => {
                      const list = [...(row.days.get(d) ?? [])].sort((a, b) => compareCodes(a.unit_code, b.unit_code));
                      return (
                        <DayCells
                          key={d}
                          issues={list}
                          deliverThumbs={renderThumbs(uniqueIds(list.map((i) => i.deliver_handover_id)), "deliver")}
                          collectThumbs={renderThumbs(uniqueIds(list.map((i) => i.collect_handover_id)), "collect")}
                        />
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {ownerKey ? (
        <IntercomPersonPhotosSheet
          board={board}
          ownerKey={ownerKey}
          photoUrl={photoUrl}
          onOpenPhoto={setViewerId}
          onClose={closeOwnerSheet}
          viewerOpen={Boolean(viewerId)}
        />
      ) : null}
      {viewerId ? (
        <MediaViewer
          items={viewerItems}
          currentId={viewerId}
          onClose={() => setViewerId(null)}
          onNavigate={(id) => setViewerId(id)}
        />
      ) : null}
      {fillHandoverId && onPersonFilled ? (
        <IntercomFillNameDialog
          board={board}
          handoverId={fillHandoverId}
          onClose={() => setFillHandoverId(null)}
          onDone={onPersonFilled}
        />
      ) : null}
      {addUnitsHandoverId && onUnitsAdded ? (
        <IntercomAddUnitsDialog
          board={board}
          handoverId={addUnitsHandoverId}
          onClose={() => setAddUnitsHandoverId(null)}
          onDone={async (message) => {
            await onUnitsAdded();
            // Dùng chung dòng báo của thao tác xoá.
            setDeleteNotice({ text: message, error: false });
          }}
        />
      ) : null}
      {dialog}
      {personToDelete ? (
        <IntercomDeletePersonDialog
          projectId={board.project.id}
          fullName={personToDelete.fullName}
          department={personToDelete.department}
          onCancel={() => setPersonToDelete(null)}
          onConfirm={() => void runDeletePerson()}
        />
      ) : null}
    </div>
  );
}

function DayColumnHeads() {
  return (
    <>
      <th className="border-b border-l border-border bg-surface-2 px-2 py-1.5 font-semibold">Mã tai</th>
      <th className="border-b border-border bg-surface-2 px-2 py-1.5 font-semibold">Ảnh giao</th>
      <th className="border-b border-border bg-surface-2 px-2 py-1.5 font-semibold">Ảnh nhận</th>
    </>
  );
}

function DayCells({
  issues,
  deliverThumbs,
  collectThumbs,
}: {
  issues: IntercomIssue[];
  deliverThumbs: ReactNode;
  collectThumbs: ReactNode;
}) {
  return (
    <>
      <td className="min-w-[96px] border-l border-t border-border px-2 py-2">
        <div className="flex flex-wrap gap-1">
          {issues.map((i) => (
            <span
              key={i.id}
              className={
                i.collect_handover_id
                  ? "rounded px-1.5 py-0.5 text-sm font-medium text-fg"
                  : "rounded bg-warning/20 px-1.5 py-0.5 text-sm font-semibold text-warning"
              }
              title={i.collect_handover_id ? "Đã thu" : "Chưa thu"}
            >
              {i.unit_code}
            </span>
          ))}
        </div>
      </td>
      <td className="min-w-[60px] border-t border-border px-2 py-2">{deliverThumbs}</td>
      <td className="min-w-[60px] border-t border-border px-2 py-2">
        {collectThumbs}
        {issues
          .filter((i) => i.fault_reason)
          .map((i) => (
            <p key={i.id} className="mt-1 max-w-[180px] break-words text-sm font-medium text-danger">
              {issues.length > 1 ? `${i.unit_code} ` : ""}Lỗi: {i.fault_reason}
            </p>
          ))}
      </td>
    </>
  );
}

/** Tấm Lọc: Nhóm, Bộ phận trong `ToolbarPopover`. */
function IntercomFilterPopover({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const anchorRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open) anchorRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [open]);
  return (
    <ToolbarPopover open={open} onClose={onClose} anchor={anchorRef} label="Lọc" className="w-[min(92vw,20rem)]">
      <div className="flex flex-col gap-2 p-3">{children}</div>
    </ToolbarPopover>
  );
}

/** Ô chọn ngày cho hàng tên dự án. */
export function IntercomDateSelect({
  project,
  value,
  onChange,
}: {
  project: IntercomBoard["project"];
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  return (
    <select
      value={value ?? ALL}
      onChange={(e) => onChange(e.target.value === ALL ? null : e.target.value)}
      className="h-11 shrink-0 rounded-control border border-border bg-surface px-2 text-base text-fg"
      aria-label="Lọc theo ngày"
    >
      <option value={ALL}>Mọi ngày</option>
      {Array.from({ length: project.day_count }, (_, i) => {
        const date = addDays(project.start_date, i);
        return (
          <option key={date} value={date}>
            Ngày {i + 1} ({shortDate(date)})
          </option>
        );
      })}
    </select>
  );
}
