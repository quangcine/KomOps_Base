"use client";

// Form thông tin dự án intercom: tên, ngày bắt đầu, số ngày, số nhóm. Dùng cho Tạo dự án (popup ở danh sách) và
// khối Thông tin của màn chi tiết. Ô tên không điều khiển (`defaultValue` cộng ref): bàn phím tiếng Việt iOS bỏ
// dấu bằng xoá lùi rồi chèn lại, ô `value` ghi đè. Ô nơi lưu: prop `storage`, hiện ngay sau `extraFields`, trên
// dòng lỗi và nút lưu.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { IntercomProject } from "@/lib/intercom/staffIntercom";
import type { StorageChoice } from "@/lib/intercom/staffIntercomDrive";
import { INTERCOM_NAME_MAX, type IntercomProjectInput } from "@/lib/intercom/staffIntercomProject";
import { Select } from "@/components/ui/Control";
import { storageChoiceKey, type StorageOption } from "./IntercomStorageField";
import { addDays, shortDate, vnDate } from "./intercomView";

const DAY_COUNT_MAX = 60;
const GROUP_COUNT_MAX = 6;

const FIELD_CLASS =
  "mt-1 h-12 w-full rounded-control border border-border bg-surface px-3 text-base text-fg disabled:bg-surface-2 disabled:text-muted";

/**
 * Trạng thái một form trong popup báo lên chỗ mở popup: còn chữ chưa lưu thì đóng popup phải hỏi trước, đang lưu
 * thì không đóng.
 */
export type IntercomFormState = { dirty: boolean; busy: boolean };

/** Ô nơi lưu do chỗ gọi điều khiển. `initial` để biết đã đổi chưa; `required` bắt chọn. */
export type IntercomStorageInput = {
  value: StorageChoice | null;
  initial: StorageChoice | null;
  onChange: (choice: StorageChoice | null) => void;
  required: boolean;
  options: readonly StorageOption[];
  /** Khoá ô. */
  disabled?: boolean;
};

export function IntercomProjectForm({
  project,
  initialValues,
  extraFields,
  locked = false,
  cancelLabel = "Huỷ",
  submitLabel,
  onSubmit,
  onCancel,
  onStateChange,
  storage,
}: {
  /** Dự án đang sửa; không truyền là form tạo mới. */
  project?: IntercomProject;
  initialValues?: { name?: string; startDate?: string; dayCount?: number };
  /** Khối thêm nằm dưới các ô, trên dòng lỗi. */
  extraFields?: ReactNode;
  /** Khoá các ô thông tin (dự án đã tạo, chỉ còn Thử lại bước nối đơn). */
  locked?: boolean;
  cancelLabel?: string;
  submitLabel: string;
  /**
   * Ném lỗi thì form hiện câu lỗi; xong thì form tự hiện "Đã lưu." khi đang sửa. `storage`: lựa chọn ở ô nơi lưu,
   * không có ô thì `null`.
   */
  onSubmit: (input: IntercomProjectInput, storage: StorageChoice | null) => Promise<void>;
  onCancel?: () => void;
  /** Form nằm trong popup thì truyền vào để chỗ mở popup biết còn chữ chưa lưu. */
  onStateChange?: (state: IntercomFormState) => void;
  /** Ô nơi lưu ở cuối form; không truyền là không có ô. */
  storage?: IntercomStorageInput;
}) {
  const nameRef = useRef<HTMLInputElement | null>(null);
  const initialName = project?.name ?? initialValues?.name ?? "";
  const [startDate, setStartDate] = useState(project?.start_date ?? initialValues?.startDate ?? vnDate(new Date()));
  const [dayCount, setDayCount] = useState(String(project?.day_count ?? initialValues?.dayCount ?? 1));
  const [groupCount, setGroupCount] = useState(project?.group_count ?? 1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [nameDirty, setNameDirty] = useState(false);
  const initialRef = useRef({ startDate, dayCount, groupCount });
  // `busy` là state nên `disabled` chưa áp trong cùng nhịp JS: nhiều lượt bấm cùng nhịp phải chặn bằng ref, kẻo tạo
  // trùng dự án.
  const submitLockRef = useRef(false);

  const storageKey = storage ? storageChoiceKey(storage.value) : "";
  const storageInitialKey = storage ? storageChoiceKey(storage.initial) : "";

  useEffect(() => {
    const initial = initialRef.current;
    const dirty =
      nameDirty ||
      startDate !== initial.startDate ||
      dayCount !== initial.dayCount ||
      groupCount !== initial.groupCount ||
      storageKey !== storageInitialKey;
    onStateChange?.({ dirty, busy });
  }, [nameDirty, startDate, dayCount, groupCount, storageKey, storageInitialKey, busy, onStateChange]);

  const days = Number(dayCount);
  const daysValid = Number.isInteger(days) && days >= 1 && days <= DAY_COUNT_MAX;

  const submit = async () => {
    if (submitLockRef.current) return;
    const name = (nameRef.current?.value ?? "").trim().replace(/\s+/g, " ");
    setNotice(null);
    if (name === "") return setError("Chưa nhập tên dự án.");
    if (name.length > INTERCOM_NAME_MAX) return setError(`Tên dự án tối đa ${INTERCOM_NAME_MAX} ký tự.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return setError("Chưa chọn ngày bắt đầu.");
    if (!daysValid) return setError(`Số ngày từ 1 tới ${DAY_COUNT_MAX}.`);
    if (storage?.required && !storage.value) return setError("Chọn nơi lưu ảnh.");
    setError(null);
    // Khoá đặt sau bốn câu kiểm: chúng `return` ngoài `try`, đặt trước là khoá kẹt và form chết tới khi dựng lại.
    submitLockRef.current = true;
    setBusy(true);
    try {
      await onSubmit({ name, startDate, dayCount: days, groupCount }, storage?.value ?? null);
      if (project) setNotice("Đã lưu.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chưa lưu được, thử lại giúp tôi.");
    } finally {
      submitLockRef.current = false;
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="block text-base text-fg">
        Tên dự án
        <input
          ref={nameRef}
          defaultValue={initialName}
          onInput={(e) => setNameDirty(e.currentTarget.value !== initialName)}
          maxLength={INTERCOM_NAME_MAX}
          autoComplete="off"
          disabled={locked}
          className={FIELD_CLASS}
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-base text-fg">
          Ngày bắt đầu
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            disabled={locked}
            className={FIELD_CLASS}
          />
        </label>
        <label className="block text-base text-fg">
          Số ngày
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={DAY_COUNT_MAX}
            value={dayCount}
            onChange={(e) => setDayCount(e.target.value)}
            disabled={locked}
            className={FIELD_CLASS}
          />
        </label>
      </div>
      {daysValid && /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? (
        <p className="text-sm text-muted">
          Từ {shortDate(startDate)} tới {shortDate(addDays(startDate, days - 1))}
        </p>
      ) : null}
      <label className="block text-base text-fg">
        Số nhóm
        <select
          value={groupCount}
          onChange={(e) => setGroupCount(Number(e.target.value))}
          disabled={locked}
          className={FIELD_CLASS}
        >
          {Array.from({ length: GROUP_COUNT_MAX }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n} nhóm
            </option>
          ))}
        </select>
      </label>
      {extraFields}
      {storage ? (
        <label className="block text-base text-fg">
          Nơi lưu ảnh
          <Select
            value={storageKey}
            onChange={(e) => {
              const picked = storage.options.find((o) => storageChoiceKey(o.choice) === e.target.value);
              storage.onChange(picked ? picked.choice : null);
            }}
            disabled={locked || storage.disabled}
            className="mt-1 w-full"
          >
            {storage.required || !storage.value ? (
              <option value="" disabled>
                Chọn nơi lưu ảnh
              </option>
            ) : null}
            {storage.options.map((option) => (
              <option key={storageChoiceKey(option.choice)} value={storageChoiceKey(option.choice)}>
                {option.label}
              </option>
            ))}
          </Select>
          {storage.value?.kind === "drive_new" ? (
            <span className="mt-1 block text-sm text-muted">Chỉ nối tài khoản Google nội bộ của bạn.</span>
          ) : null}
        </label>
      ) : null}
      {error ? <p className="text-base text-danger">{error}</p> : null}
      {notice ? <p className="text-base text-muted">{notice}</p> : null}
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="h-11 rounded-control border border-border bg-surface px-3 text-base text-fg active:bg-surface-2"
          >
            {cancelLabel}
          </button>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          className="h-11 rounded-control bg-brand-cta px-4 text-base font-semibold text-white active:bg-brand-cta-hover disabled:opacity-50"
        >
          {busy ? "Đang lưu..." : submitLabel}
        </button>
      </div>
    </form>
  );
}
