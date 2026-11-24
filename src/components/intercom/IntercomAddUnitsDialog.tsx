"use client";

// Sửa lượt giao, thêm tai. Cùng người hoặc bộ phận, cùng ảnh; chỉ THÊM mã, không bớt. Chọn mã bằng accordion theo
// bộ của màn Giao (`IntercomUnitPicker`, mã đang ở ngoài và mã đã có trong lượt đều ẩn). Lưu gọi
// `addIntercomHandoverUnits`; xong thì báo "Đã thêm <mã> cho <tên>" và làm mới dashboard. Lỗi (mã máy khác vừa
// giao, lượt không sửa được) thì giữ lựa chọn, hiện câu của máy chủ.

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { addIntercomHandoverUnits, type IntercomBoard } from "@/lib/intercom/staffIntercom";
import { IntercomUnitPicker } from "./IntercomUnitPicker";
import { UNNAMED_DEPARTMENT, compactCodes, departmentLabel, openUnitIds } from "./intercomView";

export function IntercomAddUnitsDialog({
  board,
  handoverId,
  onClose,
  onDone,
}: {
  board: IntercomBoard;
  handoverId: string;
  onClose: () => void;
  /** Gọi sau khi lưu xong, kèm câu báo; chỗ gọi làm mới dashboard và hiện câu báo. */
  onDone: (message: string) => void | Promise<void>;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handover = useMemo(() => board.handovers.find((h) => h.id === handoverId) ?? null, [board, handoverId]);
  const currentIssues = useMemo(
    () => board.issues.filter((i) => i.deliver_handover_id === handoverId),
    [board, handoverId],
  );
  // "Đang có:" chỉ in tai còn ngoài, phải sát thực tế.
  const openCodes = currentIssues.filter((i) => !i.collect_handover_id).map((i) => i.unit_code);
  const name = useMemo(() => {
    const person = handover?.person_id ? board.people.find((p) => p.id === handover.person_id) : null;
    if (person) return person.full_name;
    const department = handover?.department ?? "";
    if (department === UNNAMED_DEPARTMENT) return UNNAMED_DEPARTMENT;
    return departmentLabel(department, handover?.group_no ?? 1);
  }, [board, handover]);
  const hiddenUnits = useMemo(
    () => new Set([...openUnitIds(board), ...currentIssues.map((i) => i.unit_id)]),
    [board, currentIssues],
  );
  // Máy khác vừa giao (dashboard tự làm mới 15 giây): bỏ khỏi lựa chọn mã nay đã ở ngoài.
  const pickedIds = useMemo(() => [...selected].filter((id) => !hiddenUnits.has(id)), [selected, hiddenUnits]);

  const save = async () => {
    if (busy || pickedIds.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const added = await addIntercomHandoverUnits({ handoverId, unitIds: pickedIds });
      await onDone(`Đã thêm ${compactCodes(added)} cho ${name}.`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chưa thêm được mã tai, thử lại giúp tôi.");
    } finally {
      setBusy(false);
    }
  };

  // Esc đóng hộp; đang lưu thì không đóng (như bấm nền).
  useEffect(() => {
    if (busy) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      role="dialog"
      aria-modal="true"
      aria-label={`Thêm tai cho ${name}`}
      onClick={(ev) => {
        if (ev.target === ev.currentTarget && !busy) onClose();
      }}
    >
      <div className="flex max-h-full w-full max-w-md flex-col rounded-card bg-surface">
        <div className="flex items-start justify-between gap-2 p-4 pb-2">
          <div className="min-w-0">
            <h2 className="break-words text-block font-semibold text-fg">Thêm tai cho {name}</h2>
            <p className="break-words text-base text-muted">
              Đang có:{" "}
              {currentIssues.length === 0 ? "chưa có mã" : openCodes.length > 0 ? compactCodes(openCodes) : "đã thu hết"}
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="flex size-11 shrink-0 items-center justify-center rounded-control border border-border text-fg active:bg-surface-2 disabled:opacity-50"
            aria-label="Đóng"
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-2">
          <IntercomUnitPicker units={board.units} outUnits={hiddenUnits} selected={selected} onChange={setSelected} />
        </div>
        <div className="space-y-2 border-t border-border px-4 pt-2 pb-4">
          {error ? (
            <p className="text-base text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            disabled={busy || pickedIds.length === 0}
            onClick={() => void save()}
            className="h-12 w-full rounded-control bg-brand-cta text-base font-semibold text-white active:bg-brand-cta-hover disabled:opacity-40"
          >
            {busy
              ? "Đang lưu..."
              : pickedIds.length > 0
                ? `Lưu (thêm ${pickedIds.length} mã)`
                : "Lưu"}
          </button>
        </div>
      </div>
    </div>
  );
}
