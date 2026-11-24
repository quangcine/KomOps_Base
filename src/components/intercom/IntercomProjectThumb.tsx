"use client";

// Ô ảnh 68 của dự án intercom. Chưa có ảnh hoặc ảnh lỗi: nền tối và thanh INTERCOM.

import { Headphones } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { staffCoverUrl } from "./intercomCoverKey";

const DEFAULT_BACKGROUND: CSSProperties = { backgroundImage: "linear-gradient(135deg, #2a2d33, #131417)" };

export function IntercomProjectThumb({ projectId, coverKey }: { projectId: string; coverKey?: string | null }) {
  const url = coverKey ? staffCoverUrl(projectId, coverKey, "thumb") : null;
  // Giữ theo đường dẫn, không theo cờ: thay ảnh mới thì tự thử tải lại.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  return (
    <span className="relative size-[68px] shrink-0 overflow-hidden rounded-control border border-border">
      {url && url !== failedUrl ? (
        <img
          src={url}
          alt=""
          width={68}
          height={68}
          loading="lazy"
          onError={() => setFailedUrl(url)}
          className="size-full object-cover"
        />
      ) : (
        <span className="flex size-full flex-col items-center justify-center gap-0.5" style={DEFAULT_BACKGROUND}>
          <Headphones className="size-5 text-white" aria-hidden />
          <span className="w-[41px] rounded-[2px] bg-[#c04a1a] py-0.5 text-center text-[6.75px] font-semibold leading-none text-white">
            INTERCOM
          </span>
        </span>
      )}
    </span>
  );
}
