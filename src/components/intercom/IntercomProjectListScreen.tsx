"use client";

// Tạo xong thì chọn luôn dự án đó (`storeProjectId`) để Home, Giao mở đúng, rồi mở màn chi tiết. Nút Tạo từ đơn
// chỉ hiện với quản lý; máy chủ vẫn tự chặn người khác.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, Plus } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { getIntercomAccess } from "@/lib/intercom/staffIntercom";
import {
  listIntercomDriveAccountOptions,
  type IntercomDriveAccountOption,
  type StorageChoice,
} from "@/lib/intercom/staffIntercomDrive";
import {
  createIntercomProject,
  listIntercomProjectSummaries,
  type IntercomProjectSummary,
} from "@/lib/intercom/staffIntercomProject";
import { useConfirm } from "@/components/ui/useConfirm";
import { IntercomOrderPickerSheet } from "./IntercomOrderPickerSheet";
import { IntercomProjectForm, type IntercomFormState } from "./IntercomProjectForm";
import { IntercomProjectThumb } from "./IntercomProjectThumb";
import { finishCreatedStorage, storageChoiceOptions } from "./IntercomStorageField";
import { shortDate, storeProjectId } from "./intercomView";

export function IntercomProjectListScreen() {
  const router = useRouter();
  const [projects, setProjects] = useState<IntercomProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [isManager, setIsManager] = useState(false);
  const [creatingFromOrder, setCreatingFromOrder] = useState(false);
  const [createStorage, setCreateStorage] = useState<StorageChoice | null>(null);
  const [driveAccounts, setDriveAccounts] = useState<IntercomDriveAccountOption[]>([]);
  const createStateRef = useRef<IntercomFormState>({ dirty: false, busy: false });
  const { ask, dialog } = useConfirm();

  const closeCreate = () => {
    createStateRef.current = { dirty: false, busy: false };
    setCreating(false);
    setCreateStorage(null);
  };

  const requestCloseCreate = async () => {
    const { dirty, busy } = createStateRef.current;
    if (busy) return;
    if (dirty && !(await ask({ content: "Bỏ các thay đổi chưa lưu?", confirmLabel: "Bỏ thay đổi", danger: true }))) return;
    closeCreate();
  };

  const reportCreateState = useCallback((state: IntercomFormState) => {
    createStateRef.current = state;
  }, []);

  const load = useCallback(async () => {
    try {
      setProjects(await listIntercomProjectSummaries());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chưa tải được danh sách dự án.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Lỗi đọc quyền thì để ẩn nút: lối Tạo dự án thường vẫn dùng được.
  useEffect(() => {
    let alive = true;
    getIntercomAccess()
      .then((access) => {
        if (alive) setIsManager(access.is_manager);
      })
      .catch(() => undefined);
    listIntercomDriveAccountOptions()
      .then((accounts) => {
        if (alive) setDriveAccounts(accounts);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-3">
      <div className="flex items-center gap-2">
        <h1 className="min-w-0 flex-1 text-card font-semibold text-fg">Dự án</h1>
        {isManager ? (
          <button
            type="button"
            onClick={() => setCreatingFromOrder(true)}
            className="h-11 whitespace-nowrap rounded-control border border-border bg-surface px-3 text-base text-fg active:bg-surface-2"
          >
            Tạo từ đơn
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex h-11 items-center gap-1.5 rounded-control bg-brand-cta px-3 text-base font-semibold text-white active:bg-brand-cta-hover"
        >
          <Plus className="size-4" aria-hidden />
          Tạo dự án
        </button>
      </div>

      {error ? <p className="text-base text-danger">{error}</p> : null}
      {!projects && !error ? <p className="py-6 text-base text-muted">Đang tải...</p> : null}
      {projects && projects.length === 0 ? <p className="py-6 text-base text-fg">Bạn chưa là thành viên dự án nào, nhờ quản lý thêm.</p> : null}

      {projects && projects.length > 0 ? (
        <ul className="space-y-2">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                href={`/intercom/projects/${p.id}`}
                className="flex min-h-16 items-center gap-3 rounded-card border border-border bg-surface p-3 active:bg-surface-2"
              >
                <IntercomProjectThumb projectId={p.id} coverKey={p.cover_key} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-block font-semibold text-fg">{p.name}</span>
                  <span className="block text-sm text-muted">
                    {shortDate(p.start_date)} tới {shortDate(p.end_date)} · {p.day_count} ngày · {p.group_count} nhóm
                  </span>
                  <span className="block text-sm text-muted">
                    {p.unit_count} tai · {p.person_count} người
                  </span>
                </span>
                <ChevronRight className="size-5 shrink-0 text-muted" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      <Modal open={creating} onClose={() => void requestCloseCreate()} title="Tạo dự án" width="narrow">
        <IntercomProjectForm
          submitLabel="Tạo dự án"
          onCancel={() => void requestCloseCreate()}
          onStateChange={reportCreateState}
          storage={{
            value: createStorage,
            initial: null,
            onChange: setCreateStorage,
            required: true,
            options: storageChoiceOptions({ showDrive: true, isManager, accounts: driveAccounts }),
          }}
          onSubmit={async (input, storage) => {
            if (!storage) throw new Error("Chọn nơi lưu ảnh.");
            const id = await createIntercomProject(input, storage);
            storeProjectId(id);
            closeCreate();
            const path = await finishCreatedStorage(id, storage);
            if (path) router.push(path);
          }}
        />
      </Modal>
      {creatingFromOrder ? (
        <IntercomOrderPickerSheet
          onClose={() => {
            setCreatingFromOrder(false);
            // Đóng khi dự án đã tạo mà chưa nối đơn thì danh sách phải hiện dự án đó.
            void load();
          }}
          onCreated={(_id, path) => {
            setCreatingFromOrder(false);
            router.push(path);
          }}
        />
      ) : null}
      {dialog}
    </div>
  );
}
