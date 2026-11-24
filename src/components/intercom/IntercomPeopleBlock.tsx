"use client";

// Khối Người của màn chi tiết dự án: danh sách tìm được (bỏ dấu), thêm, sửa, xoá (dùng lại
// `intercom_person_delete` qua route `DELETE /api/intercom/person/[id]`, chỉ người được xoá thấy nút). Người nạp
// từ Google Sheet: hàng nút theo nơi lưu và trạng thái Sheet (`Dán link` hoặc `Tạo mẫu`; `Link` cộng `Nạp` hoặc
// `Update`); `Thêm` một người là nút ở đầu khối. Khối không gác quản lý. Ô chữ không điều khiển (`defaultValue`
// cộng ref): bàn phím tiếng Việt iOS bỏ dấu bằng xoá lùi rồi chèn lại, ô `value` ghi đè.

import { useCallback, useEffect, useRef, useState } from "react";
import { Search, Users } from "lucide-react";
import {
  createIntercomPerson,
  deleteIntercomPerson,
  type IntercomBoard,
  type IntercomPerson,
} from "@/lib/intercom/staffIntercom";
import { listIntercomDriveAccountOptions, type IntercomProjectStorage } from "@/lib/intercom/staffIntercomDrive";
import {
  INTERCOM_NAME_MAX,
  INTERCOM_PHONE_ERROR,
  INTERCOM_PHONE_INPUT_MAX,
  IntercomPeopleSheetError,
  createIntercomPeopleSheetTemplate,
  getIntercomPeopleSheet,
  intercomNameKey,
  intercomPeopleSheetUrl,
  normalizeIntercomPhone,
  setIntercomPeopleSheetLink,
  updateIntercomPerson,
  type IntercomPeopleSheet,
} from "@/lib/intercom/staffIntercomProject";
import { Modal } from "@/components/ui/Modal";
import { RecordCopyLink } from "@/components/ui/RecordCopyLink";
import { useConfirm } from "@/components/ui/useConfirm";
import { IntercomAccordionBlock } from "./IntercomAccordionBlock";
import { IntercomDeletePersonDialog } from "./IntercomDeletePersonDialog";
import type { IntercomFormState } from "./IntercomProjectForm";
import { IntercomSheetPreviewDialog } from "./IntercomSheetPreviewDialog";
import { foldText, knownDepartments } from "./intercomView";

const FIELD_CLASS = "mt-1 h-12 w-full rounded-control border border-border bg-surface px-3 text-base text-fg";
const SECONDARY_BUTTON =
  "h-11 rounded-control border border-border bg-surface px-3 text-base text-fg active:bg-surface-2 disabled:opacity-50";
const PASTE_HINT = "Sheet phải để Bất kỳ ai có đường liên kết đều xem được. Cột theo thứ tự Tên, Bộ phận, Nhóm, Số điện thoại.";
const CANNOT_SHARE_TEXT = "Tài khoản Google này không cho mở link công khai. Mở Drive để chia sẻ tay.";

export function IntercomPeopleBlock({
  board,
  storage,
  canDelete,
  onChanged,
}: {
  board: IntercomBoard;
  storage: IntercomProjectStorage | null;
  canDelete: boolean;
  onChanged: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<IntercomPerson | "new" | null>(null);
  const [deleting, setDeleting] = useState<IntercomPerson | null>(null);
  const [sheet, setSheet] = useState<IntercomPeopleSheet | null>(null);
  const [sheetDialog, setSheetDialog] = useState<"paste" | "link" | "preview" | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  /**
   * Trạng thái form Thêm, Sửa người (form báo lên qua `onStateChange`): đóng popup khi còn chữ chưa lưu thì hỏi
   * trước.
   */
  const editorStateRef = useRef<IntercomFormState>({ dirty: false, busy: false });
  const { ask, dialog } = useConfirm();

  const closeEditor = () => {
    editorStateRef.current = { dirty: false, busy: false };
    setEditing(null);
  };

  const requestCloseEditor = async () => {
    const { dirty, busy } = editorStateRef.current;
    if (busy) return;
    if (dirty && !(await ask({ content: "Bỏ các thay đổi chưa lưu?", confirmLabel: "Bỏ thay đổi", danger: true }))) return;
    closeEditor();
  };

  const reportEditorState = useCallback((state: IntercomFormState) => {
    editorStateRef.current = state;
  }, []);

  const projectId = board.project.id;
  const reloadSheet = useCallback(async () => {
    try {
      setSheet(await getIntercomPeopleSheet(projectId));
    } catch {
      // Đọc lỗi: hàng nút như chưa có Sheet.
      setSheet(null);
    }
  }, [projectId]);

  useEffect(() => {
    void reloadSheet();
  }, [reloadSheet]);

  /** Dự án Drive đã nối xong (có tài khoản, thư mục): chưa có Sheet thì `Tạo mẫu` thay `Dán link`. */
  const driveReady = storage?.storage_kind === "drive" && Boolean(storage.account_id) && Boolean(storage.folder_id);

  const createTemplate = async () => {
    setSheetBusy(true);
    setNotice(null);
    try {
      const { share } = await createIntercomPeopleSheetTemplate(projectId);
      setNotice(
        share === "ok"
          ? "Đã tạo Sheet mẫu. Bấm Link để chép link gửi khách."
          : share === "cannot_share"
            ? CANNOT_SHARE_TEXT
            : "Đã tạo Sheet mẫu, chưa mở được quyền sửa cho khách. Thử lại sau.",
      );
      await reloadSheet();
    } catch (e) {
      setNotice(e instanceof Error && e.message ? e.message : "Chưa tạo được Sheet mẫu, thử lại giúp tôi.");
    } finally {
      setSheetBusy(false);
    }
  };

  const folded = foldText(query);
  const people = board.people.filter(
    (p) => folded === "" || foldText(`${p.full_name} ${p.department}`).includes(folded),
  );
  const departments = knownDepartments(board);
  const listId = `intercom-departments-${board.project.id}`;

  const confirmDelete = async () => {
    const person = deleting;
    if (!person) return;
    setDeleting(null);
    try {
      await deleteIntercomPerson(person.id);
      setNotice(`Đã xoá ${person.full_name}.`);
      await onChanged();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Chưa xoá được người này, thử lại giúp tôi.");
    }
  };

  return (
    <IntercomAccordionBlock title="Người" icon={Users} count={board.people.length} onAdd={() => setEditing("new")}>
      <div className="flex flex-wrap justify-end gap-2">
        {sheet ? (
          <>
            <button type="button" onClick={() => setSheetDialog("link")} className={SECONDARY_BUTTON}>
              Link
            </button>
            <button type="button" onClick={() => setSheetDialog("preview")} className={SECONDARY_BUTTON}>
              {sheet.loaded_at ? "Update" : "Nạp"}
            </button>
          </>
        ) : driveReady ? (
          <button type="button" disabled={sheetBusy} onClick={() => void createTemplate()} className={SECONDARY_BUTTON}>
            {sheetBusy ? "Đang tạo..." : "Tạo mẫu"}
          </button>
        ) : (
          <button type="button" onClick={() => setSheetDialog("paste")} className={SECONDARY_BUTTON}>
            Dán link
          </button>
        )}
      </div>

      {board.people.length > 0 ? (
        <label className="relative flex items-center">
          <Search className="pointer-events-none absolute left-3 size-4 text-muted" aria-hidden />
          <input
            type="search"
            defaultValue={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder="Tìm tên, bộ phận"
            aria-label="Tìm người"
            className="h-12 w-full rounded-control border border-border bg-surface pl-9 pr-3 text-base text-fg"
          />
        </label>
      ) : (
        <p className="text-base text-muted">Chưa có người nào.</p>
      )}

      {notice ? <p className="text-base text-muted">{notice}</p> : null}

      <ul className="divide-y divide-border">
        {people.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2 py-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base font-semibold text-fg">{p.full_name}</span>
              <span className="block text-sm text-muted">
                {p.department} · Nhóm {p.group_no}
              </span>
            </span>
            <button type="button" onClick={() => setEditing(p)} className={SECONDARY_BUTTON}>
              Sửa
            </button>
            {canDelete ? (
              <button
                type="button"
                onClick={() => setDeleting(p)}
                className="h-11 rounded-control border border-danger px-3 text-base text-danger active:bg-danger/10"
              >
                Xoá
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {board.people.length > 0 && people.length === 0 ? (
        <p className="text-base text-muted">Không có người khớp tìm kiếm.</p>
      ) : null}

      <datalist id={listId}>
        {departments.map((d) => (
          <option key={d} value={d} />
        ))}
      </datalist>

      <Modal
        open={editing !== null}
        onClose={() => void requestCloseEditor()}
        title={editing === "new" ? "Thêm người" : "Sửa người"}
        width="narrow"
      >
        {editing !== null ? (
          <PersonForm
            key={editing === "new" ? "new" : editing.id}
            person={editing === "new" ? null : editing}
            people={board.people}
            groupCount={board.project.group_count}
            departmentListId={listId}
            onCancel={() => void requestCloseEditor()}
            onStateChange={reportEditorState}
            onSave={async (input) => {
              if (editing === "new") {
                await createIntercomPerson({ projectId: board.project.id, ...input, phone: input.phone || null });
                setNotice(`Đã thêm ${input.fullName}.`);
              } else {
                await updateIntercomPerson({ personId: editing.id, ...input });
                setNotice(`Đã sửa ${input.fullName}.`);
              }
              closeEditor();
              await onChanged();
            }}
          />
        ) : null}
      </Modal>

      <IntercomSheetPreviewDialog
        open={sheetDialog === "preview"}
        projectId={projectId}
        groupCount={board.project.group_count}
        people={board.people}
        onClose={() => setSheetDialog(null)}
        onSaved={async () => {
          await Promise.all([onChanged(), reloadSheet()]);
        }}
      />
      <SheetLinkDialog
        open={sheetDialog === "link"}
        sheet={sheet}
        onClose={() => setSheetDialog(null)}
        onPasteOther={() => setSheetDialog("paste")}
      />
      <PasteLinkDialog
        open={sheetDialog === "paste"}
        projectId={projectId}
        hasSheet={sheet !== null}
        onClose={() => setSheetDialog(null)}
        onSaved={async () => {
          setSheetDialog(null);
          setNotice("Đã lưu link Sheet. Bấm Nạp để xem trước danh sách.");
          await reloadSheet();
        }}
      />

      {deleting ? (
        <IntercomDeletePersonDialog
          projectId={board.project.id}
          fullName={deleting.full_name}
          department={deleting.department}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
      {dialog}
    </IntercomAccordionBlock>
  );
}

function PersonForm({
  person,
  people,
  groupCount,
  departmentListId,
  onCancel,
  onStateChange,
  onSave,
}: {
  person: IntercomPerson | null;
  people: readonly IntercomPerson[];
  groupCount: number;
  departmentListId: string;
  onCancel: () => void;
  onStateChange: (state: IntercomFormState) => void;
  onSave: (input: { fullName: string; department: string; group: number; phone: string }) => Promise<void>;
}) {
  const nameRef = useRef<HTMLInputElement | null>(null);
  const departmentRef = useRef<HTMLInputElement | null>(null);
  const phoneRef = useRef<HTMLInputElement | null>(null);
  const initialGroup = Math.min(person?.group_no ?? 1, groupCount);
  const [group, setGroup] = useState(initialGroup);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [textDirty, setTextDirty] = useState(false);

  useEffect(() => {
    onStateChange({ dirty: textDirty || group !== initialGroup, busy });
  }, [textDirty, group, initialGroup, busy, onStateChange]);

  const checkTextDirty = () =>
    setTextDirty(
      (nameRef.current?.value ?? "") !== (person?.full_name ?? "") ||
        (departmentRef.current?.value ?? "") !== (person?.department ?? "") ||
        (phoneRef.current?.value ?? "") !== (person?.phone ?? ""),
    );

  const submit = async () => {
    const fullName = (nameRef.current?.value ?? "").trim().replace(/\s+/g, " ");
    const department = (departmentRef.current?.value ?? "").trim().replace(/\s+/g, " ");
    if (fullName === "") return setError("Chưa nhập tên.");
    if (fullName.length > INTERCOM_NAME_MAX) return setError(`Tên tối đa ${INTERCOM_NAME_MAX} ký tự.`);
    if (department === "") return setError("Chưa nhập bộ phận.");
    const phone = normalizeIntercomPhone(phoneRef.current?.value ?? "");
    if (phone === null) return setError(INTERCOM_PHONE_ERROR);
    // Cùng luật so tên của máy chủ: thêm mới mà trùng thì máy chủ lặng lẽ trả người sẵn có, nên chặn trước ở đây.
    const key = intercomNameKey(fullName);
    const clash = people.find((p) => p.id !== person?.id && intercomNameKey(p.full_name) === key);
    if (clash) return setError(`Đã có người tên ${clash.full_name} trong dự án.`);
    setError(null);
    setBusy(true);
    try {
      await onSave({ fullName, department, group, phone });
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Chưa lưu được, thử lại giúp tôi.");
    } finally {
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
        Tên
        <input
          ref={nameRef}
          defaultValue={person?.full_name ?? ""}
          onInput={checkTextDirty}
          maxLength={INTERCOM_NAME_MAX}
          autoComplete="off"
          className={FIELD_CLASS}
        />
      </label>
      <label className="block text-base text-fg">
        Bộ phận
        <input
          ref={departmentRef}
          defaultValue={person?.department ?? ""}
          onInput={checkTextDirty}
          list={departmentListId}
          autoComplete="off"
          className={FIELD_CLASS}
        />
      </label>
      <label className="block text-base text-fg">
        Nhóm
        <select value={group} onChange={(e) => setGroup(Number(e.target.value))} className={FIELD_CLASS}>
          {Array.from({ length: groupCount }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              Nhóm {n}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-base text-fg">
        Số điện thoại
        <input
          ref={phoneRef}
          type="tel"
          inputMode="tel"
          defaultValue={person?.phone ?? ""}
          onInput={checkTextDirty}
          maxLength={INTERCOM_PHONE_INPUT_MAX}
          autoComplete="off"
          placeholder="Số điện thoại (không bắt buộc)"
          className={FIELD_CLASS}
        />
      </label>
      {person ? (
        <p className="text-sm text-muted">Đổi bộ phận, nhóm thì các lượt giao, thu của người này đổi theo.</p>
      ) : null}
      {error ? <p className="text-base text-danger">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={SECONDARY_BUTTON}>
          Huỷ
        </button>
        <button
          type="submit"
          disabled={busy}
          className="h-11 rounded-control bg-brand-cta px-4 text-base font-semibold text-white active:bg-brand-cta-hover disabled:opacity-50"
        >
          {busy ? "Đang lưu..." : "Lưu"}
        </button>
      </div>
    </form>
  );
}

/**
 * Menu `Link`: `Copy link`, `Dán link khác`. File mẫu ghi file nằm trong Drive của ai; Sheet khách dán ghi app
 * chỉ đọc.
 */
function SheetLinkDialog({
  open,
  sheet,
  onClose,
  onPasteOther,
}: {
  open: boolean;
  sheet: IntercomPeopleSheet | null;
  onClose: () => void;
  onPasteOther: () => void;
}) {
  const [ownerEmail, setOwnerEmail] = useState<string | null | undefined>(undefined);
  const templateAccountId = sheet?.kind === "template" ? sheet.template_account_id : null;

  useEffect(() => {
    if (!open || !templateAccountId) return;
    let alive = true;
    setOwnerEmail(undefined);
    void listIntercomDriveAccountOptions()
      .then((accounts) => {
        if (alive) setOwnerEmail(accounts.find((a) => a.id === templateAccountId)?.google_email ?? null);
      })
      .catch(() => {
        if (alive) setOwnerEmail(undefined);
      });
    return () => {
      alive = false;
    };
  }, [open, templateAccountId]);

  if (!sheet) return null;
  const url = intercomPeopleSheetUrl(sheet);

  return (
    <Modal open={open} onClose={onClose} title="Link Sheet" width="narrow">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-11 min-w-0 items-center break-all text-sm text-fg underline active:bg-surface-2"
          >
            Mở Sheet
          </a>
          <span className="flex items-center gap-1 text-base text-fg">
            Copy link
            <RecordCopyLink url={url} label="link Sheet" />
          </span>
        </div>
        {sheet.kind === "template" && ownerEmail !== undefined ? (
          <p className="text-sm text-muted">
            {ownerEmail ? `File nằm trong Drive của ${ownerEmail}.` : "File nằm trong Drive của tài khoản đã mất quyền."}
          </p>
        ) : null}
        {sheet.kind === "link" ? (
          <p className="text-sm text-muted">Sheet này do khách giữ, app chỉ đọc; khoá sửa, xoá theo dự án không áp.</p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
            Đóng
          </button>
          <button type="button" onClick={onPasteOther} className={SECONDARY_BUTTON}>
            Dán link khác
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Hộp `Dán link`, `Dán link khác`: một ô URL. Ô không điều khiển (`defaultValue` cộng ref), như các ô chữ khác
 * của khối.
 */
function PasteLinkDialog({
  open,
  projectId,
  hasSheet,
  onClose,
  onSaved,
}: {
  open: boolean;
  projectId: string;
  hasSheet: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const urlRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const submit = async () => {
    const url = (urlRef.current?.value ?? "").trim();
    if (url === "") return setError("Chưa dán link.");
    setBusy(true);
    setError(null);
    try {
      await setIntercomPeopleSheetLink(projectId, url);
      await onSaved();
    } catch (e) {
      setError(
        e instanceof IntercomPeopleSheetError && e.reason === "not_public"
          ? "Sheet chưa mở Bất kỳ ai có đường liên kết. Mở chia sẻ rồi dán lại."
          : e instanceof Error && e.message
            ? e.message
            : "Chưa lưu được link Sheet, thử lại giúp tôi.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={() => (busy ? undefined : onClose())} title={hasSheet ? "Dán link khác" : "Dán link"} width="narrow">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="block text-base text-fg">
          Link Google Sheet
          <input
            ref={urlRef}
            type="url"
            inputMode="url"
            defaultValue=""
            autoComplete="off"
            placeholder="https://docs.google.com/spreadsheets/d/..."
            className={FIELD_CLASS}
          />
        </label>
        <p className="text-sm text-muted">{PASTE_HINT}</p>
        {error ? <p className="text-base text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className={SECONDARY_BUTTON}>
            Huỷ
          </button>
          <button
            type="submit"
            disabled={busy}
            className="h-11 rounded-control bg-brand-cta px-4 text-base font-semibold text-white active:bg-brand-cta-hover disabled:opacity-50"
          >
            {busy ? "Đang đọc thử..." : "Lưu"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
