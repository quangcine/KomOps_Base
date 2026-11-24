"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";

// Một dòng trong danh sách chức năng của tab tài khoản. Ba kiểu dùng:
// · đi tới màn trong app → `href`
// · mở popup ngay tại chỗ → `onClick`
// · mở trang ngoài tab mới → `href` + `external`
export function FunctionRow({
  href,
  onClick,
  icon,
  label,
  external = false,
  tone = "default",
}: {
  href?: string;
  onClick?: () => void;
  icon: React.ReactNode;
  label: string;
  external?: boolean;
  /** `danger` cho việc rời tài khoản (đăng xuất), để mắt tách nó khỏi các dòng đi tới. */
  tone?: "default" | "danger";
}) {
  const iconClass = tone === "danger" ? "text-danger" : "text-muted";
  const labelClass = tone === "danger" ? "text-danger" : "text-fg";

  const content = (
    <>
      <span className={iconClass}>{icon}</span>
      <span className={`flex-1 text-body ${labelClass}`}>{label}</span>
      {/* Việc rời tài khoản không đi tới đâu cả nên không đeo mũi tên, kẻo đọc nhầm là còn màn nữa. */}
      {tone === "default" && <ChevronRight size={18} className="text-faint" aria-hidden />}
    </>
  );
  const cls = "flex h-13 w-full items-center gap-3 px-4 text-left";

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cls}>
        {content}
      </button>
    );
  }
  if (!href) return null;
  return external ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
      {content}
    </a>
  ) : (
    <Link href={href} className={cls}>
      {content}
    </Link>
  );
}
