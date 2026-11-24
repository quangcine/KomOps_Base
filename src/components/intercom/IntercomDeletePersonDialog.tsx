"use client";

// Hộp xác nhận xoá một người nhận cùng MỌI ảnh giao, thu của người đó ở mọi ngày. Nút Xoá chỉ bật khi chữ gõ khớp
// tên: so sau khi trim, gộp khoảng trắng, không phân biệt hoa thường, VẪN phân biệt dấu. Ô gõ không điều khiển
// (`defaultValue` cộng ref), đọc giá trị qua `onInput`: bàn phím tiếng Việt iOS bỏ dấu bằng xoá lùi rồi chèn lại,
// ô `value` sẽ ghi đè giữa chuỗi.

import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { getIntercomDriveTrashNote } from "@/lib/intercom/staffIntercomDrive";

const normalizeName = (text: string) => text.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("vi");

export function IntercomDeletePersonDialog({
  projectId,
  fullName,
  department,
  onCancel,
  onConfirm,
}: {
  projectId: string;
  fullName: string;
  department: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [matched, setMatched] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const expected = normalizeName(fullName);
  const [driveNote, setDriveNote] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getIntercomDriveTrashNote([projectId])
      .then((note) => {
        if (active) setDriveNote(note);
      })
      .catch(() => {
        if (active) setDriveNote(null);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel]);

  const readMatch = () => normalizeName(inputRef.current?.value ?? "") === expected;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-3"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="intercom-delete-person-title"
    >
      <div className="w-full max-w-sm rounded-card border border-border bg-surface p-3 shadow-[var(--shadow-e2)]">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-danger/10 text-danger">
            <AlertTriangle size={18} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="intercom-delete-person-title" className="text-card font-semibold text-fg">
              Xoá người nhận
            </h2>
            <p className="mt-1 text-body leading-relaxed text-muted">
              Xoá {fullName} ({department}) và TẤT CẢ ảnh giao, thu của người này ở mọi ngày. Không lùi lại được.
            </p>
            {driveNote ? <p className="mt-1 text-body leading-relaxed text-muted">{driveNote}</p> : null}
          </div>
        </div>
        <label className="mt-3 block text-base text-fg">
          Gõ lại tên <span className="font-semibold">{fullName}</span> để xác nhận
          <input
            ref={inputRef}
            defaultValue=""
            onInput={() => setMatched(readMatch())}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label={`Gõ lại tên ${fullName} để xác nhận`}
            className="mt-1 h-12 w-full rounded-control border border-border bg-surface px-3 text-base text-fg"
          />
        </label>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-11 rounded-control border border-border bg-surface px-3 text-body text-muted hover:text-fg active:bg-surface-2"
          >
            Huỷ
          </button>
          <button
            type="button"
            disabled={!matched}
            onClick={() => {
              if (readMatch()) onConfirm();
            }}
            className="h-11 rounded-control bg-danger px-3 text-body font-semibold text-white active:opacity-80 disabled:opacity-40"
          >
            Xoá
          </button>
        </div>
      </div>
    </div>
  );
}
