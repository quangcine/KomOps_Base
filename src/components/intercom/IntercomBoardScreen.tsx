"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  canDeleteIntercomHandover,
  getIntercomBoard,
  intercomPhotoUrl,
  type IntercomBoard,
} from "@/lib/intercom/staffIntercom";
import { IntercomBoardTable, IntercomDateSelect } from "./IntercomBoardTable";
import { useIntercomProject } from "./useIntercomProject";

const REFRESH_MS = 15000;

export function IntercomBoardScreen() {
  const { projects, projectId, selectProject, error: projectError } = useIntercomProject();
  const router = useRouter();
  const [board, setBoard] = useState<IntercomBoard | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Màn chụp luôn ở `/intercom`.
  const captureHref = "/intercom";
  // Ô chọn ngày ở hàng tên dự án; đổi dự án thì về Mọi ngày.
  const [dateFilter, setDateFilter] = useState<string | null>(null);
  // Máy chủ vẫn tự chặn bằng `intercom_can_delete()` trong `intercom_handover_delete`.
  const [canDelete, setCanDelete] = useState(false);

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

  // Lời đáp `getIntercomBoard` có thể về sai thứ tự: bỏ lời của dự án khác và lời cũ hơn lời đã nhận. Không so `seq`
  // với lượt mới nhất: lời đáp lâu hơn `REFRESH_MS` sẽ bị nhịp sau huỷ mãi, màn kẹt ở Đang tải.
  const activeProjectRef = useRef(projectId);
  activeProjectRef.current = projectId;
  const reloadSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);

  const reload = useCallback(async () => {
    if (!projectId) return;
    const seq = ++reloadSeqRef.current;
    try {
      const next = await getIntercomBoard(projectId);
      if (projectId !== activeProjectRef.current || seq < appliedSeqRef.current) return;
      appliedSeqRef.current = seq;
      setBoard(next);
      setLoadError(null);
    } catch (e) {
      if (projectId !== activeProjectRef.current || seq < appliedSeqRef.current) return;
      appliedSeqRef.current = seq;
      setLoadError(e instanceof Error ? e.message : "Chưa tải được dashboard.");
    }
  }, [projectId]);

  useEffect(() => {
    setBoard(null);
    setDateFilter(null);
    void reload();
    const timer = window.setInterval(() => void reload(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  if (projectError) return <p className="py-6 text-base text-danger">{projectError}</p>;
  if (!projects) return <p className="py-6 text-base text-muted">Đang tải...</p>;
  if (projects.length === 0) return <p className="py-6 text-base text-fg">Bạn chưa là thành viên dự án nào, nhờ quản lý thêm.</p>;

  return (
    // Bỏ nút "Làm mới" (tự làm mới 15 giây, hoặc kéo xuống tải lại trang).
    <div className="mx-auto w-full max-w-shell space-y-3">
      <div className="flex items-center gap-2">
        <select
          value={projectId ?? ""}
          onChange={(e) => selectProject(e.target.value)}
          className="h-11 min-w-0 flex-1 rounded-control border border-border bg-surface px-3 text-base font-semibold text-fg"
          aria-label="Dự án"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {board ? <IntercomDateSelect project={board.project} value={dateFilter} onChange={setDateFilter} /> : null}
      </div>

      {loadError ? <p className="text-base text-danger">{loadError}</p> : null}

      {board ? (
        <>
          <IntercomBoardTable
            board={board}
            photoUrl={intercomPhotoUrl}
            onPersonFilled={reload}
            onUnitsAdded={reload}
            onHandoverDeleted={canDelete ? reload : undefined}
            openOnlyByDefault
            fallbackView="list"
            onCollectAgain={(handoverId) =>
              // Màn chụp đọc `project`, `collect`, mở chế độ Thu về điền sẵn người và các tai còn ngoài.
              router.push(
                `${captureHref}?project=${encodeURIComponent(board.project.id)}&collect=${encodeURIComponent(handoverId)}`,
              )
            }
            dateFilter={dateFilter}
          />
        </>
      ) : loadError ? null : (
        <p className="py-6 text-base text-muted">Đang tải...</p>
      )}
    </div>
  );
}
