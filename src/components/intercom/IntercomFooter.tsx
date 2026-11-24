"use client";

// Footer pill 5 ô của mini app intercom: thứ tự Home, Dự án, Giao, Monitor, Tôi. Ô giữa Giao là nút tròn trắng
// 70px (62 cộng viền 4 hai bên), đáy nút trùng đáy pill nên chỉ nổi 70 - 56 = 14px trên mép pill; chữ "Giao" nằm
// TRONG hình tròn dưới icon máy ảnh.

import { useEffect, useState, type ComponentType, type MouseEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChartColumn, Camera, FolderOpen, House, User } from "lucide-react";
import { BOTTOM_TAB_HEIGHT } from "@/components/ui/BottomTabBar";
import { useChromeHidden } from "@/components/ui/useChromeHidden";
import { readStoredProjectId } from "./intercomView";

const CAPTURE_PATH = "/intercom";

/** Cỡ ngoài nút tròn Giao (62 cộng viền 4 mỗi bên); phần nổi trên mép pill = cỡ này trừ `BOTTOM_TAB_HEIGHT`. */
const CAPTURE_BUTTON_SIZE = 70;

type FooterItem = {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  isActive: (pathname: string) => boolean;
};

const isUnder = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);

// Home là trang gốc `/`; `/intercom/board` cùng component nên cũng sáng ô Home.
const LEFT_ITEMS: FooterItem[] = [
  { href: "/", label: "Home", icon: House, isActive: (p) => p === "/" || isUnder(p, "/intercom/board") },
  { href: "/intercom/projects", label: "Dự án", icon: FolderOpen, isActive: (p) => isUnder(p, "/intercom/projects") },
];
const RIGHT_ITEMS: FooterItem[] = [
  { href: "/intercom/monitor", label: "Monitor", icon: ChartColumn, isActive: (p) => isUnder(p, "/intercom/monitor") },
  { href: "/intercom/me", label: "Tôi", icon: User, isActive: (p) => isUnder(p, "/intercom/me") },
];

/** Đường màn Giao kèm dự án đang chọn (nhớ ở `localStorage` bởi Home và màn chụp). */
function buildCaptureHref(): string {
  const projectId = readStoredProjectId();
  return projectId ? `${CAPTURE_PATH}?project=${encodeURIComponent(projectId)}` : CAPTURE_PATH;
}

export function IntercomFooter() {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const hidden = useChromeHidden(pathname, { documentOnly: true });
  // `href` hiển thị cập nhật mỗi lần đổi trang; lúc bấm thì đọc lại kho máy để lấy đúng dự án vừa chọn ở Home.
  const [captureHref, setCaptureHref] = useState(CAPTURE_PATH);
  useEffect(() => {
    setCaptureHref(buildCaptureHref());
  }, [pathname]);

  const openCapture = (event: MouseEvent<HTMLAnchorElement>) => {
    // Giữ hành vi mở tab mới khi giữ phím bổ trợ.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    router.push(buildCaptureHref());
  };

  return (
    <nav
      aria-label="Điều hướng intercom"
      // Ẩn: trượt xuống quá mép đáy (cao pill cộng cách đáy 16 cộng 24 cho phần nút Giao nổi 14 và bóng), không nhận
      // chạm. Không gắn `aria-hidden` vì trong pill có liên kết nhận tiêu điểm (luật aria-hidden-focus): trình đọc màn
      // hình vẫn đọc được, Tab vào thì `focus-within` kéo pill hiện lại.
      className={`fixed inset-x-3 mx-auto max-w-[420px] bottom-4 z-40 flex rounded-full bg-brand-cta text-white shadow-sm transition-transform duration-200 ease-out motion-reduce:transition-none ${
        hidden
          ? "pointer-events-none translate-y-[calc(100%+16px+24px)] focus-within:pointer-events-auto focus-within:translate-y-0"
          : "translate-y-0"
      }`}
      style={{ height: BOTTOM_TAB_HEIGHT }}
      data-intercom-footer=""
    >
      {LEFT_ITEMS.map((item) => (
        <FooterTab key={item.href} item={item} pathname={pathname} />
      ))}
      <Link
        href={captureHref}
        onClick={openCapture}
        className="group relative flex min-w-0 flex-1 justify-center rounded-full"
        aria-label="Giao"
      >
        <span
          className="absolute bottom-0 flex flex-col items-center justify-center gap-0.5 rounded-full border-4 border-brand-cta bg-white text-brand-cta shadow-[0_6px_16px_rgba(0,0,0,0.35)] group-active:bg-surface-2"
          style={{ width: CAPTURE_BUTTON_SIZE, height: CAPTURE_BUTTON_SIZE }}
        >
          <Camera className="size-6" aria-hidden />
          <span className="text-xs font-bold leading-none">Giao</span>
        </span>
      </Link>
      {RIGHT_ITEMS.map((item) => (
        <FooterTab key={item.href} item={item} pathname={pathname} />
      ))}
    </nav>
  );
}

function FooterTab({ item, pathname }: { item: FooterItem; pathname: string }) {
  const active = item.isActive(pathname);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={`flex min-w-0 flex-1 rounded-full p-1 text-xs active:bg-white/15 ${
        active ? "font-bold" : "font-normal opacity-85"
      }`}
    >
      {/* Đệm `p-1` của ô là phần lùi 4px; viên nền chỉ tô khi ô đang chọn. */}
      <span
        className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full ${active ? "bg-white/20" : ""}`}
      >
        <Icon className="size-[22px]" aria-hidden />
        <span className="max-w-full truncate">{item.label}</span>
      </span>
    </Link>
  );
}
