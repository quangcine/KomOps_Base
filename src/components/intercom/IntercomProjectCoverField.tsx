"use client";

// Ô ảnh dự án ở form sửa, cắm qua `extraFields`. Nằm trong `<form>` nên mọi nút `type="button"`. Tải là lưu ngay,
// độc lập nút Lưu, không vào `dirty`. `board.project` không có `cover_key` nên ô này tự đọc khoá.

import { useEffect, useRef, useState } from "react";
import { getIntercomProjectCoverKey } from "@/lib/intercom/staffIntercomProject";
import { useConfirm } from "@/components/ui/useConfirm";
import { removeProjectCover, uploadProjectCover } from "./intercomCoverUpload";
import { IntercomProjectThumb } from "./IntercomProjectThumb";

const BUTTON_CLASS =
  "h-11 whitespace-nowrap rounded-control border border-border bg-surface px-3 text-base text-fg active:bg-surface-2 disabled:opacity-50";

type CoverAction = "upload" | "remove";

export function IntercomProjectCoverField({ projectId }: { projectId: string }) {
  const [coverKey, setCoverKey] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [action, setAction] = useState<CoverAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { ask, dialog } = useConfirm();

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    getIntercomProjectCoverKey(projectId)
      .then((key) => {
        if (!alive) return;
        setCoverKey(key);
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : "Chưa đọc được ảnh dự án.");
      })
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  const upload = async (file: File) => {
    setError(null);
    setAction("upload");
    try {
      setCoverKey(await uploadProjectCover(projectId, file));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chưa lưu được ảnh, thử lại giúp tôi.");
    } finally {
      setAction(null);
    }
  };

  const remove = async () => {
    if (!(await ask({ content: "Gỡ ảnh của dự án này?", confirmLabel: "Gỡ ảnh", danger: true }))) return;
    setError(null);
    setAction("remove");
    try {
      await removeProjectCover(projectId);
      setCoverKey(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chưa gỡ được ảnh, thử lại giúp tôi.");
    } finally {
      setAction(null);
    }
  };

  const disabled = !loaded || action !== null;

  return (
    <div className="space-y-1 text-base text-fg">
      <p>Ảnh dự án</p>
      <div className="flex items-center gap-3">
        <IntercomProjectThumb projectId={projectId} coverKey={coverKey} />
        <div className="flex min-w-0 flex-wrap gap-2">
          <button type="button" disabled={disabled} onClick={() => inputRef.current?.click()} className={BUTTON_CLASS}>
            {coverKey ? "Thay ảnh" : "Tải ảnh"}
          </button>
          {coverKey ? (
            <button type="button" disabled={disabled} onClick={() => void remove()} className={BUTTON_CLASS}>
              Gỡ ảnh
            </button>
          ) : null}
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          // Xoá giá trị để chọn lại đúng tệp đó vẫn chạy.
          e.currentTarget.value = "";
          if (file) void upload(file);
        }}
      />
      {action === "upload" ? <p className="text-base text-muted" role="status">Đang tải...</p> : null}
      {action === "remove" ? <p className="text-base text-muted" role="status">Đang gỡ...</p> : null}
      {error ? <p className="text-base text-danger" role="alert">{error}</p> : null}
      {dialog}
    </div>
  );
}
