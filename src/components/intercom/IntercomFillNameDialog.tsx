"use client";

// Điền tên sau cho một lượt giao chưa rõ tên hoặc giao bộ phận. Chỉ dashboard nhân viên mở hộp này. Gõ tên có gợi
// ý như màn Giao; tên chưa có thì "Thêm <tên> vào danh sách" qua `createIntercomPerson`; chọn xong gọi
// `setIntercomHandoverPerson` rồi làm mới bảng. Ô gõ chữ không điều khiển (`defaultValue` cộng ref): bàn phím
// tiếng Việt iOS bỏ dấu bằng xoá lùi rồi chèn lại, ô `value` sẽ ghi đè giữa chuỗi.

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { createIntercomPerson, setIntercomHandoverPerson, type IntercomBoard } from "@/lib/intercom/staffIntercom";
import { compactCodes, foldText, knownDepartments } from "./intercomView";

export function IntercomFillNameDialog({
  board,
  handoverId,
  onClose,
  onDone,
}: {
  board: IntercomBoard;
  handoverId: string;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [newDepartment, setNewDepartment] = useState("");
  const [newGroup, setNewGroup] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const codes = useMemo(
    () => compactCodes(board.issues.filter((i) => i.deliver_handover_id === handoverId).map((i) => i.unit_code)),
    [board, handoverId],
  );
  const departments = useMemo(() => knownDepartments(board), [board]);
  const groupCount = board.project.group_count;
  const nameInput = query.trim().replace(/\s+/g, " ");
  const folded = foldText(nameInput);
  const matches = useMemo(
    () => (folded ? board.people.filter((p) => foldText(p.full_name).includes(folded)).slice(0, 8) : []),
    [board, folded],
  );
  const exactMatch = Boolean(folded) && board.people.some((p) => foldText(p.full_name) === folded);

  const assign = async (personId: string) => {
    await setIntercomHandoverPerson({ handoverId, personId });
    await onDone();
    onClose();
  };

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chưa điền được tên, thử lại giúp tôi.");
    } finally {
      setBusy(false);
    }
  };

  const addAndAssign = () =>
    run(async () => {
      const id = await createIntercomPerson({
        projectId: board.project.id,
        fullName: nameInput,
        department: newDepartment.trim(),
        group: newGroup,
      });
      await assign(id);
    });

  // Esc đóng hộp; bộ gõ đang ghép chữ thì Esc là huỷ ghép, đang lưu thì không đóng.
  useEffect(() => {
    if (busy) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && !ev.isComposing) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      role="dialog"
      aria-modal="true"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget && !busy) onClose();
      }}
    >
      <div className="max-h-full w-full max-w-md space-y-3 overflow-y-auto rounded-card bg-surface p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-block font-semibold text-fg">Điền tên người nhận</h2>
            {codes ? <p className="text-base text-muted">Mã tai: {codes}</p> : null}
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

        <input
          ref={nameInputRef}
          defaultValue=""
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setAddOpen(false);
          }}
          placeholder="Gõ tên người nhận"
          aria-label="Tên người nhận"
          autoFocus
          className="h-12 w-full rounded-control border border-border bg-surface px-3 text-base text-fg"
        />

        {matches.length > 0 ? (
          <ul className="overflow-hidden rounded-control border border-border">
            {matches.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => assign(p.id))}
                  className="flex min-h-12 w-full flex-col justify-center border-b border-border px-3 py-1.5 text-left last:border-b-0 active:bg-surface-2 disabled:opacity-50"
                >
                  <span className="text-base font-medium text-fg">{p.full_name}</span>
                  <span className="text-sm text-muted">
                    {p.department} · Nhóm {p.group_no}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {nameInput && !exactMatch ? (
          addOpen ? (
            <div className="space-y-2 rounded-control border border-border p-3">
              <div className="text-base font-medium text-fg">Thêm &quot;{nameInput}&quot; vào danh sách</div>
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <input
                  defaultValue={newDepartment}
                  onChange={(e) => setNewDepartment(e.currentTarget.value)}
                  list="intercom-fill-departments"
                  placeholder="Bộ phận"
                  aria-label="Bộ phận của người mới"
                  className="h-12 min-w-0 rounded-control border border-border bg-surface px-3 text-base text-fg"
                />
                {groupCount > 1 ? (
                  <select
                    value={newGroup}
                    onChange={(e) => setNewGroup(Number(e.target.value))}
                    aria-label="Nhóm của người mới"
                    className="h-12 rounded-control border border-border bg-surface px-3 text-base text-fg"
                  >
                    {Array.from({ length: groupCount }, (_, i) => i + 1).map((g) => (
                      <option key={g} value={g}>
                        Nhóm {g}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
              <datalist id="intercom-fill-departments">
                {departments.map((d) => (
                  <option key={d} value={d} />
                ))}
              </datalist>
              <button
                type="button"
                disabled={busy || !newDepartment.trim()}
                onClick={() => void addAndAssign()}
                className="h-12 w-full rounded-control bg-brand-cta text-base font-semibold text-white active:bg-brand-cta-hover disabled:opacity-40"
              >
                {busy ? "Đang lưu..." : "Thêm và điền"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="min-h-12 w-full rounded-control border border-dashed border-border px-3 py-2 text-left text-base text-fg active:bg-surface-2"
            >
              Thêm &quot;{nameInput}&quot; vào danh sách
            </button>
          )
        ) : null}

        {error ? <p className="text-base text-danger">{error}</p> : null}
      </div>
    </div>
  );
}
