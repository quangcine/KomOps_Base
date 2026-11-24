"use client";

// Xem trước khi Nạp, Update danh sách người từ Google Sheet. Mở hộp là đọc Sheet qua route `people-sheet` rồi chia
// ba nhóm ở máy (`buildIntercomSheetPreview`): Thêm mới, Khác với app, Lỗi (số dòng Sheet, lý do). Người trên app
// không có trong Sheet: không liệt kê. "Ghi" gọi `intercom_person_sheet_apply` với các id đã tick; máy chủ kiểm
// lại mọi luật. Kết quả một dòng `role="status"`.

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { IntercomPerson } from "@/lib/intercom/staffIntercom";
import { buildIntercomSheetPreview } from "@/lib/intercom/intercomPeopleSheet";
import {
  INTERCOM_BULK_PEOPLE_MAX,
  IntercomPeopleSheetError,
  applyIntercomPeopleSheet,
  readIntercomPeopleSheet,
  type IntercomSheetApplyResult,
} from "@/lib/intercom/staffIntercomProject";
import { Modal } from "@/components/ui/Modal";

const PRIVATE_SHEET_TEXT = "Sheet chưa mở Bất kỳ ai có đường liên kết. Mở chia sẻ rồi thử lại.";

export function IntercomSheetPreviewDialog({
  open,
  projectId,
  groupCount,
  people,
  onClose,
  onSaved,
}: {
  open: boolean;
  projectId: string;
  groupCount: number;
  people: readonly IntercomPerson[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [sheet, setSheet] = useState<{ header: string[]; rows: string[][] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IntercomSheetApplyResult | null>(null);

  const preview = useMemo(
    () => (sheet ? buildIntercomSheetPreview(sheet.header, sheet.rows, groupCount, people) : null),
    [sheet, groupCount, people],
  );

  const load = useCallback(async () => {
    setSheet(null);
    setLoadError(null);
    setError(null);
    setResult(null);
    setSkippedIds(new Set());
    try {
      setSheet(await readIntercomPeopleSheet(projectId));
    } catch (e) {
      if (e instanceof IntercomPeopleSheetError && e.reason === "not_public") setLoadError(PRIVATE_SHEET_TEXT);
      else setLoadError(e instanceof Error && e.message ? e.message : "Chưa đọc được Sheet, thử lại giúp tôi.");
    }
  }, [projectId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const close = () => {
    if (busy) return;
    onClose();
  };

  const toggle = (personId: string) =>
    setSkippedIds((prev) => {
      const next = new Set(prev);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });

  const save = async () => {
    if (!preview || preview.tooMany) return;
    const ticked = preview.changes.filter((c) => !skippedIds.has(c.person.id));
    const sent = [...preview.adds, ...ticked];
    setBusy(true);
    setError(null);
    try {
      const value = await applyIntercomPeopleSheet(
        projectId,
        sent.map((item) => item.row),
        ticked.map((c) => c.person.id),
      );
      // Lỗi máy chủ trả theo thứ tự đã gửi: đổi về số dòng Sheet.
      setResult({ ...value, invalid: value.invalid.map((item) => ({ ...item, row: sent[item.row - 1]?.line ?? item.row })) });
      setSheet(null);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Chưa ghi được danh sách, thử lại giúp tôi.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} title="Danh sách từ Sheet" width="medium">
      <div className="space-y-3">
        {!preview && !loadError && !result ? <p className="text-base text-muted">Đang đọc Sheet...</p> : null}
        {loadError ? <p className="text-base text-danger">{loadError}</p> : null}

        {preview ? (
          <>
            {preview.headerMismatch ? (
              <p className="flex items-start gap-2 rounded-control bg-warning/12 p-3 text-sm text-warning">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                Hàng tiêu đề khác mẫu (Tên, Bộ phận, Nhóm, Số điện thoại). Kiểm thứ tự cột.
              </p>
            ) : null}
            {preview.tooMany ? (
              <p className="text-base text-danger">
                Quá {INTERCOM_BULK_PEOPLE_MAX} người một lượt. Chia Sheet làm nhiều lượt.
              </p>
            ) : null}

            <section className="space-y-1">
              <h3 className="text-base font-semibold text-fg">Thêm mới ({preview.adds.length})</h3>
              {preview.adds.map((item) => (
                <p key={`a${item.line}`} className="text-sm text-fg">
                  {item.row.full_name} · {item.row.department} · Nhóm {item.row.group_no}
                </p>
              ))}
            </section>

            <section className="space-y-1">
              <h3 className="text-base font-semibold text-fg">Khác với app ({preview.changes.length})</h3>
              {preview.changes.map((item) => (
                <label key={`c${item.line}`} className="flex min-h-11 items-start gap-2 py-1 text-sm text-fg">
                  <input
                    type="checkbox"
                    checked={!skippedIds.has(item.person.id)}
                    onChange={() => toggle(item.person.id)}
                    className="mt-0.5 size-5 shrink-0"
                  />
                  <span className="min-w-0">
                    <span className="block font-semibold">{item.person.full_name}</span>
                    {item.diffs.map((d) => (
                      <span key={d.label} className="block text-muted">
                        {d.label}: {d.before || "(trống)"} → {d.after}
                      </span>
                    ))}
                  </span>
                </label>
              ))}
            </section>

            <section className="space-y-1">
              <h3 className="text-base font-semibold text-fg">Lỗi ({preview.invalid.length})</h3>
              {preview.invalid.map((item) => (
                <p key={`i${item.line}`} className="text-sm text-danger">
                  Dòng {item.line}: {item.reason}
                </p>
              ))}
            </section>
          </>
        ) : null}

        {result ? (
          <div className="space-y-1">
            <p role="status" className="text-base text-fg">
              Đã thêm {result.added} · cập nhật {result.updated} · bỏ qua {result.skipped} · lỗi {result.invalid.length}
            </p>
            {result.invalid.map((item) => (
              <p key={`r${item.row}`} className="text-sm text-danger">
                Dòng {item.row}: {item.reason}
              </p>
            ))}
          </div>
        ) : null}

        {error ? <p className="text-base text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={close}
            className="h-11 rounded-control border border-border bg-surface px-3 text-base text-fg active:bg-surface-2"
          >
            {result ? "Đóng" : "Huỷ"}
          </button>
          {loadError && !result ? (
            <button
              type="button"
              onClick={() => void load()}
              className="h-11 rounded-control border border-border bg-surface px-3 text-base text-fg active:bg-surface-2"
            >
              Đọc lại
            </button>
          ) : null}
          {!result ? (
            <button
              type="button"
              disabled={busy || !preview || preview.tooMany}
              onClick={() => void save()}
              className="h-11 rounded-control bg-brand-cta px-4 text-base font-semibold text-white active:bg-brand-cta-hover disabled:opacity-50"
            >
              {busy ? "Đang ghi..." : "Ghi"}
            </button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
