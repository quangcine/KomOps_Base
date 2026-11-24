"use client";

// Chi tiết một dự án intercom, 5 khối gập (`IntercomAccordionBlock`): Thông tin dự án (tên, ngày bắt đầu, số ngày,
// số nhóm, ảnh; mở sẵn), Mã tai, Người, Kỹ thuật, Link. Dữ liệu qua `intercom_board` (DEFINER, kiểm thành viên;
// trả kèm `share_token` và `tag_note` từng mã). Khối Kỹ thuật là thành viên dự án: `IntercomMemberSection`; tự bỏ
// mình thì về danh sách dự án. Nơi lưu ảnh nằm cuối khối Thông tin: Lưu cập nhật thông tin rồi, nếu nơi lưu đổi,
// làm theo lựa chọn (`applyStorageChoice`).

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, Info } from "lucide-react";
import { canDeleteIntercomHandover, getIntercomBoard, type IntercomBoard } from "@/lib/intercom/staffIntercom";
import type { StorageChoice } from "@/lib/intercom/staffIntercomDrive";
import { updateIntercomProject } from "@/lib/intercom/staffIntercomProject";
import { IntercomAccordionBlock } from "./IntercomAccordionBlock";
import { IntercomMemberSection } from "./IntercomMemberSection";
import { IntercomPeopleBlock } from "./IntercomPeopleBlock";
import { IntercomProjectCoverField } from "./IntercomProjectCoverField";
import { IntercomProjectForm } from "./IntercomProjectForm";
import { IntercomShareBlock } from "./IntercomShareBlock";
import {
  IntercomStorageField,
  applyStorageChoice,
  currentStorageChoice,
  storageChoiceKey,
  storageChoiceOptions,
  useIntercomProjectStorage,
} from "./IntercomStorageField";
import { IntercomUnitSetBlock } from "./IntercomUnitSetBlock";

export function IntercomProjectDetailScreen({ projectId }: { projectId: string }) {
  const [board, setBoard] = useState<IntercomBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canDelete, setCanDelete] = useState(false);
  const router = useRouter();
  const { storage, isManager, accounts, reload: reloadStorage } = useIntercomProjectStorage(projectId);
  const initialStorage = useMemo(() => currentStorageChoice(storage), [storage]);
  const [storageChoice, setStorageChoice] = useState<StorageChoice | null>(null);

  // Nơi lưu đọc xong (hoặc đọc lại sau khi Lưu): ô về đúng nơi lưu hiện tại.
  useEffect(() => {
    setStorageChoice(initialStorage);
  }, [initialStorage]);

  const reload = useCallback(async () => {
    try {
      setBoard(await getIntercomBoard(projectId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chưa tải được dự án.");
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [projectId, reload]);

  useEffect(() => {
    let alive = true;
    void canDeleteIntercomHandover()
      .catch(() => false)
      .then((allowed) => {
        if (alive) setCanDelete(allowed);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-3">
      <div className="flex items-center gap-2">
        <Link
          href="/intercom/projects"
          aria-label="Về danh sách dự án"
          className="flex size-11 shrink-0 items-center justify-center rounded-control text-fg active:bg-surface-2"
        >
          <ChevronLeft className="size-5" aria-hidden />
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-card font-semibold text-fg">{board?.project.name ?? "Dự án"}</h1>
      </div>

      {error ? <p className="text-base text-danger">{error}</p> : null}
      {!board && !error ? <p className="py-6 text-base text-muted">Đang tải...</p> : null}

      {board ? (
        <>
          <IntercomAccordionBlock title="Thông tin dự án" icon={Info} defaultOpen>
            <IntercomProjectForm
              key={board.project.id}
              project={board.project}
              extraFields={
                <>
                  <IntercomProjectCoverField projectId={projectId} />
                  <IntercomStorageField projectId={projectId} storage={storage} isManager={isManager} />
                </>
              }
              storage={{
                value: storageChoice,
                initial: initialStorage,
                onChange: setStorageChoice,
                required: false,
                options: storageChoiceOptions({ showDrive: storage !== null, isManager, accounts, current: storage }),
                disabled: storage?.has_handover === true,
              }}
              submitLabel="Lưu"
              onSubmit={async (input, picked) => {
                await updateIntercomProject(projectId, input);
                await reload();
                if (picked && storageChoiceKey(picked) !== storageChoiceKey(initialStorage)) {
                  if ((await applyStorageChoice(projectId, picked)) === "navigated") return;
                  await reloadStorage();
                }
              }}
            />
          </IntercomAccordionBlock>
          <IntercomUnitSetBlock board={board} onChanged={reload} />
          <IntercomPeopleBlock board={board} storage={storage} canDelete={canDelete} onChanged={reload} />
          <IntercomMemberSection projectId={projectId} onSelfRemoved={() => router.push("/intercom/projects")} />
          <IntercomShareBlock board={board} onChanged={reload} usesDrive={storage?.storage_kind === "drive"} />
        </>
      ) : null}
    </div>
  );
}
