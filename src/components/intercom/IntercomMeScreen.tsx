"use client";

// Màn gọn: thẻ đầu, Thông tin, Cài đặt chụp, Giao diện, Tài khoản (Đăng xuất). Đăng xuất là global
// (thu hồi mọi phiên): bấm chỉ mở hộp xác nhận; xác nhận mới gọi `signOut` của `useWork()`.

import { useEffect, useState } from "react";
import { Camera, ImageDown, LogOut } from "lucide-react";
import { AppearancePicker } from "@/components/ui/AppearancePicker";
import { FunctionRow } from "@/components/ui/FunctionRow";
import { cn } from "@/lib/cn";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { useWork } from "@/adapters/SessionGate";
import { APP_IDENTITY } from "@/adapters/brand";
import { MyInfoCard } from "@/components/ui/MyInfoCard";
import { Button } from "@/components/ui/Control";
import { SegmentedGroup, type SegmentedOption } from "@/components/ui/SegmentedGroup";
import {
  DEFAULT_INTERCOM_CAPTURE_SETTINGS,
  readIntercomCaptureSettings,
  saveIntercomCaptureSettings,
  type IntercomCaptureSettings,
  type IntercomPhotoQuality,
} from "./intercomCaptureSettings";

const INTERCOM_IDENTITY = APP_IDENTITY;

const PHOTO_QUALITY_OPTIONS: readonly SegmentedOption<IntercomPhotoQuality>[] = [
  { value: "saver", label: "Tiết kiệm" },
  { value: "standard", label: "Tiêu chuẩn" },
  { value: "high", label: "Cao" },
];

const PHOTO_QUALITY_HINTS: Record<IntercomPhotoQuality, string> = {
  saver: "Ảnh tối đa 350 KB, cạnh dài 1280. Gửi nhanh khi mạng yếu.",
  standard: "Ảnh tối đa 500 KB, cạnh dài 1920.",
  high: "Ảnh tối đa 1 MB, cạnh dài 1920. Gửi chậm hơn.",
};

export function IntercomMeScreen() {
  const { perms, profile, signOut } = useWork();
  const name = profile?.full_name?.trim() || "Chưa có tên";
  const avatar = profile?.avatar_url ?? null;

  // `localStorage` không có lúc dựng ở máy chủ: dựng bằng mặc định, đọc giá trị trên máy sau khi gắn.
  const [settings, setSettings] = useState<IntercomCaptureSettings>(DEFAULT_INTERCOM_CAPTURE_SETTINGS);
  useEffect(() => {
    setSettings(readIntercomCaptureSettings());
  }, []);

  function updateSettings(patch: Partial<IntercomCaptureSettings>) {
    setSettings((current) => ({ ...current, ...patch }));
    saveIntercomCaptureSettings(patch);
  }

  const [signOutOpen, setSignOutOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  async function confirmSignOut() {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
      setSignOutOpen(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 py-3 md:p-3">
      {/* Thẻ đầu */}
      <Card className="flex items-center gap-3">
        {avatar ? (
          // Cỡ đi bằng thuộc tính thật của thẻ ảnh, tránh ảnh phình rồi co.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatar} alt="" width={56} height={56} className="size-14 shrink-0 rounded-full object-cover" />
        ) : (
          <span
            aria-hidden
            className="flex size-14 shrink-0 items-center justify-center rounded-full bg-surface-2 text-lg font-semibold text-muted"
          >
            {name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-fg">{name}</p>
          {perms.roleName && <p className="truncate text-sm text-muted">{perms.roleName}</p>}
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
            <span
              aria-hidden
              className="inline-block size-2 shrink-0 rounded-full"
              style={{ backgroundColor: INTERCOM_IDENTITY.accentColor }}
            />
            {INTERCOM_IDENTITY.fullName}
          </p>
        </div>
      </Card>

      <MyInfoCard />

      {/* Cài đặt chụp */}
      <Card padded={false}>
        <p className="px-4 pt-3 text-label font-medium text-muted">Cài đặt chụp</p>
        <div className="divide-y divide-border">
          <button
            type="button"
            role="switch"
            aria-checked={settings.stampLibraryByDefault}
            onClick={() => updateSettings({ stampLibraryByDefault: !settings.stampLibraryByDefault })}
            className="flex min-h-13 w-full items-center gap-3 px-4 py-2 text-left active:bg-surface-2"
          >
            <span className="text-muted">
              <Camera size={18} aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-body text-fg">Chèn dấu giờ, mã cho ảnh tải lên</span>
              <span className="block text-sm text-muted">
                {settings.stampLibraryByDefault
                  ? "Ảnh chọn từ máy mặc định có dấu như ảnh chụp."
                  : "Ảnh chọn từ máy mặc định giữ nguyên, không chèn dấu."}
              </span>
            </span>
            <span
              aria-hidden
              className={cn(
                "relative h-7 w-12 shrink-0 rounded-full transition-colors",
                settings.stampLibraryByDefault ? "bg-brand-cta" : "bg-surface-2 ring-1 ring-inset ring-border",
              )}
            >
              <span
                className={cn(
                  "absolute top-1 size-5 rounded-full bg-white shadow transition-[left]",
                  settings.stampLibraryByDefault ? "left-6" : "left-1",
                )}
              />
            </span>
          </button>
          <div className="flex flex-col gap-2 px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="text-muted">
                <ImageDown size={18} aria-hidden />
              </span>
              <span className="flex-1 text-body text-fg">Chất lượng ảnh gửi</span>
            </div>
            <SegmentedGroup
              options={PHOTO_QUALITY_OPTIONS}
              value={settings.photoQuality}
              onChange={(photoQuality) => updateSettings({ photoQuality })}
              ariaLabel="Chất lượng ảnh gửi"
              className="self-start"
            />
            <p className="text-sm text-muted">{PHOTO_QUALITY_HINTS[settings.photoQuality]}</p>
          </div>
        </div>
      </Card>

      {/* Giao diện (nhớ trên máy) */}
      <Card padded={false}>
        <div className="divide-y divide-border">
          <AppearancePicker />
        </div>
      </Card>

      {/* Tài khoản */}
      <Card padded={false}>
        <div className="divide-y divide-border">
          <FunctionRow
            onClick={() => setSignOutOpen(true)}
            icon={<LogOut size={18} aria-hidden />}
            label="Đăng xuất"
            tone="danger"
          />
        </div>
      </Card>

      <p className="py-3 text-center text-label text-faint">{INTERCOM_IDENTITY.fullName}</p>

      <Modal
        open={signOutOpen}
        onClose={() => {
          if (!signingOut) setSignOutOpen(false);
        }}
        title="Đăng xuất"
        width="narrow"
        footer={
          <>
            <Button variant="ghost" disabled={signingOut} onClick={() => setSignOutOpen(false)}>
              Huỷ
            </Button>
            <Button variant="danger" disabled={signingOut} onClick={() => void confirmSignOut()}>
              {signingOut ? "Đang đăng xuất..." : "Đăng xuất"}
            </Button>
          </>
        }
      >
        <p className="text-body text-fg">
          Đăng xuất sẽ thoát tài khoản này trên mọi máy đang đăng nhập.
        </p>
      </Modal>
    </div>
  );
}
