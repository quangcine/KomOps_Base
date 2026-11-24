"use client";

// Nơi lưu ảnh của dự án ở khối Thông tin dự án.
// - `useIntercomProjectStorage`: đọc `intercom_project_storage`, quyền quản lý, tài khoản để chọn.
// - `IntercomStorageField`: phần chỉ đọc đặt trong `extraFields` của form: câu `drive_notice`, Tài khoản, Thư mục,
// câu đỏ mất quyền, "Nối lại" (chỉ quản lý), câu khoá sau lượt đầu. Ô chọn nơi lưu do `IntercomProjectForm`
// vẽ (prop `storage`).
// - `storageChoiceOptions`, `applyStorageChoice`: mục của ô chọn và việc làm sau khi chọn (dùng chung cho form
// Tạo, Tạo từ đơn, Thông tin).

import { useCallback, useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { getIntercomAccess } from "@/lib/intercom/staffIntercom";
import {
  chooseIntercomDriveAccount,
  getIntercomProjectStorage,
  intercomDriveConnectUrl,
  listIntercomDriveAccountOptions,
  setIntercomProjectStorageR2,
  type IntercomDriveAccountOption,
  type IntercomProjectStorage,
  type StorageChoice,
} from "@/lib/intercom/staffIntercomDrive";
import { RecordCopyLink } from "@/components/ui/RecordCopyLink";

/**
 * Mã `drive_notice` do `drive/connect`, `drive/callback`, form Tạo gắn lên đường về. Mã lạ thì bỏ qua, không in
 * chữ từ URL.
 */
const CONNECT_NOTICES: Record<string, string> = {
  connected: "Đã nối tài khoản Google.",
  cancelled: "Chưa nối: màn Google đã bị huỷ.",
  state: "Phiên nối đã hết hạn, bấm nối lại giúp tôi.",
  forbidden: "Chỉ quản lý intercom nối được tài khoản Google.",
  scope: "Chưa tick quyền Google Drive nên chưa nối được.",
  no_refresh: "Google không trả chìa dài hạn nên chưa lưu, bấm nối lại giúp tôi.",
  identity: "Google không trả đủ thông tin tài khoản nên chưa lưu.",
  exchange: "Chưa đổi được mã với Google, thử lại giúp tôi.",
  save: "Chưa lưu được tài khoản, thử lại giúp tôi.",
  config: "Drive chưa cấu hình xong.",
  attach_failed: "Đã nối tài khoản Google nhưng chưa gắn được vào dự án. Chọn lại nơi lưu ở Thông tin dự án.",
  folder_failed: "Đã tạo dự án, chưa tạo được thư mục Drive. Chọn lại nơi lưu ở Thông tin dự án.",
};

const DRIVE_FOLDER_URL = "https://drive.google.com/drive/folders/";
const SECONDARY_CLASS =
  "flex h-11 w-fit items-center rounded-control border border-border bg-surface px-3 text-base text-fg active:bg-surface-2";

/** Một mục của ô nơi lưu. */
export type StorageOption = { choice: StorageChoice; label: string };

/** Khoá chuỗi của một lựa chọn, làm `value` của thẻ `option`. */
export function storageChoiceKey(choice: StorageChoice | null): string {
  if (!choice) return "";
  return choice.kind === "drive" ? `drive:${choice.accountId}` : choice.kind;
}

/**
 * Nơi lưu đang có của dự án, dạng lựa chọn. Dự án `drive` chưa nối xong là `null`, để ô hiện chỗ trống và chọn
 * lại đúng tài khoản cũ vẫn gọi `drive/folder`.
 */
export function currentStorageChoice(storage: IntercomProjectStorage | null): StorageChoice | null {
  if (!storage) return null;
  if (storage.storage_kind === "r2") return { kind: "r2" };
  return storage.account_id && storage.folder_id ? { kind: "drive", accountId: storage.account_id } : null;
}

/** Chỗ trống do form vẽ. Tài khoản đang gắn đã mất quyền vẫn có một mục để ô hiện đúng nơi lưu hiện tại. */
export function storageChoiceOptions(input: {
  showDrive: boolean;
  isManager: boolean;
  accounts: readonly IntercomDriveAccountOption[];
  current?: IntercomProjectStorage | null;
}): StorageOption[] {
  const options: StorageOption[] = [];
  if (input.showDrive) {
    if (input.isManager) options.push({ choice: { kind: "drive_new" }, label: "Thêm Drive" });
    for (const account of input.accounts) options.push({ choice: { kind: "drive", accountId: account.id }, label: account.google_email });
  }
  const current = input.current;
  // Cùng điều kiện `currentStorageChoice`: chỉ thêm mục "(mất quyền)" khi đó là nơi lưu đã nối xong; thiếu thư mục
  // thì ô để trống.
  if (
    current?.storage_kind === "drive" &&
    current.account_id &&
    current.folder_id &&
    !input.accounts.some((a) => a.id === current.account_id)
  ) {
    options.push({
      choice: { kind: "drive", accountId: current.account_id },
      label: current.google_email ? `${current.google_email} (mất quyền)` : "Tài khoản Google đã mất quyền",
    });
  }
  options.push({ choice: { kind: "r2" }, label: "Kho R2" });
  return options;
}

/**
 * Làm theo nơi lưu đã chọn cho một dự án đã có: `r2` gọi `set_storage`; tài khoản có sẵn gọi route
 * `drive/folder` (tạo thư mục, gắn); `drive_new` chuyển cả trang sang nối Google kèm `attach` (trả
 * `"navigated"`). Lỗi thì ném câu máy chủ trả.
 */
export async function applyStorageChoice(projectId: string, choice: StorageChoice): Promise<"done" | "navigated"> {
  if (choice.kind === "drive_new") {
    window.location.assign(intercomDriveConnectUrl(projectId, { attach: true }));
    return "navigated";
  }
  if (choice.kind === "drive") await chooseIntercomDriveAccount(projectId, choice.accountId);
  else await setIntercomProjectStorageR2(projectId);
  return "done";
}

/**
 * Sau khi TẠO dự án: dự án đã mang nơi lưu từ `intercom_project_create`; tài khoản có sẵn thì tạo thư mục, lỗi
 * thì vẫn vào màn dự án kèm câu báo (`?drive_notice=folder_failed`); "Thêm Drive" thì chuyển sang nối Google.
 * Trả đường dẫn màn dự án, hoặc `null` khi đã chuyển trang.
 */
export async function finishCreatedStorage(projectId: string, choice: StorageChoice): Promise<string | null> {
  const path = `/intercom/projects/${projectId}`;
  if (choice.kind === "r2") return path;
  if (choice.kind === "drive_new") {
    window.location.assign(intercomDriveConnectUrl(projectId, { attach: true }));
    return null;
  }
  try {
    await chooseIntercomDriveAccount(projectId, choice.accountId);
    return path;
  } catch {
    return `${path}?drive_notice=folder_failed`;
  }
}

export type IntercomProjectStorageState = {
  storage: IntercomProjectStorage | null;
  isManager: boolean;
  accounts: IntercomDriveAccountOption[];
  reload: () => Promise<void>;
};

/** Đọc nơi lưu cho khối Thông tin, kèm tài khoản Drive để chọn. */
export function useIntercomProjectStorage(projectId: string): IntercomProjectStorageState {
  const [storage, setStorage] = useState<IntercomProjectStorage | null>(null);
  const [isManager, setIsManager] = useState(false);
  const [accounts, setAccounts] = useState<IntercomDriveAccountOption[]>([]);

  const reload = useCallback(async () => {
    try {
      const [nextStorage, access] = await Promise.all([
        getIntercomProjectStorage(projectId),
        getIntercomAccess().catch(() => ({ is_manager: false })),
      ]);
      setIsManager(access.is_manager);
      setStorage(nextStorage);
      setAccounts(nextStorage ? await listIntercomDriveAccountOptions().catch(() => []) : []);
    } catch {
      setStorage(null);
      setAccounts([]);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { storage, isManager, accounts, reload };
}

/** Phần chỉ đọc của nơi lưu, đặt trong `extraFields` của form Thông tin dự án. */
export function IntercomStorageField({
  projectId,
  storage,
  isManager,
}: {
  projectId: string;
  storage: IntercomProjectStorage | null;
  isManager: boolean;
}) {
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("drive_notice");
    if (code === null) return;
    setNotice(CONNECT_NOTICES[code] ?? null);
    params.delete("drive_notice");
    const rest = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
  }, []);

  const usesDrive = storage?.storage_kind === "drive";
  const folderUrl = storage?.folder_id ? `${DRIVE_FOLDER_URL}${encodeURIComponent(storage.folder_id)}` : null;
  const isRevoked = storage?.account_status === "revoked";
  const notConnected = usesDrive && !storage?.folder_id;

  if (!storage && !notice) return null;

  return (
    <div className="space-y-1 text-base text-fg">
      {notice ? (
        <p role="status" className="text-sm text-muted">
          {notice}
        </p>
      ) : null}
      {usesDrive && storage?.google_email ? (
        <div className="flex justify-between gap-2">
          <span className="shrink-0">Tài khoản</span>
          <span className="min-w-0 break-all text-right">{storage.google_email}</span>
        </div>
      ) : null}
      {folderUrl ? (
        <div className="flex items-center justify-between gap-2 text-sm text-muted">
          <span className="shrink-0">Thư mục</span>
          <span className="flex min-w-0 items-center gap-1">
            <a
              href={folderUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-11 items-center gap-1.5 text-sm text-fg underline active:bg-surface-2"
            >
              Mở trên Drive
              <ExternalLink className="size-4 shrink-0" aria-hidden />
            </a>
            <RecordCopyLink url={folderUrl} label="thư mục Drive" />
          </span>
        </div>
      ) : null}
      {notConnected ? <p className="text-sm text-danger">Dự án chưa nối xong Google Drive.</p> : null}
      {isRevoked ? <p className="text-danger">Drive mất quyền, ảnh mới lưu tạm R2. Nối lại để chuyển.</p> : null}
      {isRevoked && isManager ? (
        <a href={intercomDriveConnectUrl(projectId)} className={SECONDARY_CLASS}>
          Nối lại
        </a>
      ) : null}
      {storage?.has_handover ? <p className="text-sm text-muted">Không đổi được sau lượt đầu.</p> : null}
    </div>
  );
}
