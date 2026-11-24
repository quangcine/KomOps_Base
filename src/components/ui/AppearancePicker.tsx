"use client";

import { useEffect, useState } from "react";
import { SegmentedGroup } from "./SegmentedGroup";

type Theme = "light" | "dark";
export const THEME_STORAGE_KEY = "intercom.theme";

/** Sáng hoặc tối, nhớ trên máy. `AppShell` đọc lại giá trị này khi mở trang. */
export function AppearancePicker() {
  const [theme, setTheme] = useState<Theme>("light");
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  }, []);
  return (
    <div className="flex min-h-13 items-center gap-3 px-4 py-2">
      <span className="flex-1 text-body text-fg">Giao diện</span>
      <SegmentedGroup
        options={[
          { value: "light", label: "Sáng" },
          { value: "dark", label: "Tối" },
        ]}
        value={theme}
        onChange={(next: Theme) => {
          setTheme(next);
          document.documentElement.dataset.theme = next;
          try {
            window.localStorage.setItem(THEME_STORAGE_KEY, next);
          } catch {
            // Chế độ riêng tư: chỉ đổi cho lần mở này.
          }
        }}
        ariaLabel="Giao diện"
      />
    </div>
  );
}
