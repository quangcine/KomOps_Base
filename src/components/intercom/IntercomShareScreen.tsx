"use client";

// Trang khách `/ic/<mã>`: cùng bảng dashboard, chỉ xem; không khối link, không nút sang màn chụp. Dữ liệu qua
// `intercom_share_board` bằng client không phiên; ảnh qua route khách. Mã sai, đã thu hồi: một dòng.

import { useCallback, useEffect, useState } from "react";
import { getIntercomShareBoard, intercomSharePhotoUrl, type IntercomBoard } from "@/lib/intercom/staffIntercom";
import { WorkLogo } from "@/components/ui/WorkLogo";
import { IntercomBoardTable, IntercomDateSelect } from "./IntercomBoardTable";

type LoadState = { kind: "loading" } | { kind: "invalid" } | { kind: "error" } | { kind: "ready"; board: IntercomBoard };

export function IntercomShareScreen({ token }: { token: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  // Ô chọn ngày ở hàng tên dự án, góc phải.
  const [dateFilter, setDateFilter] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getIntercomShareBoard(token)
      .then((board) => {
        if (!cancelled) setState(board ? { kind: "ready", board } : { kind: "invalid" });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const photoUrl = useCallback(
    (handoverId: string, size: "thumb" | "full") => intercomSharePhotoUrl(token, handoverId, size),
    [token],
  );

  if (state.kind === "loading") {
    return <p className="px-4 py-8 text-base text-muted">Đang tải...</p>;
  }
  if (state.kind === "invalid") {
    return <p className="px-4 py-8 text-base text-fg">Link không còn hiệu lực.</p>;
  }
  if (state.kind === "error") {
    return <p className="px-4 py-8 text-base text-fg">Chưa tải được dữ liệu, tải lại trang giúp tôi.</p>;
  }
  return (
    <main className="mx-auto w-full max-w-shell space-y-3 px-3 py-4">
      <WorkLogo />
      <div className="flex items-center gap-2">
        <h1 className="min-w-0 flex-1 break-words text-title font-semibold text-fg">{state.board.project.name}</h1>
        <IntercomDateSelect project={state.board.project} value={dateFilter} onChange={setDateFilter} />
      </div>
      <IntercomBoardTable board={state.board} photoUrl={photoUrl} dateFilter={dateFilter} openOnlyByDefault ownerPhotos />
    </main>
  );
}
