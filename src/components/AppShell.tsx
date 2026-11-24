"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { SessionGate } from "@/adapters/SessionGate";
import { IntercomFooter } from "@/components/intercom/IntercomFooter";
import { THEME_STORAGE_KEY } from "@/components/ui/AppearancePicker";
import { WorkLogo } from "@/components/ui/WorkLogo";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
    } catch {
      // Không đọc được kho máy: giữ mặc định.
    }
  }, []);

  // Trang khách theo link: không qua cửa đăng nhập.
  if (pathname === "/ic" || pathname.startsWith("/ic/")) return <>{children}</>;
  // Màn chụp chiếm trọn khung, không có thanh đáy.
  if (pathname === "/intercom") return <SessionGate>{children}</SessionGate>;
  return (
    <SessionGate>
      <header data-intercom-header className="sticky top-0 z-30 flex h-12 items-center border-b border-border bg-bg px-3">
        <WorkLogo />
      </header>
      <main className="mx-auto w-full max-w-shell px-3 pb-28">{children}</main>
      <IntercomFooter />
    </SessionGate>
  );
}
