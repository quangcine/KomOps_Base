"use client";

// Khối Link khách của một dự án intercom: tạo, chép, thu hồi. Tách nguyên từ `IntercomBoardScreen.tsx` để màn Dự
// án dùng lại.

import { useState } from "react";
import { Copy, Link2 } from "lucide-react";
import {
  intercomShareUrl,
  revokeIntercomShare,
  rotateIntercomShare,
  type IntercomBoard,
} from "@/lib/intercom/staffIntercom";
import { applyIntercomDriveShare } from "@/lib/intercom/staffIntercomDrive";
import { useConfirm } from "@/components/ui/useConfirm";
import { IntercomAccordionBlock } from "./IntercomAccordionBlock";

/** Workspace cấm mở link công khai thư mục: link `/ic/` vẫn bật được. */
const CANNOT_SHARE_TEXT = "Tài khoản Google này không cho mở link công khai thư mục. Chia sẻ tay trên Drive.";

/** `usesDrive`: dự án lưu Google Drive: bật, thu hồi link thì đổi quyền thư mục Drive theo. */
export function IntercomShareBlock({
  board,
  onChanged,
  usesDrive = false,
}: {
  board: IntercomBoard;
  onChanged: () => Promise<void>;
  usesDrive?: boolean;
}) {
  const { ask, dialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const token = board.project.share_revoked_at ? null : (board.project.share_token ?? null);
  const url = token ? intercomShareUrl(token) : null;

  /** `work` trả câu thêm sau câu xong (hoặc không). */
  const run = async (work: () => Promise<string | null | void>, done: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const extra = await work();
      await onChanged();
      setNotice(extra ? `${done} ${extra}` : done);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Chưa làm được, thử lại giúp tôi.");
    } finally {
      setBusy(false);
    }
  };

  /** Hàm DB đã đặt quyền mong muốn; chạy ngay cho dự án này. Lỗi thì nhịp hẹn giờ làm lại, không báo. */
  const syncDriveShare = async (): Promise<string | null> => {
    if (!usesDrive) return null;
    return (await applyIntercomDriveShare(board.project.id)) === "cannot_share" ? CANNOT_SHARE_TEXT : null;
  };

  const create = async () => {
    if (token) {
      const ok = await ask({
        title: "Tạo link mới",
        content: "Link cũ sẽ hết hiệu lực. Tạo link mới?",
        confirmLabel: "Tạo link mới",
      });
      if (!ok) return;
    }
    await run(async () => {
      await rotateIntercomShare(board.project.id);
      return syncDriveShare();
    }, "Đã tạo link khách.");
  };

  const revoke = async () => {
    const ok = await ask({
      title: "Thu hồi link khách",
      content: "Người đang giữ link sẽ không xem được nữa.",
      confirmLabel: "Thu hồi",
      danger: true,
    });
    if (!ok) return;
    await run(async () => {
      await revokeIntercomShare(board.project.id);
      return syncDriveShare();
    }, "Đã thu hồi link khách.");
  };

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setNotice("Đã chép link.");
    } catch {
      setNotice("Máy chưa cho chép, giữ ngón tay lên link để chép.");
    }
  };

  return (
    <IntercomAccordionBlock title="Link" icon={Link2}>
      {url ? (
        <p className="select-all break-all rounded-control bg-surface-2 px-2 py-1.5 text-sm text-fg">{url}</p>
      ) : (
        <p className="text-base text-muted">Chưa có link khách.</p>
      )}
      <div className="flex flex-wrap gap-2">
        {url ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void copy()}
            className="flex h-11 items-center gap-1.5 rounded-control bg-brand-cta px-3 text-base font-semibold text-white active:bg-brand-cta-hover disabled:opacity-50"
          >
            <Copy className="size-4" aria-hidden />
            Chép link
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => void create()}
          className="h-11 rounded-control border border-border bg-surface px-3 text-base text-fg active:bg-surface-2 disabled:opacity-50"
        >
          {url ? "Tạo link mới" : "Tạo link"}
        </button>
        {url ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void revoke()}
            className="h-11 rounded-control border border-danger px-3 text-base text-danger active:bg-danger/10 disabled:opacity-50"
          >
            Thu hồi
          </button>
        ) : null}
      </div>
      {usesDrive ? (
        <p className="text-sm text-muted">
          Bật link thì thư mục Drive mở cho ai có link xem. Chia sẻ tay theo email trên Drive thì app không gỡ.
        </p>
      ) : null}
      {notice ? <p className="text-sm text-muted">{notice}</p> : null}
      {dialog}
    </IntercomAccordionBlock>
  );
}
