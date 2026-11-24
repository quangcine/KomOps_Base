"use client";

// Nút chép link đặt ngay sau tên ở đầu bản ghi. Nút icon 40 (`IconButton`), `aria-label` và `title` "Chép link
// <label>"; chép xong đổi icon `Check` 1,8 giây. Không có clipboard (trang không an toàn, trình duyệt chặn) thì
// `window.prompt` để người dùng tự chép.

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { IconButton } from "@/components/ui/Control";

const COPIED_MS = 1800;

export function RecordCopyLink({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      window.prompt("Chép link này:", url);
    }
  }, [url]);

  return (
    <IconButton
      variant="ghost"
      label={`Chép link ${label}`}
      icon={
        copied ? <Check className="size-4 text-success" aria-hidden /> : <Copy className="size-4" aria-hidden />
      }
      onClick={() => void copy()}
    />
  );
}
