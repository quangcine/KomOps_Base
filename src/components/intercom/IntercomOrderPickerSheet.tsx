"use client";

// Chỉ quản lý mở được; máy chủ vẫn tự chặn.
// Người `eligible` false không vào chip vì máy chủ sẽ bỏ qua họ.
// - Lưu hai bước: tạo dự án rồi nối đơn. Bước hai hỏng thì giữ form, khoá ô thông tin, nút Thử lại chỉ gọi lại
// bước hai với `project_id` đã có, không tạo dự án thứ hai.
// - Ô nơi lưu bắt chọn; việc theo nơi lưu (tạo thư mục, nối Google) chạy sau khi nối đơn xong, cả ở nhánh Thử lại.
// Ô tìm không điều khiển (`defaultValue` cộng `onInput`): bàn phím tiếng Việt iOS bỏ dấu bằng xoá lùi rồi chèn
// lại, ô `value` ghi đè.

import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Plus, Search, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import {
  applyIntercomOrder,
  getIntercomOrderDraft,
  listIntercomOrderCandidates,
  searchIntercomMemberCandidates,
  type IntercomMemberCandidate,
  type IntercomOrderCandidate,
  type IntercomOrderDraft,
} from "@/lib/intercom/staffIntercom";
import {
  listIntercomDriveAccountOptions,
  type IntercomDriveAccountOption,
  type StorageChoice,
} from "@/lib/intercom/staffIntercomDrive";
import { createIntercomProject, type IntercomProjectInput } from "@/lib/intercom/staffIntercomProject";
import { orderUrl } from "@/adapters/orders";
import { useConfirm } from "@/components/ui/useConfirm";
import { IntercomProjectForm, type IntercomFormState } from "./IntercomProjectForm";
import { finishCreatedStorage, storageChoiceOptions } from "./IntercomStorageField";
import { storeProjectId } from "./intercomView";

const SEARCH_DELAY_MS = 300;
const SECONDARY_BUTTON =
  "h-11 rounded-control border border-border bg-surface px-3 text-base text-fg active:bg-surface-2 disabled:opacity-50";
const NO_LOGIN_LABEL = "Cộng tác viên, chưa có tài khoản";
const LINK_FAILED_TEXT = "Đã tạo dự án, chưa nối đơn";

/** Người đang chọn vào dự án. */
type SelectedMember = { profile_id: string; name: string; has_login: boolean };

/** `YYYY-MM-DD` thành `dd/mm/yyyy`: đơn có thể qua năm nên phải kèm năm. */
function fullDate(isoDate: string): string {
  return isoDate.split("-").reverse().join("/");
}

function orderDateRange(start: string | null, end: string | null): string {
  if (!start && !end) return "Chưa có ngày";
  return `${start ? fullDate(start) : "?"} tới ${end ? fullDate(end) : "?"}`;
}

function customerLabel(code: string | null, name: string | null): string {
  return [code, name].filter(Boolean).join(" · ") || "Chưa có khách";
}

function unitHint(draft: IntercomOrderDraft): string {
  if (draft.unit_count === null) return "Chưa rõ số tai";
  const models = draft.units_by_model;
  if (models.length === 0) return `Đơn có ${draft.unit_count} tai`;
  const detail = models.length === 1 ? models[0].model_name : models.map((m) => `${m.model_name} ${m.unit_count}`).join(", ");
  return `Đơn có ${draft.unit_count} tai: ${detail}`;
}

export function IntercomOrderPickerSheet({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  /** Tạo và nối đơn xong; `path` là màn dự án cần mở (có thể kèm `drive_notice`). */
  onCreated: (projectId: string, path: string) => void;
}) {
  const [draft, setDraft] = useState<IntercomOrderDraft | null>(null);
  const [members, setMembers] = useState<SelectedMember[]>([]);
  const [membersDirty, setMembersDirty] = useState(false);
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);
  // Ref cộng state: Thử lại phải đọc được id ngay cả khi màn chưa kịp vẽ lại, để không bao giờ tạo dự án thứ hai.
  const createdProjectIdRef = useRef<string | null>(null);
  const [storage, setStorage] = useState<StorageChoice | null>(null);
  /** Nơi lưu đã gửi lúc tạo: Thử lại dùng lại, không đọc ô (ô đã khoá). */
  const createdStorageRef = useRef<StorageChoice | null>(null);
  const [driveAccounts, setDriveAccounts] = useState<IntercomDriveAccountOption[]>([]);
  const formStateRef = useRef<IntercomFormState>({ dirty: false, busy: false });
  const { ask, dialog } = useConfirm();

  const reportFormState = useCallback((state: IntercomFormState) => {
    formStateRef.current = state;
  }, []);

  useEffect(() => {
    let alive = true;
    listIntercomDriveAccountOptions()
      .then((accounts) => {
        if (alive) setDriveAccounts(accounts);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const pickOrder = (next: IntercomOrderDraft) => {
    formStateRef.current = { dirty: false, busy: false };
    setDraft(next);
    setStorage(null);
    setMembersDirty(false);
    setMembers(
      next.members
        .filter((m) => m.eligible)
        .map((m) => ({ profile_id: m.profile_id, name: m.name, has_login: m.has_login })),
    );
  };

  const hasUnsavedChanges = () => formStateRef.current.dirty || membersDirty;

  const requestBack = async () => {
    if (formStateRef.current.busy) return;
    if (hasUnsavedChanges() && !(await ask({ content: "Bỏ các thay đổi chưa lưu?", confirmLabel: "Bỏ thay đổi", danger: true }))) return;
    setDraft(null);
  };

  const requestClose = async () => {
    if (formStateRef.current.busy) return;
    if (createdProjectIdRef.current) {
      const confirmed = await ask({
        title: "Dự án chưa nối đơn",
        content: "Đóng lại thì dự án vừa tạo vẫn còn trong danh sách nhưng không nối với đơn này.",
        confirmLabel: "Đóng",
        danger: true,
      });
      if (!confirmed) return;
    } else if (draft && hasUnsavedChanges() && !(await ask({ content: "Bỏ các thay đổi chưa lưu?", confirmLabel: "Bỏ thay đổi", danger: true }))) {
      return;
    }
    onClose();
  };

  const submit = async (input: IntercomProjectInput, picked: StorageChoice | null) => {
    if (!draft) return;
    let projectId = createdProjectIdRef.current;
    if (!projectId) {
      if (!picked) throw new Error("Chọn nơi lưu ảnh.");
      projectId = await createIntercomProject(input, picked);
      createdProjectIdRef.current = projectId;
      createdStorageRef.current = picked;
      setCreatedProjectId(projectId);
      storeProjectId(projectId);
    }
    try {
      await applyIntercomOrder(projectId, draft.order_id, members.map((m) => m.profile_id));
    } catch (e) {
      throw new Error(`${LINK_FAILED_TEXT}. ${e instanceof Error ? e.message : "Chưa nối được đơn vào dự án."}`);
    }
    const path = await finishCreatedStorage(projectId, createdStorageRef.current ?? { kind: "r2" });
    if (path) onCreated(projectId, path);
  };

  const skippedNames = draft ? draft.members.filter((m) => !m.eligible).map((m) => m.name) : [];

  return (
    <Modal open onClose={() => void requestClose()} title="Tạo từ đơn" width="narrow">
      {/* Giữ bước chọn đơn trong cây khi sang form: quay lại vẫn còn chữ đã tìm. */}
      <div className={draft ? "hidden" : "space-y-2"}>
        <OrderPicker onPicked={pickOrder} />
      </div>

      {draft ? (
        <div className="space-y-3">
          {!createdProjectId ? (
            <button type="button" onClick={() => void requestBack()} className={SECONDARY_BUTTON}>
              Chọn đơn khác
            </button>
          ) : null}
          <div className="space-y-1 rounded-control bg-surface-2 p-3">
            <p className="text-base font-semibold text-fg">Đơn {draft.display_code}</p>
            <p className="text-sm text-muted">{orderDateRange(draft.start_date, draft.end_date)}</p>
            <p className="text-sm text-muted">Khách: {customerLabel(draft.customer_code, draft.customer_name)}</p>
            <p className="text-sm text-fg">{unitHint(draft)}</p>
            {draft.date_warning ? <p className="text-sm text-danger">Ngày về của đơn trước ngày đi, kiểm lại</p> : null}
            <OrderLink orderId={draft.order_id} />
          </div>
          <IntercomProjectForm
            key={draft.order_id}
            initialValues={{
              name: draft.name,
              startDate: draft.start_date ?? undefined,
              dayCount: draft.day_count,
            }}
            locked={createdProjectId !== null}
            cancelLabel={createdProjectId ? "Đóng" : "Huỷ"}
            submitLabel={createdProjectId ? "Thử lại" : "Tạo dự án"}
            onCancel={() => void requestClose()}
            onStateChange={reportFormState}
            onSubmit={submit}
            storage={{
              value: storage,
              initial: null,
              onChange: setStorage,
              required: true,
              // Chỉ quản lý mở được màn này nên có "Thêm Drive".
              options: storageChoiceOptions({ showDrive: true, isManager: true, accounts: driveAccounts }),
            }}
            extraFields={
              <MemberChips
                members={members}
                skippedNames={skippedNames}
                onChange={(next) => {
                  setMembers(next);
                  setMembersDirty(true);
                }}
              />
            }
          />
        </div>
      ) : null}
      {dialog}
    </Modal>
  );
}

function OrderLink({ orderId }: { orderId: string }) {
  const href = orderUrl(orderId);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex min-h-11 items-center gap-1.5 text-sm text-fg underline active:bg-surface-2"
    >
      Mở đơn
      <ExternalLink className="size-4 shrink-0" aria-hidden />
    </a>
  );
}

function OrderPicker({ onPicked }: { onPicked: (draft: IntercomOrderDraft) => void }) {
  const [search, setSearch] = useState("");
  const [orders, setOrders] = useState<IntercomOrderCandidate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openingOrderId, setOpeningOrderId] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const timer = window.setTimeout(() => {
      listIntercomOrderCandidates(search.trim())
        .then((list) => {
          if (!alive) return;
          setOrders(list);
          setLoadError(null);
        })
        .catch((e: unknown) => {
          if (alive) setLoadError(e instanceof Error ? e.message : "Chưa tải được danh sách đơn.");
        });
    }, SEARCH_DELAY_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [search]);

  const pick = async (order: IntercomOrderCandidate) => {
    setOpeningOrderId(order.order_id);
    setPickError(null);
    try {
      const draft = await getIntercomOrderDraft(order.order_id);
      // Người khác có thể vừa nối đơn này sau lúc tải danh sách.
      if (draft.linked_project_id) {
        setPickError(`Đơn đã nối dự án ${draft.linked_project_name ?? ""}`.trim());
        return;
      }
      onPicked(draft);
    } catch (e) {
      setPickError(e instanceof Error ? e.message : "Chưa đọc được đơn.");
    } finally {
      setOpeningOrderId(null);
    }
  };

  return (
    <>
      <label className="relative flex items-center">
        <Search className="pointer-events-none absolute left-3 size-4 text-muted" aria-hidden />
        <input
          type="search"
          defaultValue=""
          onInput={(e) => setSearch(e.currentTarget.value)}
          placeholder="Tìm mã đơn, mã khách, tên khách"
          aria-label="Tìm đơn"
          autoComplete="off"
          className="h-12 w-full rounded-control border border-border bg-surface pl-9 pr-3 text-base text-fg"
        />
      </label>

      {loadError ? <p className="text-base text-danger">{loadError}</p> : null}
      {pickError ? <p className="text-base text-danger">{pickError}</p> : null}
      {!orders && !loadError ? <p className="text-base text-muted">Đang tải...</p> : null}
      {orders && orders.length === 0 ? <p className="text-base text-muted">Không có đơn intercom còn hạn khớp tìm kiếm.</p> : null}

      {orders && orders.length > 0 ? (
        <ul className="space-y-2">
          {orders.map((order) => {
            const linked = order.linked_project_id !== null;
            return (
              <li key={order.order_id} className="rounded-card border border-border bg-surface">
                <button
                  type="button"
                  disabled={linked || openingOrderId !== null}
                  onClick={() => void pick(order)}
                  className="block min-h-16 w-full p-3 text-left active:bg-surface-2 disabled:opacity-60"
                >
                  <span className="block truncate text-base font-semibold text-fg">
                    {order.display_code}
                    {openingOrderId === order.order_id ? <span className="font-normal text-muted"> · Đang mở...</span> : null}
                  </span>
                  <span className="block text-sm text-muted">{orderDateRange(order.start_date, order.end_date)}</span>
                  <span className="block truncate text-sm text-muted">{customerLabel(order.customer_code, order.customer_name)}</span>
                  <span className="block text-sm text-muted">{order.unit_count === null ? "Chưa rõ số tai" : `${order.unit_count} tai`}</span>
                  {linked ? <span className="block truncate text-sm font-semibold text-fg">Đã nối {order.linked_project_name ?? ""}</span> : null}
                </button>
                <div className="border-t border-border px-3">
                  <OrderLink orderId={order.order_id} />
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}

function MemberChips({
  members,
  skippedNames,
  onChange,
}: {
  members: SelectedMember[];
  skippedNames: string[];
  onChange: (next: SelectedMember[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const selectedIds = new Set(members.map((m) => m.profile_id));

  const toggle = (candidate: IntercomMemberCandidate) => {
    onChange(
      selectedIds.has(candidate.profile_id)
        ? members.filter((m) => m.profile_id !== candidate.profile_id)
        : [...members, { profile_id: candidate.profile_id, name: candidate.name, has_login: candidate.has_login }],
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-base text-fg">Thành viên ({members.length})</p>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          aria-expanded={adding}
          className="flex h-11 items-center gap-1.5 rounded-control border border-border bg-surface px-3 text-base text-fg active:bg-surface-2"
        >
          <Plus className="size-4" aria-hidden />
          Thêm
        </button>
      </div>

      {members.length === 0 ? <p className="text-sm text-muted">Chưa chọn ai. Người tạo dự án tự là thành viên.</p> : null}
      {members.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {members.map((m) => (
            <li key={m.profile_id} className="flex min-h-11 max-w-full items-center rounded-full border border-border bg-surface-2 pl-3">
              <span className="min-w-0">
                <span className="block truncate text-base text-fg">{m.name}</span>
                {!m.has_login ? <span className="block truncate text-sm text-muted">{NO_LOGIN_LABEL}</span> : null}
              </span>
              <button
                type="button"
                onClick={() => onChange(members.filter((x) => x.profile_id !== m.profile_id))}
                aria-label={`Bỏ ${m.name}`}
                className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface"
              >
                <X className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {skippedNames.length > 0 ? (
        <p className="text-sm text-muted">Không thêm được (không phải nhân viên, cộng tác viên): {skippedNames.join(", ")}</p>
      ) : null}

      {adding ? <MemberSearch selectedIds={selectedIds} onToggle={toggle} /> : null}
    </div>
  );
}

function MemberSearch({
  selectedIds,
  onToggle,
}: {
  selectedIds: ReadonlySet<string>;
  onToggle: (candidate: IntercomMemberCandidate) => void;
}) {
  const [search, setSearch] = useState("");
  const [candidates, setCandidates] = useState<IntercomMemberCandidate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const timer = window.setTimeout(() => {
      searchIntercomMemberCandidates(search.trim())
        .then((list) => {
          if (!alive) return;
          setCandidates(list);
          setLoadError(null);
        })
        .catch((e: unknown) => {
          if (alive) setLoadError(e instanceof Error ? e.message : "Chưa tìm được người.");
        });
    }, SEARCH_DELAY_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [search]);

  return (
    // Khối này nằm trong form dự án: Enter ở ô tìm và ô tích không được tạo dự án.
    <div
      className="space-y-2 rounded-control border border-border p-2"
      onKeyDown={(e) => {
        if (e.key === "Enter") e.preventDefault();
      }}
    >
      <label className="relative flex items-center">
        <Search className="pointer-events-none absolute left-3 size-4 text-muted" aria-hidden />
        <input
          type="search"
          defaultValue=""
          onInput={(e) => setSearch(e.currentTarget.value)}
          placeholder="Tìm tên"
          aria-label="Tìm người để thêm"
          autoComplete="off"
          className="h-12 w-full rounded-control border border-border bg-surface pl-9 pr-3 text-base text-fg"
        />
      </label>
      {loadError ? <p className="text-base text-danger">{loadError}</p> : null}
      {!candidates && !loadError ? <p className="text-base text-muted">Đang tải...</p> : null}
      {candidates && candidates.length === 0 ? <p className="text-base text-muted">Không có người khớp tìm kiếm.</p> : null}
      {candidates && candidates.length > 0 ? (
        <ul className="max-h-56 divide-y divide-border overflow-y-auto">
          {candidates.map((c) => (
            <li key={c.profile_id}>
              <label className="flex min-h-11 items-center gap-3 py-2 active:bg-surface-2">
                <input
                  type="checkbox"
                  checked={selectedIds.has(c.profile_id)}
                  onChange={() => onToggle(c)}
                  className="size-5 shrink-0"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base text-fg">{c.name}</span>
                  {!c.has_login ? <span className="block text-sm text-muted">{NO_LOGIN_LABEL}</span> : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
